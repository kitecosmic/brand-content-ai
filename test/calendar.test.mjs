// Tests de calendar.mjs. Ninguno llama al modelo: todo lo que se prueba son
// las funciones puras que filtran y normalizan lo que el modelo devuelve, que
// es justo donde estan los bugs caros (un formato apagado que se cuela, un id
// que pisa a otro, una fecha fuera de ventana).

import test from "node:test";
import assert from "node:assert/strict";

import {
  angleSimilarity,
  assignId,
  buildPlanPrompt,
  enabledFormats,
  findBannedPhrase,
  isIsoDate,
  normalizeItems,
  pickItems,
  planSlots,
  remainingSlots,
  scaleMix,
} from "../src/lib/calendar.mjs";

const CFG = {
  brand: {
    name: "Nubex",
    site: "https://nubex.dev",
    audience: "developers",
    voice: "confident, technical, fast",
    languages: ["en", "es", "pt"],
    defaultLanguage: "en",
    never: ["seamless experience", "unlock the power of", "game-changing"],
  },
  formats: {
    video: { enabled: true, aspect: "1920x1080", lengthSeconds: 40 },
    carousel: { enabled: true, aspect: "1080x1350", slides: 6 },
    image: { enabled: false, aspect: "1080x1080" },
    text: { enabled: true, maxChars: 600 },
  },
  calendar: { itemsPerWeek: 5, mix: { text: 2, image: 1, carousel: 1, video: 1 } },
};

const WINDOW = { from: "2026-08-17", to: "2026-08-30" };
const opts = (extra = {}) => ({ cfg: CFG, ...WINDOW, ...extra });

const item = (over = {}) => ({
  scheduled_for: "2026-08-18",
  format: "text",
  language: "en",
  angle: "angulo base distinto de todo lo demas",
  message: "Un mensaje concreto y verificable.",
  ...over,
});

// --- formatos ---------------------------------------------------------------

test("descarta formatos deshabilitados o inexistentes en cfg.formats", () => {
  assert.deepEqual(enabledFormats(CFG).sort(), ["carousel", "text", "video"]);

  const { items, dropped } = normalizeItems(
    [
      item({ format: "image", angle: "postgres arranca en un comando" }),
      item({ format: "reel", angle: "auth sin escribir backend" }),
      item({ format: "", angle: "storage con politicas por fila" }),
      item({ format: "VIDEO", angle: "realtime en cuarenta segundos" }),
      item({ format: "text", angle: "migraciones que escribe el agente" }),
    ],
    opts(),
  );

  assert.deepEqual(
    items.map((i) => i.format),
    ["video", "text"],
    "image (enabled:false), reel (inexistente) y vacio quedan afuera; VIDEO se normaliza",
  );
  assert.equal(dropped.filter((d) => d.reason === "formato").length, 3);
  assert.ok(dropped.every((d) => d.detail.includes("cfg.formats")));
});

// --- ids --------------------------------------------------------------------

test("assignId desambigua con sufijo numerico en vez de pisar", () => {
  const taken = new Set();
  assert.equal(assignId("2026-08-18", "Ship a backend", taken), "2026-08-18-ship-a-backend");
  assert.equal(assignId("2026-08-18", "Ship a backend", taken), "2026-08-18-ship-a-backend-2");
  assert.equal(assignId("2026-08-18", "Ship a backend", taken), "2026-08-18-ship-a-backend-3");
  assert.equal(taken.size, 3);
});

test("assignId respeta ids ya tomados y no genera id vacio", () => {
  const taken = new Set(["2026-08-18-ship-a-backend"]);
  assert.equal(assignId("2026-08-18", "Ship a backend!", taken), "2026-08-18-ship-a-backend-2");
  // un angulo sin caracteres slugificables no puede producir "2026-08-18-"
  assert.equal(assignId("2026-08-18", "・・・", new Set()), "2026-08-18-item");
});

