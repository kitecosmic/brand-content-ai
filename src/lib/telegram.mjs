// Canal de salida y control remoto: Telegram.
//
// Long polling (`getUpdates`), nunca webhook: esto corre en una PC de escritorio
// detras de NAT, sin IP publica ni puertos abiertos que exponer.
//
// Seguridad: el bot SOLO obedece a `cfg.secrets.telegramChatId`. Cualquier update
// de otro chat se descarta en silencio -- ni siquiera un "no autorizado", porque
// esa respuesta ya confirma que el bot existe y esta vivo. Este bot dispara
// generaciones que cuestan dinero: un desconocido no lo maneja.
//
// Cero dependencias: `fetch`, `FormData` y `Blob` globales (Node >= 22.5).

import {
  existsSync,
  openAsBlob,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, extname, join, resolve as resolvePath } from "node:path";

// ---------------------------------------------------------------------------
// Limites de la Bot API (los de verdad, no los que uno supone)
// ---------------------------------------------------------------------------

/** Maximo de caracteres de un mensaje de texto. Mas que esto: partir. */
export const TG_MAX_TEXT = 4096;
/** Maximo de caracteres de un caption de foto/video/documento. */
export const TG_MAX_CAPTION = 1024;
/** Maximo de bytes subibles como foto. */
export const TG_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** Maximo de bytes subibles como video/documento. */
export const TG_MAX_FILE_BYTES = 50 * 1024 * 1024;

const API_BASE = "https://api.telegram.org";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export class TelegramError extends Error {
  constructor(message, { status, code, retryAfter, method } = {}) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.method = method;
  }
}

// ---------------------------------------------------------------------------
// Parseo y formato: funciones puras, sin red. Todo lo testeable vive aca.
// ---------------------------------------------------------------------------

/**
 * Parte un texto en trozos que Telegram acepta (<= 4096).
 * Corta por salto de linea si puede, si no por espacio, y solo en ultima
 * instancia a lo bruto (cuidando no partir un par surrogate al medio).
 *
 * @param {string} text
 * @param {number} [max=TG_MAX_TEXT]
 * @returns {string[]} nunca devuelve trozos vacios
 */
export function splitMessage(text, max = TG_MAX_TEXT) {
  const s = typeof text === "string" ? text : String(text ?? "");
  const limit = Math.max(1, Math.floor(max));
  if (!s) return [];
  if (s.length <= limit) return [s];

  const chunks = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = -1;
    let skip = 0;

    const nl = rest.lastIndexOf("\n", limit);
    if (nl > 0) {
      cut = nl;
      skip = 1;
    } else {
      const sp = rest.lastIndexOf(" ", limit);
      if (sp > 0) {
        cut = sp;
        skip = 1;
      }
    }
    if (cut <= 0) {
      cut = limit;
      skip = 0;
      const prev = rest.charCodeAt(cut - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1; // no partir un surrogate
    }

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

/** Recorta a `max` sin romper la ultima palabra. */
export function truncate(text, max = TG_MAX_CAPTION) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max - 1));
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/**
 * Parseo lexico de un comando. No sabe nada de negocio.
 *
 * @param {string} text
 * @returns {{cmd:string, bot:string|null, args:string[], rest:string, raw:string}|null}
 *   `null` si el texto no es un comando.
 */
export function parseCommand(text) {
  if (typeof text !== "string") return null;
  const raw = text.trim();
  if (!raw.startsWith("/")) return null;
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:[ \t\r\n]+([\s\S]*))?$/.exec(raw);
  if (!m) return null;
  const rest = (m[3] ?? "").trim();
  return {
    cmd: m[1].toLowerCase(),
    bot: m[2] ? m[2].toLowerCase() : null,
    args: rest ? rest.split(/\s+/) : [],
    rest,
    raw,
  };
}

/** Alias de comando -> accion canonica (que es la clave del handler). */
export const COMMAND_ALIASES = {
  hoy: "today",
  today: "today",
  pendientes: "pending",
  pending: "pending",
  plan: "plan",
  planificar: "plan",
  generar: "generate",
  generate: "generate",
  gen: "generate",
  ok: "approve",
  si: "approve",
  aprobar: "approve",
  approve: "approve",
  no: "reject",
  rechazar: "reject",
  reject: "reject",
  costos: "costs",
  costs: "costs",
  gasto: "costs",
  ayuda: "help",
  help: "help",
  start: "help",
};

