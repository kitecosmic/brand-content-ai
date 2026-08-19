// Tests de src/lib/telegram.mjs. Sin red: el `fetch` se inyecta.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TG_MAX_TEXT,
  deliverItem,
  extractMessage,
  helpText,
  isAuthorizedChat,
  isValidItemId,
  itemCaption,
  parseCommand,
  parseIntent,
  runBot,
  splitMessage,
  truncate,
} from "../src/lib/telegram.mjs";

// ---------------------------------------------------------------------------
// Andamiaje
// ---------------------------------------------------------------------------

const OWNER = "12345";
const INTRUSO = "99999";

function makeCfg(over = {}) {
  return {
    telegram: { pollIntervalMs: 0 },
    secrets: { telegramToken: "111:AAA", telegramChatId: OWNER },
    ...over,
  };
}

function fakeStore(kvInit = { "tg:offset": "0" }, items = {}) {
  const kv = new Map(Object.entries(kvInit));
  return {
    kv,
    items,
    statusCalls: [],
    get(k, fb = null) {
      return kv.has(k) ? kv.get(k) : fb;
    },
    set(k, v) {
      kv.set(k, String(v));
    },
    getItem(id) {
      return items[id] ?? null;
    },
    setStatus(id, status, patch = {}) {
      this.statusCalls.push({ id, status, patch });
      if (items[id]) items[id].status = status;
      return items[id] ?? null;
    },
  };
}

function jsonRes(obj, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(obj) };
}

/**
 * Levanta runBot con un fetch falso.
 * - entrega `updates` en el primer poll exitoso
 * - aborta en el poll numero `maxPolls`
 * - `failFirst` primeros polls fallan como falla la red
 */
async function runWithUpdates({ updates = [], handlers = {}, cfg = makeCfg(), store, maxPolls = 2, failFirst = 0 } = {}) {
  const s = store ?? fakeStore();
  const sent = [];
  const controller = new AbortController();
  let polls = 0;
  let failsLeft = failFirst;

  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init?.body instanceof FormData ? init.body : JSON.parse(init.body);
    sent.push({ method, body });
    if (method === "getUpdates") {
      if (failsLeft > 0) {
        failsLeft -= 1;
        throw new TypeError("fetch failed"); // asi falla fetch ante un corte de red
      }
      polls += 1;
      const batch = polls === 1 ? updates : [];
      if (polls >= maxPolls) controller.abort();
      return jsonRes({ ok: true, result: batch });
    }
    return jsonRes({ ok: true, result: { message_id: sent.length } });
  };

  await runBot(cfg, s, handlers, { signal: controller.signal, fetchImpl, drainMs: 5000 });

  return {
    store: s,
    sent,
    messages: sent.filter((c) => c.method === "sendMessage"),
    texts: sent.filter((c) => c.method === "sendMessage").map((c) => c.body.text),
  };
}

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

test("parseCommand: devuelve null si no es comando", () => {
  assert.equal(parseCommand("hola"), null);
  assert.equal(parseCommand(""), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand(42), null);
  assert.equal(parseCommand("mira esto /hoy"), null);
});

test("parseCommand: normaliza mayusculas, sufijo @bot y espacios", () => {
  assert.deepEqual(parseCommand("  /HOY  "), {
    cmd: "hoy",
    bot: null,
    args: [],
    rest: "",
    raw: "/HOY",
  });
  const p = parseCommand("/generar@BcaBot  2026-08-20-x  ");
  assert.equal(p.cmd, "generar");
  assert.equal(p.bot, "bcabot");
  assert.deepEqual(p.args, ["2026-08-20-x"]);
});

// ---------------------------------------------------------------------------
// parseIntent
// ---------------------------------------------------------------------------

test("parseIntent: comandos sin argumentos", () => {
  assert.deepEqual(parseIntent("/hoy"), { action: "today", command: "hoy" });
  assert.deepEqual(parseIntent("/pendientes"), { action: "pending", command: "pendientes" });
  assert.deepEqual(parseIntent("/ayuda"), { action: "help", command: "ayuda" });
  assert.deepEqual(parseIntent("/start"), { action: "help", command: "start" });
  assert.deepEqual(parseIntent("no es un comando"), { action: "none" });
  assert.deepEqual(parseIntent("/borrartodo"), { action: "unknown", command: "borrartodo" });
});