test("normalizeItems no pisa un item existente con el mismo id", () => {
  const angle = "el agente escribe el esquema";
  const { items } = normalizeItems([item({ angle, format: "text" })], opts({
    takenIds: [`2026-08-18-${"el-agente-escribe-el-esquema"}`],
  }));

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "2026-08-18-el-agente-escribe-el-esquema-2");
});

test("dos angulos distintos que slugifican igual (truncado) reciben ids distintos", () => {
  const prefijo = "postgres auth storage realtime functions y mcp en un solo binario";
  const { items } = normalizeItems(
    [
      item({ angle: `${prefijo} para indies` }),
      item({ angle: `${prefijo} para equipos` }),
    ],
    // similarity 1 = solo se descarta el angulo identico; aca interesa el choque de id
    opts({ similarity: 1 }),
  );

  assert.equal(items.length, 2);
  assert.equal(items[0].id.length <= 10 + 1 + 48, true);
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(items[1].id, `${items[0].id}-2`);
});

// --- fechas -----------------------------------------------------------------

test("isIsoDate exige YYYY-MM-DD y una fecha real", () => {
  assert.equal(isIsoDate("2026-08-17"), true);
  assert.equal(isIsoDate("2026-8-7"), false);
  assert.equal(isIsoDate("17/08/2026"), false);
  assert.equal(isIsoDate("2026-02-31"), false, "31 de febrero no existe");
  assert.equal(isIsoDate("2026-13-01"), false);
  assert.equal(isIsoDate(""), false);
  assert.equal(isIsoDate(null), false);
});

test("descarta fechas fuera de la ventana pedida o mal formateadas", () => {
  const { items, dropped } = normalizeItems(
    [
      item({ scheduled_for: "2026-08-16", angle: "un dia antes de la ventana" }),
      item({ scheduled_for: "2026-08-31", angle: "un dia despues de la ventana" }),
      item({ scheduled_for: "2026-8-20", angle: "fecha sin cero a la izquierda" }),
      item({ scheduled_for: "proximo lunes", angle: "fecha en prosa" }),
      item({ scheduled_for: undefined, angle: "sin fecha" }),
      item({ scheduled_for: "2026-08-17", angle: "primer dia de la ventana, valido" }),
      item({ scheduled_for: "2026-08-30", angle: "ultimo dia de la ventana, tambien valido" }),
    ],
    opts(),
  );

  assert.deepEqual(
    items.map((i) => i.scheduled_for),
    ["2026-08-17", "2026-08-30"],
    "los bordes entran, todo lo demas se cae",
  );
  assert.equal(dropped.filter((d) => d.reason === "fecha").length, 5);
});

// --- frases prohibidas ------------------------------------------------------

test("findBannedPhrase tolera mayusculas, puntuacion y acentos", () => {
  const never = CFG.brand.never;
  assert.equal(findBannedPhrase("Unlock the power of Postgres", never), "unlock the power of");
  assert.equal(findBannedPhrase("A truly SEAMLESS   EXPERIENCE.", never), "seamless experience");
  assert.equal(findBannedPhrase("this is game-changing", never), "game-changing");
  assert.equal(findBannedPhrase("un backend en un comando", never), null);
});

test("descarta items que usan frases de cfg.brand.never, en angle o en message", () => {
  const { items, dropped } = normalizeItems(
    [
      item({ angle: "Unlock the power of your database", message: "Mensaje limpio." }),
      item({ angle: "Auth lista en un comando", message: "Nubex gives you a seamless experience." }),
      item({ angle: "Esto es game-changing", message: "Otro mensaje." }),
      item({ angle: "Postgres con pgvector desde el minuto cero", message: "Un mensaje sin frases vacias." }),
    ],
    opts(),
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].angle, "Postgres con pgvector desde el minuto cero");
  assert.deepEqual(dropped.map((d) => d.reason), ["prohibido", "prohibido", "prohibido"]);
});

// --- angulos repetidos ------------------------------------------------------

