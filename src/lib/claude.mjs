// Wrapper del backend de lenguaje: MiniMax servido en formato Anthropic.
//
// Por que HTTP y no el CLI de Claude: el sistema ya no depende de la suscripcion
// de Claude Code; habla contra <baseUrl>/messages con la cabecera
// `anthropic-version`. Cada llamada elige su tamano (plan/brief/compose al grande,
// digest/repair al chico) desde cfg.models y la api key vive en cfg.secrets.
//
// El wrapper preserva las firmas publicas (`runClaude`, `runClaudeJSON`,
// `extractJSON`, `ClaudeError`) para no tocar mas que lo necesario arriba. La
// API Anthropic NO expone uso de herramientas como lo hacia `claude -p`: por eso
// los callers inlinear los archivos que el modelo necesita via `opts.files`
// (label -> contenido) y el wrapper los mete en el prompt antes de enviarlo.

import { loadConfig } from "./config.mjs";

export class ClaudeError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message);
    this.name = "ClaudeError";
    this.status = status ?? null;
    this.body = body ?? null;
    this.cause = cause ?? null;
  }
}

/**
 * Llama al backend y devuelve la respuesta del asistente.
 *
 * @param {string} prompt          - mensaje del usuario; si llega `opts.files`,
 *                                   el wrapper los antepone como seccion
 *                                   "<files>" antes del prompt.
 * @param {object} [opts]
 * @param {string} [opts.model]            - id del modelo (MiniMax-M3 por defecto)
 * @param {string} [opts.systemPrompt]     - system prompt (campo `system` del request)
 * @param {number} [opts.timeoutMs]        - timeout total; default cfg.minimax.timeoutMs
 * @param {object} [opts.files]            - { label: contenido } a inlinear como seccion
 * @param {string} [opts.apiKey]           - override; default cfg.secrets.minimaxApiKey
 * @param {string} [opts.baseUrl]          - override; default cfg.minimax.baseUrl
 * @param {string} [opts.anthropicVersion] - override; default cfg.minimax.anthropicVersion
 * @param {number} [opts.maxTokens]        - override; default cfg.minimax.maxTokens
 * @param {number} [opts.retries]          - reintentos ante 429/5xx/red; default 2
 * @returns {Promise<{ text, costUsd, ms, model, sessionId, inputTokens, outputTokens, cacheReadTokens, stopReason, raw }>}
 */