test("parseIntent: /plan y /costos con dias opcionales", () => {
  assert.deepEqual(parseIntent("/plan"), { action: "plan", command: "plan", days: null });
  assert.deepEqual(parseIntent("/plan 7"), { action: "plan", command: "plan", days: 7 });
  assert.deepEqual(parseIntent("/costos"), { action: "costs", command: "costos", days: null });
  assert.deepEqual(parseIntent("/costos 30"), { action: "costs", command: "costos", days: 30 });

  for (const bad of ["/plan manana", "/plan 0", "/plan 999", "/plan -3", "/plan 7.5"]) {
    const r = parseIntent(bad);
    assert.equal(r.action, "invalid", bad);
    assert.match(r.message, /uso: \/plan/);
  }
});

test("parseIntent: /generar y /ok exigen id valido", () => {
  assert.deepEqual(parseIntent("/generar 2026-08-20-agent-builds-schema"), {
    action: "generate",
    command: "generar",
    id: "2026-08-20-agent-builds-schema",
  });
  assert.deepEqual(parseIntent("/ok 2026-08-20-x"), {
    action: "approve",
    command: "ok",
    id: "2026-08-20-x",
  });
  assert.equal(parseIntent("/generar").action, "invalid");
  assert.equal(parseIntent("/ok").action, "invalid");
  // nada de rutas ni separadores en un id
  assert.equal(parseIntent("/generar ../../etc/passwd").action, "invalid");
  assert.equal(parseIntent("/generar C:/Users/x").action, "invalid");
});

test("parseIntent: /no toma el motivo entero, con espacios", () => {
  const r = parseIntent("/no 2026-08-20-x el hook es flojo, y el cierre no cierra");
  assert.deepEqual(r, {
    action: "reject",
    command: "no",
    id: "2026-08-20-x",
    reason: "el hook es flojo, y el cierre no cierra",
  });
});

test("parseIntent: /no conserva el motivo multilinea y colapsa el espacio sobrante", () => {
  const r = parseIntent("/no   2026-08-20-x    muy largo\nsacale la escena 3");
  assert.equal(r.action, "reject");
  assert.equal(r.id, "2026-08-20-x");
  assert.equal(r.reason, "muy largo\nsacale la escena 3");
});

test("parseIntent: /no sin motivo es invalido (el motivo guia la regeneracion)", () => {
  const r = parseIntent("/no 2026-08-20-x");
  assert.equal(r.action, "invalid");
  assert.match(r.message, /motivo/);
  assert.equal(parseIntent("/no   ").action, "invalid");
});

test("parseIntent: alias en ingles", () => {
  assert.equal(parseIntent("/today").action, "today");
  assert.equal(parseIntent("/generate abc").action, "generate");
  assert.equal(parseIntent("/reject abc porque si").action, "reject");
  assert.equal(parseIntent("/costs").action, "costs");
});

test("isValidItemId", () => {
  assert.ok(isValidItemId("2026-08-20-agent-builds-schema"));
  assert.ok(!isValidItemId("con espacio"));
  assert.ok(!isValidItemId("../x"));
  assert.ok(!isValidItemId(""));
  assert.ok(!isValidItemId(undefined));
});

// ---------------------------------------------------------------------------
// Autorizacion
// ---------------------------------------------------------------------------

test("isAuthorizedChat: solo el chat configurado", () => {
  const cfg = makeCfg();
  assert.ok(isAuthorizedChat(cfg, OWNER));
  assert.ok(isAuthorizedChat(cfg, Number(OWNER))); // Telegram manda numeros
  assert.ok(!isAuthorizedChat(cfg, INTRUSO));
  assert.ok(!isAuthorizedChat(cfg, "1234"));
  assert.ok(!isAuthorizedChat(cfg, "123456"));
  assert.ok(!isAuthorizedChat(cfg, ""));
  assert.ok(!isAuthorizedChat(cfg, null));
  assert.ok(!isAuthorizedChat(cfg, undefined));
});

test("isAuthorizedChat: falla cerrado si no hay chat configurado", () => {
  const cfg = { secrets: { telegramToken: "111:AAA", telegramChatId: "" } };
  assert.ok(!isAuthorizedChat(cfg, OWNER));
  assert.ok(!isAuthorizedChat(cfg, ""));
  assert.ok(!isAuthorizedChat({}, "1"));
  assert.ok(!isAuthorizedChat(undefined, "1"));
});