test("descarta el angulo ya usado y el mismo angulo con otras palabras", () => {
  const usedAngles = ["Tu agente escribe el esquema y Nubex corre la migracion"];
  const { items, dropped } = normalizeItems(
    [
      item({ angle: "Nubex corre la migracion que escribe tu agente" }),
      item({ angle: "Realtime sobre Postgres sin servidor de websockets propio" }),
      item({ angle: "Realtime sobre Postgres, sin un servidor de websockets propio" }),
    ],
    opts({ usedAngles }),
  );

  assert.equal(items.length, 1);
  assert.equal(dropped.filter((d) => d.reason === "repetido").length, 2);
  assert.ok(angleSimilarity(usedAngles[0], "Nubex corre la migracion que escribe tu agente") >= 0.6);
  assert.ok(angleSimilarity("auth con oauth y magic link", "video de 40 segundos sobre storage") < 0.2);
});

test("el umbral de repeticion separa angulos legitimos de parafraseos", () => {
  // Calibracion: si esto se rompe, el filtro pasa a comerse calendario bueno
  // (o a dejar pasar el mismo angulo con otras palabras, que es el fallo caro).
  const legitimos = [
    "Auth con OAuth y magic link sin escribir un backend",
    "Realtime sobre Postgres sin levantar un servidor de websockets",
    "pgvector viene incluido: busqueda semantica sin otro servicio",
    "Storage con politicas de acceso por fila, no por bucket",
    "Un binario en Go: deploy sin Kubernetes",
    "De cero a API REST en 90 segundos",
  ];
  for (let i = 0; i < legitimos.length; i++) {
    for (let j = i + 1; j < legitimos.length; j++) {
      const s = angleSimilarity(legitimos[i], legitimos[j]);
      assert.ok(s < 0.6, `angulos distintos no deberian parecerse (${s}): ${legitimos[i]} / ${legitimos[j]}`);
    }
  }

  const parafraseos = [
    ["El agente escribe el esquema y Nubex corre la migracion", "Nubex corre la migracion que escribe tu agente"],
    ["Auth en un solo comando", "En un solo comando, auth"],
    ["De cero a API REST en 90 segundos", "Tu API REST lista en 90 segundos desde cero"],
    ["pgvector incluido, busqueda semantica sin otro servicio", "Busqueda semantica con pgvector, sin sumar otro servicio"],
  ];
  for (const [a, b] of parafraseos) {
    const s = angleSimilarity(a, b);
    assert.ok(s >= 0.6, `esto es el mismo angulo con otras palabras (${s}): ${a} / ${b}`);
  }
});

// --- normalizacion de campos ------------------------------------------------

test("normaliza language y descarta items incompletos", () => {
  const { items, dropped } = normalizeItems(
    [
      item({ language: "fr", angle: "idioma no soportado cae al default" }),
      item({ language: "pt", angle: "idioma soportado se respeta" }),
      item({ angle: "", message: "sin angulo" }),
      item({ angle: "sin mensaje", message: "   " }),
      "no soy un objeto",
    ],
    opts(),
  );

  assert.deepEqual(items.map((i) => i.language), ["en", "pt"]);
  assert.deepEqual(
    dropped.map((d) => d.reason),
    ["incompleto", "incompleto", "invalido"],
  );
});