export async function runClaude(prompt, opts = {}) {
  const cfg = loadConfig();
  const minia = cfg.minimax ?? {};
  const apiKey = opts.apiKey ?? cfg.secrets?.minimaxApiKey ?? "";
  const baseUrl = (opts.baseUrl ?? minia.baseUrl ?? "").replace(/\/+$/, "");
  const version = opts.anthropicVersion ?? minia.anthropicVersion ?? "2023-06-01";
  const maxTokens = Number(opts.maxTokens ?? minia.maxTokens) > 0 ? Number(opts.maxTokens ?? minia.maxTokens) : 8192;
  const timeoutMs = Number(opts.timeoutMs ?? minia.timeoutMs) > 0 ? Number(opts.timeoutMs ?? minia.timeoutMs) : 900_000;

  if (!apiKey) {
    throw new ClaudeError(
      "falta la API key del modelo: cargala en el panel (npm run web -> Ajustes) o en .env como BCA_MINIMAX_API_KEY",
    );
  }
  if (!baseUrl) {
    throw new ClaudeError("falta cfg.minimax.baseUrl en brand-content-ai.config.json");
  }
  if (!opts.model) {
    throw new ClaudeError("falta opts.model: cada llamada elige su modelo desde cfg.models");
  }

  const finalPrompt = assemblePrompt(prompt, opts.files);
  const body = {
    model: String(opts.model),
    max_tokens: maxTokens,
    messages: [{ role: "user", content: finalPrompt }],
  };
  if (opts.systemPrompt) body.system = String(opts.systemPrompt);

  const started = Date.now();
  const url = `${baseUrl}/messages`;
  const retries = Number.isFinite(Number(opts.retries ?? minia.retries))
    ? Math.max(0, Number(opts.retries ?? minia.retries))
    : 2;

  // Un 429 o un 502 no son un error del prompt: son la API pidiendo que
  // esperes. Sin reintento, un compose de 3 llamadas en paralelo tira abajo la
  // pieza entera por un rate limit de 20 segundos y hay que volver a pagar todo
  // lo que ya habia salido bien.
  let response;
  let rawText;
  for (let attempt = 0; ; attempt++) {
    try {
      ({ response, rawText } = await postJson(url, body, { apiKey, version, timeoutMs }));
    } catch (err) {
      // Los cortes de red son transitorios; el timeout no (ya espero lo suyo).
      if (attempt >= retries || err?.timedOut) throw err;
      await sleep(retryDelayMs(attempt, null));
      continue;
    }
    if (response.ok) break;
    const retriable = response.status === 429 || response.status >= 500;
    if (!retriable || attempt >= retries) break;
    await sleep(retryDelayMs(attempt, response.headers.get("retry-after")));
  }

  if (!response.ok) {
    let detail = rawText;
    try {
      const j = JSON.parse(rawText);
      detail =
        j?.error?.message ??
        j?.message ??
        (Array.isArray(j?.errors) && j.errors[0]?.message) ??
        rawText;
    } catch {
      /* la dejo como texto crudo */
    }
    throw new ClaudeError(
      `minimax respondio ${response.status}: ${String(detail).slice(0, 500)}`,
      { status: response.status, body: rawText.slice(0, 4000) },
    );
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch (err) {
    throw new ClaudeError("minimax no devolvio JSON parseable", { body: rawText.slice(0, 800), cause: err });
  }

  const text = extractAssistantText(payload);
  const inputTokens = Number(payload?.usage?.input_tokens ?? payload?.usage?.inputTokens ?? 0) || 0;
  const outputTokens = Number(payload?.usage?.output_tokens ?? payload?.usage?.outputTokens ?? 0) || 0;
  // MiniMax reporta los tokens servidos desde cache APARTE de input_tokens y los
  // cobra mas barato: sin contarlos, el costo de un compose largo queda corto.
  const cacheReadTokens =
    Number(payload?.usage?.cache_read_input_tokens ?? payload?.usage?.cacheReadInputTokens ?? 0) || 0;
  const model = payload?.model ?? opts.model ?? null;
  const sessionId = payload?.id ?? null;
  const stopReason = payload?.stop_reason ?? payload?.stopReason ?? null;

  if (stopReason === "max_tokens") {
    // No es un fallo duro, pero el modelo se quedo corto: lo dejo registrado
    // para que el caller decida. La salida parcial sigue siendo usable en la
    // mayoria de los casos (parseo de JSON falla mas a menudo que la accion).
  }

  return {
    text,
    costUsd: computeCostUsd({ model, inputTokens, outputTokens, cacheReadTokens, pricing: minia.pricing }),
    ms: Date.now() - started,
    model,
    sessionId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    stopReason,
    raw: payload,
  };
}

/**
 * Igual que `runClaude` pero exige JSON de vuelta y lo valida. Reintenta una
 * vez si la primera respuesta no parsea.
 */
export async function runClaudeJSON(prompt, opts = {}) {
  const instruction =
    "\n\nResponde UNICAMENTE con JSON valido, sin prosa, sin bloques de codigo. " +
    "Tu respuesta completa debe arrancar con { o [ y terminar con } o ].";

  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await runClaude(prompt + instruction, opts);
    const parsed = extractJSON(res.text);
    if (parsed !== undefined) return { ...res, data: parsed };
    last = res;
    prompt =
      prompt +
      "\n\n(El intento anterior no devolvio JSON valido. Responde SOLO el JSON, nada mas.)";
  }
  // Un JSON cortado a la mitad no es "el modelo no entendio": es que no le
  // alcanzo el techo de salida. Sin decirlo, se busca el problema en el prompt.
  const cut = last?.stopReason === "max_tokens";
  throw new ClaudeError(
    cut
      ? "minimax corto la respuesta en max_tokens y el JSON quedo incompleto " +
        "(subi minimax.maxTokens en brand-content-ai.config.json)"
      : "minimax no devolvio JSON valido tras 2 intentos",
    { body: last?.text?.slice(0, 800) },
  );
}