test("extractMessage: saca chat, texto y caption", () => {
  assert.equal(extractMessage({}), null);
  assert.equal(extractMessage({ message: {} }), null);
  const m = extractMessage({ message: { message_id: 7, chat: { id: 12345 }, text: "/hoy" } });
  assert.equal(m.chatId, "12345");
  assert.equal(m.text, "/hoy");
  const c = extractMessage({ message: { chat: { id: 1 }, caption: "/ok abc" } });
  assert.equal(c.text, "/ok abc");
});

test("runBot: ignora en silencio los updates de otros chats", async () => {
  const calls = [];
  const { messages, store } = await runWithUpdates({
    updates: [
      {
        update_id: 10,
        message: { message_id: 1, chat: { id: Number(INTRUSO) }, text: "/generar 2026-01-01-x" },
      },
      {
        update_id: 11,
        message: { message_id: 2, chat: { id: Number(INTRUSO) }, text: "/plan 30" },
      },
      { update_id: 12, message: { message_id: 3, chat: { id: Number(OWNER) }, text: "/hoy" } },
    ],
    handlers: {
      today: async (p, ctx) => {
        calls.push(["today", p, ctx.chatId]);
        return "1 item para hoy";
      },
      generate: async (p) => {
        calls.push(["generate", p]);
        return "generado";
      },
      plan: async (p) => {
        calls.push(["plan", p]);
        return "planificado";
      },
    },
  });

  // El intruso no dispara nada que cueste dinero...
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["today"],
  );
  // ...ni recibe respuesta alguna: ni un "no autorizado".
  assert.ok(messages.length > 0);
  for (const m of messages) assert.equal(m.body.chat_id, OWNER);
  assert.deepEqual([...new Set(messages.map((m) => m.body.chat_id))], [OWNER]);
  // Pero su update igual se marca consumido, para no reprocesarlo al reiniciar.
  assert.equal(store.get("tg:offset"), "13");
});

test("runBot: no arranca sin chat autorizado", async () => {
  const cfg = makeCfg({ secrets: { telegramToken: "111:AAA", telegramChatId: "" } });
  await assert.rejects(
    () => runBot(cfg, fakeStore(), {}, { fetchImpl: async () => jsonRes({ ok: true, result: [] }) }),
    /TELEGRAM_CHAT_ID/,
  );
});

test("runBot: no arranca sin token", async () => {
  const cfg = makeCfg({ secrets: { telegramToken: "", telegramChatId: OWNER } });
  await assert.rejects(
    () => runBot(cfg, fakeStore(), {}, { fetchImpl: async () => jsonRes({ ok: true, result: [] }) }),
    /TELEGRAM_BOT_TOKEN/,
  );
});

// ---------------------------------------------------------------------------
// splitMessage
// ---------------------------------------------------------------------------

test("splitMessage: textos que entran tal cual", () => {
  assert.deepEqual(splitMessage(""), []);
  assert.deepEqual(splitMessage("hola"), ["hola"]);
  const exacto = "a".repeat(TG_MAX_TEXT);
  assert.deepEqual(splitMessage(exacto), [exacto]);
});

test("splitMessage: parte por salto de linea y no pierde contenido", () => {
  const linea = "x".repeat(100);
  const texto = Array.from({ length: 120 }, (_, i) => `${i} ${linea}`).join("\n");
  assert.ok(texto.length > TG_MAX_TEXT);

  const chunks = splitMessage(texto);
  assert.ok(chunks.length >= 4);
  for (const c of chunks) {
    assert.ok(c.length <= TG_MAX_TEXT, `trozo de ${c.length}`);
    assert.notEqual(c.trim(), "");
  }
  // Solo se consume el separador: reconstruye pegando con \n.
  assert.equal(chunks.join("\n"), texto);
});

test("splitMessage: parte por espacio cuando no hay saltos de linea", () => {
  const texto = Array.from({ length: 900 }, (_, i) => `palabra${i}`).join(" ");
  assert.ok(texto.length > TG_MAX_TEXT);
  const chunks = splitMessage(texto);
  for (const c of chunks) assert.ok(c.length <= TG_MAX_TEXT);
  assert.equal(chunks.join(" "), texto);
});