test("pickItems acepta array pelado o envuelto", () => {
  assert.deepEqual(pickItems([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(pickItems({ items: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(pickItems({ calendar: [{ a: 2 }] }), [{ a: 2 }]);
  assert.deepEqual(pickItems({ nada: 1 }), []);
  assert.deepEqual(pickItems(null), []);
});

// --- grilla -----------------------------------------------------------------

test("scaleMix reparte exactamente el total pedido", () => {
  const m = scaleMix({ text: 2, image: 1, carousel: 1, video: 1 }, 10);
  assert.equal(Object.values(m).reduce((a, b) => a + b, 0), 10);
  assert.equal(m.text, 4);
  assert.equal(scaleMix({ a: 1, b: 1, c: 1 }, 7).a + scaleMix({ a: 1, b: 1, c: 1 }, 7).b >= 4, true);
  assert.deepEqual(scaleMix({}, 5), {});
  assert.deepEqual(scaleMix({ a: 1 }, 0), {});
});

test("planSlots escala itemsPerWeek a los dias pedidos y saltea formatos apagados", () => {
  const { slots, perFormat } = planSlots(CFG, { days: 14, from: "2026-08-17" });

  assert.equal(slots.length, 10, "5 por semana x 2 semanas");
  assert.equal(perFormat.image, undefined, "image esta deshabilitado y no entra al mix");
  assert.ok(slots.every((s) => enabledFormats(CFG).includes(s.format)));
  assert.ok(slots.every((s) => s.scheduled_for >= "2026-08-17" && s.scheduled_for <= "2026-08-30"));
  assert.equal(new Set(slots.map((s) => s.scheduled_for)).size, 10, "un dia por pieza mientras haya lugar");
});

test("planSlots descuenta lo que ya existe en la ventana", () => {
  const existing = [
    { scheduled_for: "2026-08-18", format: "text" },
    { scheduled_for: "2026-08-19", format: "text" },
    { scheduled_for: "2026-08-20", format: "video" },
  ];
  const { slots, perFormat } = planSlots(CFG, { days: 14, from: "2026-08-17", existing });

  // sin image (deshabilitado) el mix se reparte entre text/carousel/video: 5/3/2.
  // Ya hay 2 text y 1 video, asi que faltan 3 text, 3 carousel y 1 video.
  assert.equal(slots.length, 7);
  assert.equal(perFormat.text, 3);
  assert.equal(perFormat.carousel, 3);
  assert.equal(perFormat.video, 1);
  assert.ok(
    slots.every((s) => !existing.some((e) => e.scheduled_for === s.scheduled_for)),
    "no apila sobre dias ya ocupados si hay dias libres",
  );

  const lleno = planSlots(CFG, { days: 7, from: "2026-08-17", existing: fill(7) });
  assert.deepEqual(lleno.slots, [], "ventana ya cubierta: no pide nada");
});

function fill(n) {
  const mix = ["text", "text", "image", "carousel", "video"];
  return Array.from({ length: n }, (_, i) => ({
    scheduled_for: `2026-08-${String(17 + i).padStart(2, "0")}`,
    format: mix[i % mix.length],
  }));
}

test("remainingSlots devuelve lo que el modelo no cubrio", () => {
  const slots = [
    { scheduled_for: "2026-08-17", format: "text" },
    { scheduled_for: "2026-08-19", format: "text" },
    { scheduled_for: "2026-08-21", format: "video" },
  ];
  const left = remainingSlots(slots, [{ format: "text" }]);
  assert.deepEqual(left.map((s) => s.format), ["text", "video"]);
  assert.deepEqual(remainingSlots(slots, []), slots);
});

// --- prompt -----------------------------------------------------------------

test("el prompt lleva angulos usados, frases prohibidas, slots y contexto", () => {
  const p = buildPlanPrompt({
    cfg: CFG,
    slots: [{ scheduled_for: "2026-08-17", format: "text" }],
    ...WINDOW,
    usedAngles: ["un angulo que ya usamos"],
    knowledge: "Nubex es un BaaS en Go.",
  });

  assert.match(p, /un angulo que ya usamos/);
  assert.match(p, /unlock the power of/);
  assert.match(p, /2026-08-17/);
  assert.match(p, /Nubex es un BaaS en Go\./);
  assert.doesNotMatch(p, /image/, "un formato deshabilitado no se le ofrece al modelo");

  const sinKnowledge = buildPlanPrompt({ cfg: CFG, slots: [], ...WINDOW });
  assert.match(sinKnowledge, /sin contexto disponible/);
});