const USAGE = {
  plan: "/plan [dias] - dias es un entero entre 1 y 90",
  generate: "/generar <id>",
  approve: "/ok <id>",
  reject: "/no <id> <motivo> - el motivo es obligatorio: es lo que guia la regeneracion",
  costs: "/costos [dias] - dias es un entero entre 1 y 365",
};

/** Los ids son slugs (`2026-08-20-agent-builds-schema`); nada raro entra. */
export function isValidItemId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(id);
}

function intArg(raw, min, max) {
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/**
 * Traduce un texto a la intencion de negocio. Pura: no toca red ni store.
 *
 * Formas de retorno:
 *   { action: 'none' }                              no es un comando
 *   { action: 'unknown', command }                  comando desconocido
 *   { action: 'invalid', command, usage, message }  comando conocido, mal usado
 *   { action: 'today'|'pending'|'help', command }
 *   { action: 'plan',     command, days: number|null }
 *   { action: 'costs',    command, days: number|null }
 *   { action: 'generate', command, id }
 *   { action: 'approve',  command, id }
 *   { action: 'reject',   command, id, reason }
 */
export function parseIntent(text) {
  const parsed = parseCommand(text);
  if (!parsed) return { action: "none" };

  const { cmd, args, rest } = parsed;
  const action = COMMAND_ALIASES[cmd];
  if (!action) return { action: "unknown", command: cmd };

  const bad = (key, message) => ({
    action: "invalid",
    command: cmd,
    intended: key,
    usage: USAGE[key],
    message: `${message}\nuso: ${USAGE[key]}`,
  });

  switch (action) {
    case "today":
    case "pending":
    case "help":
      return { action, command: cmd };

    case "plan": {
      if (!args.length) return { action, command: cmd, days: null };
      const days = intArg(args[0], 1, 90);
      if (days === null) return bad("plan", `"${args[0]}" no es una cantidad de dias valida.`);
      return { action, command: cmd, days };
    }

    case "costs": {
      if (!args.length) return { action, command: cmd, days: null };
      const days = intArg(args[0], 1, 365);
      if (days === null) return bad("costs", `"${args[0]}" no es una cantidad de dias valida.`);
      return { action, command: cmd, days };
    }

    case "generate":
    case "approve": {
      const key = action === "generate" ? "generate" : "approve";
      const id = args[0];
      if (!id) return bad(key, "falta el id del item.");
      if (!isValidItemId(id)) return bad(key, `"${id}" no parece un id de item.`);
      return { action, command: cmd, id };
    }

    case "reject": {
      const id = args[0];
      if (!id) return bad("reject", "falta el id del item.");
      if (!isValidItemId(id)) return bad("reject", `"${id}" no parece un id de item.`);
      // El motivo es el resto crudo: puede tener espacios, comas y saltos de linea.
      const reason = rest.slice(id.length).trim();
      if (!reason) return bad("reject", "falta el motivo del rechazo.");
      return { action, command: cmd, id, reason };
    }

    default:
      return { action: "unknown", command: cmd };
  }
}

/**
 * Unico control de acceso del bot. Falla cerrado: sin chat configurado,
 * nadie esta autorizado.
 */
export function isAuthorizedChat(cfg, chatId) {
  const allowed = String(cfg?.secrets?.telegramChatId ?? "").trim();
  if (!allowed) return false;
  const got = String(chatId ?? "").trim();
  return got !== "" && got === allowed;
}

/**
 * Extrae lo util de un update. Solo texto/caption; el resto se ignora
 * (los `allowed_updates` del polling ya filtran, esto es el cinturon).
 */
export function extractMessage(update) {
  const msg = update?.message ?? update?.edited_message ?? null;
  if (!msg) return null;
  const chatId = msg?.chat?.id;
  if (chatId === undefined || chatId === null) return null;
  return {
    chatId: String(chatId),
    text: typeof msg.text === "string" ? msg.text : (msg.caption ?? ""),
    messageId: msg.message_id ?? null,
    from: msg.from ?? null,
    message: msg,
  };
}

export function helpText() {
  return [
    "Brand Content AI - comandos",
    "",
    "/hoy                que hay para hoy",
    "/pendientes         items sin entregar",
    "/plan [dias]        replanifica el calendario",
    "/generar <id>       fuerza la generacion de un item",
    "/ok <id>            aprueba",
    "/no <id> <motivo>   rechaza y regenera con ese motivo",
    "/costos [dias]      resumen de gasto",
    "/ayuda              esto",
  ].join("\n");
}

/** Una linea por item, para /hoy y /pendientes. */
export function formatItemLine(item) {
  const rev = item?.revision ? ` rev${item.revision}` : "";
  return (
    `${item?.scheduled_for ?? "?"} [${item?.status ?? "?"}${rev}] ` +
    `${item?.format ?? "?"} ${item?.id ?? "?"}\n  ${truncate(item?.angle ?? "", 120)}`
  );
}

/** Caption de entrega: identifica el item y recuerda como responder. */
export function itemCaption(item) {
  const head = [
    `${item.id}`,
    `${item.format} | ${item.language ?? "en"} | ${item.scheduled_for}` +
      (item.revision ? ` | rev ${item.revision}` : ""),
    item.angle ? `\n${item.angle}` : "",
    item.message ? `${item.message}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const footer = `\n\n/ok ${item.id}\n/no ${item.id} <motivo>`;
  return truncate(head, Math.max(1, TG_MAX_CAPTION - footer.length)) + footer;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Capa HTTP
// ---------------------------------------------------------------------------

function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function apiUrl(cfg, method) {
  const token = String(cfg?.secrets?.telegramToken ?? "").trim();
  if (!token) throw new Error("falta TELEGRAM_BOT_TOKEN en .env");
  return `${API_BASE}/bot${token}/${method}`;
}

function resolveChatId(cfg, chatId) {
  const id = String(chatId ?? cfg?.secrets?.telegramChatId ?? "").trim();
  if (!id) throw new Error("falta TELEGRAM_CHAT_ID en .env (ni se paso chatId)");
  return id;
}

function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function isRetryable(err) {
  if (err instanceof TelegramError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  // fetch falla con TypeError ante errores de red; un AbortError aca solo puede
  // venir del timeout propio, porque el abort del usuario ya salio antes.
  return true;
}

function retryDelay(err, attempt) {
  if (err?.retryAfter) return Math.min(60_000, Number(err.retryAfter) * 1000 + 250);
  return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/**
 * Llama a la Bot API. `payload` puede ser un objeto (JSON) o un FormData.
 * Devuelve `result` ya desempaquetado; si Telegram dice `ok:false`, lanza.
 */
async function tg(cfg, method, payload, opts = {}) {
  const {
    signal = null,
    timeoutMs = 30_000,
    retries = 2,
    fetchImpl = globalThis.fetch,
  } = opts;
  const url = apiUrl(cfg, method);

  for (let attempt = 0; ; attempt++) {
    try {
      const init = { method: "POST", signal: withTimeout(signal, timeoutMs) };
      if (payload instanceof FormData) {
        init.body = payload;
      } else {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(payload ?? {});
      }
      const res = await fetchImpl(url, init);
      const raw = await res.text();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* respuesta no-JSON: cae al chequeo de abajo */
      }
      if (!body || typeof body !== "object") {
        throw new TelegramError(`respuesta no-JSON de Telegram (HTTP ${res.status})`, {
          status: res.status,
          method,
        });
      }
      if (!body.ok) {
        throw new TelegramError(body.description || `HTTP ${res.status}`, {
          status: res.status ?? body.error_code,
          code: body.error_code,
          retryAfter: body.parameters?.retry_after,
          method,
        });
      }
      return body.result;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt >= retries || !isRetryable(err)) throw err;
      await sleep(retryDelay(err, attempt), signal);
    }
  }
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/**
 * Manda texto. Si pasa de 4096 lo parte en varios mensajes.
 * Devuelve el ultimo `Message` (o `null` si no habia nada que mandar).
 */
export async function sendMessage(cfg, text, opts = {}) {
  const { chatId, replyMarkup, parseMode, disablePreview = true, ...rest } = opts;
  const chat_id = resolveChatId(cfg, chatId);
  const chunks = splitMessage(text).filter((c) => c.trim() !== "");
  let last = null;
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      chat_id,
      text: chunks[i],
      link_preview_options: { is_disabled: !!disablePreview },
    };
    if (parseMode) payload.parse_mode = parseMode;
    // El teclado va solo en el ultimo trozo: si no, se pisan entre si.
    if (replyMarkup && i === chunks.length - 1) payload.reply_markup = replyMarkup;
    last = await tg(cfg, "sendMessage", payload, rest);
  }
  return last;
}

/**
 * Sube un archivo. Si supera el limite de la Bot API no falla: manda la ruta
 * como texto, que sigue siendo informacion util, y continua.
 */
async function sendFile(cfg, { method, field, filePath, caption, maxBytes, extra, oversize, opts }) {
  const { chatId, ...rest } = opts ?? {};
  const chat_id = resolveChatId(cfg, chatId);
  const abs = resolvePath(String(filePath ?? ""));
  if (!filePath || !existsSync(abs)) {
    throw new Error(`archivo no encontrado: ${abs}`);
  }
  const size = statSync(abs).size;

  if (size > maxBytes) {
    if (oversize) return oversize({ abs, size });
    const note =
      `${caption ? `${caption}\n\n` : ""}` +
      `no lo puedo subir: ${formatBytes(size)} supera el limite de Telegram ` +
      `(${formatBytes(maxBytes)}).\nesta en disco: ${abs}`;
    return sendMessage(cfg, note, { chatId: chat_id, ...rest });
  }

  const type = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  const blob = await openAsBlob(abs, { type });
  const form = new FormData();
  form.append("chat_id", chat_id);
  if (caption) form.append("caption", truncate(caption, TG_MAX_CAPTION));
  for (const [k, v] of Object.entries(extra ?? {})) form.append(k, String(v));
  form.append(field, blob, basename(abs));

  // Subir es lento: mas timeout y menos reintentos (reintentar es re-subir todo).
  return tg(cfg, method, form, { timeoutMs: 180_000, retries: 1, ...rest });
}

/** Foto. Si pesa mas de 10 MB la manda como documento. */
export async function sendPhoto(cfg, filePath, opts = {}) {
  const { caption, ...rest } = opts;
  return sendFile(cfg, {
    method: "sendPhoto",
    field: "photo",
    filePath,
    caption,
    maxBytes: TG_MAX_PHOTO_BYTES,
    opts: rest,
    oversize: () => sendDocument(cfg, filePath, opts),
  });
}

/** Video. Si pasa de 50 MB manda la ruta como texto en vez de fallar. */
export async function sendVideo(cfg, filePath, opts = {}) {
  const { caption, ...rest } = opts;
  return sendFile(cfg, {
    method: "sendVideo",
    field: "video",
    filePath,
    caption,
    maxBytes: TG_MAX_FILE_BYTES,
    extra: { supports_streaming: true },
    opts: rest,
  });
}

export async function sendDocument(cfg, filePath, opts = {}) {
  const { caption, ...rest } = opts;
  return sendFile(cfg, {
    method: "sendDocument",
    field: "document",
    filePath,
    caption,
    maxBytes: TG_MAX_FILE_BYTES,
    opts: rest,
  });
}

function imagesIn(dir) {
  return readdirSync(dir)
    .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((f) => join(dir, f));
}

/**
 * Entrega el item al chat segun su formato y lo pasa a `delivered`.
 * No decide nada de negocio: solo elige el metodo de envio por formato.
 */
/**
 * Que clase de entregable es. Sale de la config del formato; si no esta (una
 * pieza vieja, o un formato que ya no existe), lo dice el archivo en disco.
 */
function kindDe(cfg, format, asset) {
  const spec = cfg?.formats?.[format];
  if (spec?.kind) return spec.kind;
  const porNombre = { text: "text", image: "still", carousel: "slides", video: "motion" }[format];
  if (porNombre) return porNombre;
  if (asset && existsSync(asset) && statSync(asset).isDirectory()) return "slides";
  if (asset && /\.mp4$/i.test(asset)) return "motion";
  if (asset && /\.(md|txt)$/i.test(asset)) return "text";
  return "still";
}

export async function deliverItem(cfg, store, itemId, opts = {}) {
  const item = store.getItem(itemId);
  if (!item) throw new Error(`item no encontrado: ${itemId}`);

  const caption = itemCaption(item);
  const asset = item.asset_path ? resolvePath(item.asset_path) : null;
  const preview = item.preview_path ? resolvePath(item.preview_path) : null;
  const format = String(item.format ?? "").toLowerCase();
  const has = (p) => !!p && existsSync(p);

  // La entrega mira que ES la pieza, no como se llama el formato: una historia
  // se manda como foto y un reel como video, sin que Telegram sepa de formatos.
  const kind = kindDe(cfg, format, asset);
  if (kind === "text") {
    const body = has(asset)
      ? readFileSync(asset, "utf8").trim()
      : String(item.message ?? "").trim();
    if (!body) throw new Error(`el item ${itemId} no tiene texto para entregar`);
    await sendMessage(cfg, `${caption}\n\n${body}`, opts);
  } else if (kind === "motion") {
    if (has(asset)) {
      await sendVideo(cfg, asset, { caption, ...opts });
    } else if (has(preview)) {
      await sendPhoto(cfg, preview, { caption: `${caption}\n\n(sin video: solo preview)`, ...opts });
    } else {
      throw new Error(`el item ${itemId} no tiene asset_path ni preview_path`);
    }
  } else if (kind === "slides") {
    // El asset de un carrusel suele ser una carpeta de slides.
    let slides = [];
    if (has(asset) && statSync(asset).isDirectory()) slides = imagesIn(asset);
    else if (has(asset)) slides = [asset];
    else if (has(preview)) slides = [preview];
    if (!slides.length) throw new Error(`el item ${itemId} no tiene slides que entregar`);
    for (let i = 0; i < Math.min(slides.length, 10); i++) {
      await sendPhoto(cfg, slides[i], { caption: i === 0 ? caption : undefined, ...opts });
    }
  } else {
    const file = has(preview) ? preview : asset;
    if (!has(file)) throw new Error(`el item ${itemId} no tiene asset_path ni preview_path`);
    await sendPhoto(cfg, file, { caption, ...opts });
  }

  store.setStatus(itemId, "delivered");
}

// ---------------------------------------------------------------------------
// Bot: long polling + ruteo
// ---------------------------------------------------------------------------

/** Acciones que tardan (minutos). Se acusa recibo y se sigue atendiendo. */
const SLOW_ACTIONS = new Set(["plan", "generate", "reject"]);

function ackFor(intent) {
  switch (intent.action) {
    case "plan":
      return `planificando${intent.days ? ` ${intent.days} dias` : ""}... te aviso cuando termine.`;
    case "generate":
      return `generando ${intent.id}... esto puede tardar varios minutos.`;
    case "reject":
      return `anotado. regenerando ${intent.id} con tu feedback...`;
    default:
      return "trabajando...";
  }
}

/** Argumentos con los que se invoca cada handler. */
function handlerParams(intent) {
  switch (intent.action) {
    case "plan":
    case "costs":
      return { days: intent.days };
    case "generate":
    case "approve":
      return { id: intent.id };
    case "reject":
      return { id: intent.id, reason: intent.reason };
    default:
      return {};
  }
}

/**
 * Bot de control remoto. Corre hasta que se aborte `signal`.
 *
 * ## Handlers que espera (los inyecta la CLI)
 *
 * Cada handler es `async (params, ctx) => string | void`. Si devuelve un string
 * no vacio, el bot lo manda al chat (partido en trozos de 4096 si hace falta).
 * Si devuelve `undefined`, se asume que ya respondio el mismo con `ctx.reply`.
 * Si lanza, el bot manda `error en /<comando>: <mensaje>` y sigue vivo.
 *
 *   handlers.today    ({},             ctx)   <- /hoy
 *   handlers.pending  ({},             ctx)   <- /pendientes
 *   handlers.plan     ({ days },       ctx)   <- /plan [dias]     days: number|null
 *   handlers.generate ({ id },         ctx)   <- /generar <id>    id: string
 *   handlers.approve  ({ id },         ctx)   <- /ok <id>         id: string
 *   handlers.reject   ({ id, reason }, ctx)   <- /no <id> <motivo>
 *   handlers.costs    ({ days },       ctx)   <- /costos [dias]   days: number|null
 *   handlers.help     ({},             ctx)   <- /ayuda  (opcional: si falta, responde helpText())
 *
 * Un handler ausente no rompe nada: el bot avisa que ese comando no esta conectado.
 *
 * `ctx` que recibe cada handler:
 *   { cfg, store, chatId, command, text, message, signal, log,
 *     reply(text, opts?), sendPhoto(path, opts?), sendVideo(path, opts?),
 *     sendDocument(path, opts?), deliver(itemId) }
 *
 * `ctx.signal` es el mismo AbortSignal de `runBot`: un handler largo deberia
 * mirarlo para cortar cuando el proceso se apaga.
 *
 * ## Garantias
 *
 * - Solo procesa updates de `cfg.secrets.telegramChatId`; el resto se descarta
 *   sin responder nada.
 * - El offset se persiste con `store.set('tg:offset', n)` despues de despachar
 *   cada update: reiniciar no reprocesa (no se paga dos veces la misma
 *   generacion) ni pierde lo que llego mientras el bot estaba caido.
 * - Un `fetch` fallido no mata el bot: backoff exponencial, y si Telegram
 *   responde 429 se respeta su `retry_after`.
 * - Los handlers corren fuera del ciclo de polling: generar un video no bloquea
 *   la atencion de los demas comandos.
 *
 * @param {object} cfg
 * @param {object} store
 * @param {object} handlers
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.log]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.pollTimeout=25]  segundos de espera del long polling
 * @param {number} [opts.drainMs=15000]   cuanto espera a los handlers en curso al abortar
 * @param {typeof fetch} [opts.fetchImpl] inyectable para tests
 */
export async function runBot(cfg, store, handlers = {}, opts = {}) {
  const {
    log = null,
    signal = null,
    pollTimeout = 25,
    drainMs = 15_000,
    fetchImpl = globalThis.fetch,
  } = opts;

  // Falla cerrado y temprano: sin chat autorizado el bot no arranca.
  const owner = String(cfg?.secrets?.telegramChatId ?? "").trim();
  if (!owner) {
    throw new Error("falta TELEGRAM_CHAT_ID: el bot no arranca sin un chat autorizado");
  }
  apiUrl(cfg, "getMe"); // valida que haya token antes de entrar al ciclo

  const pollIntervalMs = Number(cfg?.telegram?.pollIntervalMs ?? 2000) || 0;
  // clave `accion:id` -> promesa. Evita que un doble tap pague dos generaciones.
  const inflight = new Map();

  const reply = (text, o = {}) => sendMessage(cfg, text, { chatId: owner, fetchImpl, ...o });
  const quiet = (p) =>
    p.catch((err) => log?.(`telegram: no pude responder: ${err?.message ?? err}`));

  let fails = 0;
  let offset = await initialOffset();

  while (!signal?.aborted) {
    let updates;
    try {
      updates = await tg(
        cfg,
        "getUpdates",
        { offset, timeout: pollTimeout, allowed_updates: ["message"] },
        {
          signal,
          timeoutMs: (pollTimeout + 15) * 1000,
          retries: 0, // el backoff lo maneja este ciclo
          fetchImpl,
        },
      );
      if (!Array.isArray(updates)) updates = []; // paranoia: nada rompe el ciclo
      fails = 0;
    } catch (err) {
      if (signal?.aborted) break;
      fails += 1;
      const wait = err?.retryAfter ? Number(err.retryAfter) * 1000 : backoff(fails);
      log?.(
        `telegram: getUpdates fallo (${err?.message ?? err}); reintento en ${Math.round(wait / 1000)}s`,
      );
      await sleep(wait, signal);
      continue;
    }

    for (const update of updates) {
      if (signal?.aborted) break; // sin avanzar offset: ese update se reprocesa
      try {
        dispatch(update);
      } catch (err) {
        log?.(`telegram: error despachando update: ${err?.message ?? err}`);
      }
      offset = Number(update?.update_id ?? 0) + 1;
      store.set("tg:offset", offset);
    }

    if (!updates.length) await sleep(pollIntervalMs, signal);
  }

  // Corte limpio: dejamos de escuchar y damos margen a lo que quedo corriendo.
  if (inflight.size) {
    log?.(`telegram: esperando ${inflight.size} tarea(s) en curso...`);
    await Promise.race([Promise.allSettled([...inflight.values()]), sleep(drainMs)]);
  }
  log?.("telegram: bot detenido");

  // -- internos -------------------------------------------------------------

  function backoff(n) {
    return Math.min(60_000, 1000 * 2 ** (n - 1)) + Math.floor(Math.random() * 500);
  }

  async function initialOffset() {
    const stored = store.get("tg:offset", null);
    if (stored !== null && stored !== undefined && String(stored) !== "") {
      return Number(stored) || 0;
    }
    // Primer arranque: descartamos el backlog. Un /generar de ayer no se
    // ejecuta hoy solo porque el bot recien se enciende.
    try {
      const last = await tg(
        cfg,
        "getUpdates",
        { offset: -1, timeout: 0 },
        { signal, retries: 1, fetchImpl },
      );
      const n = last?.length ? Number(last[last.length - 1].update_id) + 1 : 0;
      if (n) {
        store.set("tg:offset", n);
        log?.(`telegram: primer arranque, descarto el backlog (offset ${n})`);
      }
      return n;
    } catch (err) {
      log?.(`telegram: no pude leer el offset inicial (${err?.message ?? err})`);
      return 0;
    }
  }

  function dispatch(update) {
    const msg = extractMessage(update);
    if (!msg) return;
    if (!isAuthorizedChat(cfg, msg.chatId)) {
      // Silencio absoluto hacia afuera. Solo queda en la bitacora local.
      log?.(`telegram: update ignorado, chat no autorizado (${msg.chatId})`);
      return;
    }

    const intent = parseIntent(msg.text);
    if (intent.action === "none") return;
    if (intent.action === "unknown") {
      quiet(reply(`no conozco /${intent.command}.\n\n${helpText()}`));
      return;
    }
    if (intent.action === "invalid") {
      quiet(reply(intent.message));
      return;
    }
    if (intent.action === "help" && typeof handlers.help !== "function") {
      quiet(reply(helpText()));
      return;
    }

    const handler = handlers[intent.action];
    if (typeof handler !== "function") {
      quiet(reply(`/${intent.command} no esta conectado en esta version.`));
      return;
    }

    const key = intent.id ? `${intent.action}:${intent.id}` : intent.action;
    if (inflight.has(key)) {
      quiet(reply(`ya hay un /${intent.command} en curso para eso. Espera a que termine.`));
      return;
    }

    const ctx = {
      cfg,
      store,
      chatId: msg.chatId,
      command: intent.command,
      text: msg.text,
      message: msg.message,
      signal,
      log,
      reply: (t, o = {}) => sendMessage(cfg, t, { chatId: msg.chatId, fetchImpl, ...o }),
      sendPhoto: (p, o = {}) => sendPhoto(cfg, p, { chatId: msg.chatId, fetchImpl, ...o }),
      sendVideo: (p, o = {}) => sendVideo(cfg, p, { chatId: msg.chatId, fetchImpl, ...o }),
      sendDocument: (p, o = {}) => sendDocument(cfg, p, { chatId: msg.chatId, fetchImpl, ...o }),
      deliver: (itemId) => deliverItem(cfg, store, itemId, { chatId: msg.chatId, fetchImpl }),
    };

    // Fuera del ciclo de polling a proposito: generar un video son minutos.
    const task = (async () => {
      if (SLOW_ACTIONS.has(intent.action)) await quiet(reply(ackFor(intent)));
      const out = await handler(handlerParams(intent), ctx);
      if (typeof out === "string" && out.trim()) await ctx.reply(out);
    })()
      .catch(async (err) => {
        log?.(`telegram: /${intent.command} fallo: ${err?.stack ?? err?.message ?? err}`);
        await quiet(reply(`error en /${intent.command}: ${err?.message ?? err}`));
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, task);
  }
}