test("splitMessage: corta a lo bruto una palabra gigante", () => {
  const texto = "z".repeat(9000);
  const chunks = splitMessage(texto);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, TG_MAX_TEXT);
  assert.equal(chunks[1].length, TG_MAX_TEXT);
  assert.equal(chunks[2].length, 9000 - 2 * TG_MAX_TEXT);
  assert.equal(chunks.join(""), texto);
});

test("splitMessage: no parte un par surrogate al medio", () => {
  // El emoji ocupa 2 code units: cortando en 5 caeria justo en el medio.
  const texto = "aaaa" + "\u{1F600}" + "bbbb";
  const chunks = splitMessage(texto, 5);
  assert.equal(chunks[0], "aaaa");
  assert.ok(chunks.join("").includes("\u{1F600}"));
  for (const c of chunks) {
    assert.ok(c.length <= 5);
    assert.ok(!/[\uD800-\uDBFF]$/.test(c), "un trozo termina en surrogate alto");
  }
});

test("splitMessage: acepta max chico y nunca devuelve trozos vacios", () => {
  for (const max of [1, 2, 3, 7, 13]) {
    const chunks = splitMessage("abcdefghij klmnopqrst\nuvwxyz", max);
    for (const c of chunks) {
      assert.ok(c.length <= max);
      assert.notEqual(c, "");
    }
  }
});

test("truncate: recorta y marca", () => {
  assert.equal(truncate("hola", 10), "hola");
  const t = truncate("a".repeat(50), 10);
  assert.ok(t.length <= 10);
  assert.ok(t.endsWith("…"));
});

test("runBot: una respuesta larga se manda partida, no se rechaza", async () => {
  const largo = "y".repeat(9000);
  const { messages } = await runWithUpdates({
    updates: [{ update_id: 1, message: { chat: { id: OWNER }, text: "/pendientes" } }],
    handlers: { pending: async () => largo },
  });
  assert.equal(messages.length, 3);
  for (const m of messages) assert.ok(m.body.text.length <= TG_MAX_TEXT);
  assert.equal(messages.map((m) => m.body.text).join(""), largo);
});

// ---------------------------------------------------------------------------
// Ruteo y resistencia
// ---------------------------------------------------------------------------

test("runBot: pasa los argumentos parseados a cada handler", async () => {
  const seen = [];
  await runWithUpdates({
    updates: [
      { update_id: 1, message: { chat: { id: OWNER }, text: "/plan 21" } },
      { update_id: 2, message: { chat: { id: OWNER }, text: "/no 2026-08-20-x sacale el hype" } },
      { update_id: 3, message: { chat: { id: OWNER }, text: "/costos" } },
    ],
    handlers: {
      plan: async (p) => void seen.push(["plan", p]),
      reject: async (p) => void seen.push(["reject", p]),
      costs: async (p) => void seen.push(["costs", p]),
    },
  });
  seen.sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(seen, [
    ["costs", { days: null }],
    ["plan", { days: 21 }],
    ["reject", { id: "2026-08-20-x", reason: "sacale el hype" }],
  ]);
});

test("runBot: acusa recibo antes de un handler lento y sigue atendiendo", async () => {
  let resolveSlow;
  const slow = new Promise((r) => (resolveSlow = r));
  const { texts } = await runWithUpdates({
    updates: [
      { update_id: 1, message: { chat: { id: OWNER }, text: "/generar 2026-08-20-x" } },
      { update_id: 2, message: { chat: { id: OWNER }, text: "/hoy" } },
    ],
    handlers: {
      generate: async () => {
        await slow;
        return "listo el video";
      },
      today: async () => {
        resolveSlow(); // el comando rapido corre aunque el lento siga colgado
        return "nada para hoy";
      },
    },
  });
  assert.ok(texts.some((t) => t.includes("generando 2026-08-20-x")));
  assert.ok(texts.includes("nada para hoy"));
  assert.ok(texts.includes("listo el video"));
});

