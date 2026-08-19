// Wrapper del backend de lenguaje: MiniMax servido en formato Anthropic.
//
// Por que HTTP y no un CLI: el sistema no depende de ninguna suscripcion ni de
// que haya un binario instalado. Habla contra <baseUrl>/messages con la cabecera
// `anthropic-version` — ese formato es el que expone MiniMax, no una eleccion
// nuestra. Cada llamada elige su tamano (plan/brief/compose al grande,
// digest/repair al chico) desde cfg.models y la api key vive en cfg.secrets.
//
// El endpoint NO expone uso de herramientas: el modelo no puede abrir archivos
// por su cuenta. Por eso los callers inlinean lo que necesita via `opts.files`
// (label -> contenido) y el wrapper lo mete en el prompt antes de enviarlo.
//
// Dos formas de hablarle:
//   runClaude(prompt, opts)        una pregunta, una respuesta.
//   runClaudeChat(mensajes, opts)  una conversacion: recibe el historial y lo
//                                  devuelve con la respuesta agregada, para que
//                                  el caller pueda seguir hablando (la reparacion
//                                  de composiciones itera asi: el modelo escribe,
//                                  ve el resultado del check, y ajusta).
//
// Los nombres `runClaude` / `runClaudeJSON` / `ClaudeError` son deuda heredada:
// el backend es MiniMax. Renombrarlos esta anotado en SPEC-reparacion.md.

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
 * @param {boolean} [opts.cacheFiles]      - marcar la seccion de archivos como prefijo
 *                                           cacheable (`cache_control`); ver conArchivos
 * @param {string} [opts.apiKey]           - override; default cfg.secrets.minimaxApiKey
 * @param {string} [opts.baseUrl]          - override; default cfg.minimax.baseUrl
 * @param {string} [opts.anthropicVersion] - override; default cfg.minimax.anthropicVersion
 * @param {number} [opts.maxTokens]        - override; default cfg.minimax.maxTokens
 * @param {number} [opts.retries]          - reintentos ante 429/5xx/red; default 2
 * @returns {Promise<{ text, costUsd, ms, model, sessionId, inputTokens, outputTokens, cacheReadTokens, stopReason, raw }>}
 */
export async function runClaude(prompt, opts = {}) {
  const contenido = conArchivos(prompt, opts.files, { cache: opts.cacheFiles });
  return enviarMensajes([{ role: "user", content: contenido }], opts);
}

/**
 * Una vuelta mas de una conversacion.
 *
 * `mensajes` es el historial completo (`[{ role, content }]`, el ultimo del
 * usuario) y la respuesta trae `mensajes` con el turno del asistente agregado,
 * listo para volver a mandar. El costo, los reintentos y el timeout son los
 * mismos de `runClaude`: la unica diferencia es que el modelo ve lo que dijo y
 * lo que le contestaron en las vueltas anteriores.
 *
 * El primer mensaje puede armarse con `conArchivos(prompt, files, { cache })`
 * para inlinear archivos igual que en `runClaude`.
 */
export async function runClaudeChat(mensajes, opts = {}) {
  if (!Array.isArray(mensajes) || mensajes.length === 0) {
    throw new ClaudeError("runClaudeChat necesita al menos un mensaje");
  }
  const res = await enviarMensajes(mensajes, opts);
  return { ...res, mensajes: [...mensajes, { role: "assistant", content: res.text }] };
}

async function enviarMensajes(mensajes, opts = {}) {
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

  const body = {
    model: String(opts.model),
    max_tokens: maxTokens,
    messages: mensajes.map((m) => ({ role: m.role, content: m.content })),
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
  let sinCache = false;
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
    // `cache_control` es una optimizacion, no un requisito. Si el endpoint no lo
    // entiende (un 400 que lo nombra), se manda lo mismo sin la marca: perder
    // el cache es barato; perder la llamada entera no. No cuenta como reintento.
    if (response.status === 400 && !sinCache && tieneCacheControl(body) && /cache_control/i.test(rawText ?? "")) {
      sinCache = true;
      body.messages = body.messages.map((m) => ({ role: m.role, content: sinCacheControl(m.content) }));
      attempt--;
      continue;
    }
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
// Armado del mensaje del usuario
// ---------------------------------------------------------------------------

/**
 * El contenido de un mensaje del usuario con archivos inlineados adelante,
 * claramente separados del prompt. Cada archivo aparece delimitado por
 * marcadores que no se confunden con HTML (clave en compose, donde el modelo
 * escribe HTML inline).
 *
 * Sin archivos devuelve el prompt tal cual. Con archivos devuelve un string, o
 * —con `cache`— dos bloques de contenido: la seccion de archivos marcada con
 * `cache_control` y el prompt aparte. Eso le dice al endpoint que el prefijo
 * (frame.md, la composicion de referencia, las escenas) se va a repetir; en una
 * conversacion de varias vueltas es lo que hace que la vuelta N no vuelva a
 * pagar precio de entrada por todo lo de la vuelta 1. Si el endpoint no lo
 * soporta, `runClaude` lo reintenta sin la marca (ver enviarMensajes).
 */
export function conArchivos(prompt, files, { cache = false } = {}) {
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

  const cabecera = [
    "You have been given the following files inline. Read them as if they were on disk; do not call any tools.",
    "",
    blocks,
    "",
    "---",
    "",
  ].join("\n");

  if (!cache) return cabecera + prompt;
  return [
    { type: "text", text: cabecera, cache_control: { type: "ephemeral" } },
    { type: "text", text: prompt },
  ];
}

function tieneCacheControl(body) {
  return body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b && b.cache_control));
}

function sinCacheControl(content) {
  if (!Array.isArray(content)) return content;
  // De vuelta a un string: es lo que el endpoint seguro entiende.
  return content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("");
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

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