/** Tolera que el modelo envuelva el JSON en prosa o en un bloque de codigo. */
export function extractJSON(text) {
  if (!text) return undefined;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* sigue */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* sigue */
    }
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ]) {
    const start = trimmed.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = !inStr;
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/**
 * Inyecta los archivos como una seccion visible al modelo, claramente separada
 * del prompt. Cada archivo aparece delimitado por marcadores que no se confunden
 * con HTML (clave en compose, donde el modelo escribe HTML inline).
 */
function assemblePrompt(prompt, files) {
  const entries = files && typeof files === "object" ? Object.entries(files) : [];
  if (entries.length === 0) return prompt;

  const blocks = entries
    .map(([label, content]) => {
      const safe = String(label).replace(/[\r\n]+/g, " ");
      const body = String(content ?? "");
      return [
        "<<<BCA_FILE path=" + JSON.stringify(safe) + ">>>",
        body,
        "<<<BCA_END_FILE>>>",
      ].join("\n");
    })
    .join("\n\n");

  return [
    "You have been given the following files inline. Read them as if they were on disk; do not call any tools.",
    "",
    blocks,
    "",
    "---",
    "",
    prompt,
  ].join("\n");
}

function extractAssistantText(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block.text === "string") parts.push(block.text);
    else if (typeof block === "string") parts.push(block);
  }
  return parts.join("").trim();
}

/**
 * Coste estimado en USD a partir de los precios configurados en
 * `cfg.minimax.pricing[<model>] = { input, output }` (USD por 1K tokens).
 * Si el modelo no tiene precio, devuelve `null` para que el caller distinga
 * "no se gasto" de "no se pudo medir".
 */
function computeCostUsd({ model, inputTokens, outputTokens, cacheReadTokens = 0, pricing }) {
  if (!model || !pricing || typeof pricing !== "object") return null;
  const tier = pricing[model];
  if (!tier || typeof tier !== "object") return null;
  const inP = Number(tier.input);
  const outP = Number(tier.output);
  if (!Number.isFinite(inP) || !Number.isFinite(outP)) return null;
  // Sin precio de cache declarado, los tokens cacheados se cobran como entrada:
  // preferible pasarse de caro a mentir que salieron gratis.
  const cacheP = Number.isFinite(Number(tier.cacheRead)) ? Number(tier.cacheRead) : inP;
  const usd =
    (inputTokens / 1000) * inP + (outputTokens / 1000) * outP + (cacheReadTokens / 1000) * cacheP;
  return Math.round(usd * 1e6) / 1e6;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera antes de reintentar: 1s, 2s, 4s... salvo que el server diga cuanto
 * (`retry-after`, en segundos), que es un dato y no una estimacion.
 */
function retryDelayMs(attempt, retryAfterHeader) {
  const secs = Number(retryAfterHeader);
  if (Number.isFinite(secs) && secs > 0) return Math.min(60_000, secs * 1000);
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/**
 * POST JSON con timeout real (AbortController). Devuelve el response y el cuerpo
 * crudo: dejamos que el caller decida si el status es bueno o no.
 */
async function postJson(url, body, { apiKey, version, timeoutMs }) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort(new ClaudeError(`timeout tras ${timeoutMs}ms`));
  }, timeoutMs);

  let response;
  let rawText;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "anthropic-version": version,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    rawText = await response.text();
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof ClaudeError) throw err;
    // "fetch failed" a secas no dice nada: el caso tipico es un baseUrl mal
    // escrito (el host de MiniMax es minimax.io / minimaxi.com, no minimax.com)
    // y sin la URL en el mensaje no hay forma de verlo desde el panel.
    const code = err?.cause?.code ?? err?.code ?? null;
    const dns = code === "ENOTFOUND" || code === "EAI_AGAIN";
    if (timedOut) {
      const e = new ClaudeError(`timeout tras ${timeoutMs}ms llamando a ${url}`, { cause: err });
      e.timedOut = true; // el caller no lo reintenta: ya espero lo suyo
      throw e;
    }
    throw new ClaudeError(
      `no se pudo llamar a ${url}: ${err?.message ?? err}${code ? ` (${code})` : ""}` +
        (dns
          ? " — ese host no existe. cfg.minimax.baseUrl deberia ser " +
            "https://api.minimax.io/anthropic/v1 (key global) o " +
            "https://api.minimaxi.com/anthropic/v1 (key de China continental)."
          : ""),
      { cause: err },
    );
  }
  clearTimeout(timer);
  return { response, rawText };
}