test("runBot: un handler que explota no mata el bot", async () => {
  const { texts } = await runWithUpdates({
    updates: [
      { update_id: 1, message: { chat: { id: OWNER }, text: "/hoy" } },
      { update_id: 2, message: { chat: { id: OWNER }, text: "/pendientes" } },
    ],
    handlers: {
      today: async () => {
        throw new Error("la db esta bloqueada");
      },
      pending: async () => "3 pendientes",
    },
  });
  assert.ok(texts.some((t) => t.includes("error en /hoy: la db esta bloqueada")));
  assert.ok(texts.includes("3 pendientes"));
});

test("runBot: comando desconocido, mal usado o no conectado responde con ayuda", async () => {
  const { texts } = await runWithUpdates({
    updates: [
      { update_id: 1, message: { chat: { id: OWNER }, text: "/borrartodo" } },
      { update_id: 2, message: { chat: { id: OWNER }, text: "/no 2026-08-20-x" } },
      { update_id: 3, message: { chat: { id: OWNER }, text: "/ayuda" } },
      { update_id: 4, message: { chat: { id: OWNER }, text: "/costos" } },
      { update_id: 5, message: { chat: { id: OWNER }, text: "hola, todo bien?" } },
    ],
    handlers: {},
  });
  assert.ok(texts.some((t) => t.includes("no conozco /borrartodo")));
  assert.ok(texts.some((t) => t.includes("uso: /no <id> <motivo>")));
  assert.ok(texts.some((t) => t === helpText()));
  assert.ok(texts.some((t) => t.includes("/costos no esta conectado")));
  // El texto suelto no genera ruido.
  assert.equal(texts.length, 4);
});

test("runBot: un fetch fallido no mata el polling", async () => {
  const calls = [];
  const { store } = await runWithUpdates({
    failFirst: 1,
    updates: [{ update_id: 41, message: { chat: { id: OWNER }, text: "/hoy" } }],
    handlers: { today: async () => void calls.push("today") },
  });
  assert.deepEqual(calls, ["today"]);
  assert.equal(store.get("tg:offset"), "42");
});

test("runBot: arranca desde el offset guardado y corta si ya venia abortado", async () => {
  const store = fakeStore({ "tg:offset": "500" });
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  await runBot(makeCfg(), store, {}, {
    signal: controller.signal,
    fetchImpl: async (url) => {
      calls.push(String(url).split("/").pop());
      return jsonRes({ ok: true, result: [] });
    },
  });
  assert.deepEqual(calls, []); // no llego a pedir nada
  assert.equal(store.get("tg:offset"), "500");
});

// ---------------------------------------------------------------------------
// deliverItem
// ---------------------------------------------------------------------------

test("deliverItem: manda el texto y pasa el item a delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bca-tg-"));
  try {
    const file = join(dir, "post.md");
    writeFileSync(file, "Nubex corre en tu Postgres. Sin vendor lock-in.\n");
    const item = {
      id: "2026-08-20-x",
      scheduled_for: "2026-08-20",
      format: "text",
      language: "en",
      angle: "un angulo",
      message: "el mensaje",
      status: "built",
      revision: 0,
      asset_path: file,
      preview_path: null,
    };
    const store = fakeStore({}, { "2026-08-20-x": item });
    const sent = [];
    await deliverItem(makeCfg(), store, "2026-08-20-x", {
      fetchImpl: async (url, init) => {
        sent.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
        return jsonRes({ ok: true, result: { message_id: 1 } });
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, "sendMessage");
    assert.equal(sent[0].body.chat_id, OWNER);
    assert.ok(sent[0].body.text.includes("Sin vendor lock-in"));
    assert.ok(sent[0].body.text.includes("/ok 2026-08-20-x"));
    assert.deepEqual(store.statusCalls, [{ id: "2026-08-20-x", status: "delivered", patch: {} }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deliverItem: explota si el item no existe", async () => {
  await assert.rejects(() => deliverItem(makeCfg(), fakeStore(), "no-existe"), /item no encontrado/);
});

test("itemCaption: entra en el limite de caption y recuerda los comandos", () => {
  const caption = itemCaption({
    id: "2026-08-20-x",
    scheduled_for: "2026-08-20",
    format: "video",
    language: "en",
    angle: "a".repeat(2000),
    message: "m".repeat(2000),
    revision: 2,
  });
  assert.ok(caption.length <= 1024, `caption de ${caption.length}`);
  assert.ok(caption.includes("/ok 2026-08-20-x"));
  assert.ok(caption.includes("/no 2026-08-20-x <motivo>"));
});
