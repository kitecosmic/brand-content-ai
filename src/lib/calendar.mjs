// Planificacion del calendario de contenido.
//
// El fallo tipico de un generador automatico no es fallar: es aburrir. A la
// tercera semana dice lo mismo con otras palabras. Tres defensas contra eso:
//
//   1. Al modelo se le pasan TODOS los angulos ya usados, con la orden de no
//      repetirlos ni parafrasearlos.
//   2. La grilla (fecha + formato) se resuelve aca, no la inventa el modelo:
//      solo tiene que aportar angulo, mensaje e idioma. Menos superficie para
//      desviarse, y el mix de formatos sale garantizado.
//   3. Todo lo que vuelve se vuelve a filtrar: formato habilitado, fecha dentro
//      de la ventana, frases prohibidas de la marca y angulos repetidos. No se
//      confia en que el modelo respete el enum.
//
// Casi todo el modulo son funciones puras exportadas: la unica parte que llama
// al modelo es `planCalendar`.

import { addDays, slugify, today, withBrand } from "./config.mjs";
import { runClaudeJSON } from "./claude.mjs";
import { knowledgeContext } from "./knowledge.mjs";

// Palabras vacias (en/es/pt) que no cuentan al comparar dos angulos.
const STOPWORDS = new Set(
  ("the a an and or of for to in on with your you is are that this it its from by as at " +
    "el la los las un una unos unas de del y o para con en tu tus su sus es son que esto esta " +
    "do da dos das um uma e com seu sua isso este esta por no na")
    .split(" "),
);

/**
 * Genera y persiste el calendario de los proximos `days` dias.
 *
 * @param {object} cfg    - brand-content-ai.config.json cargado (loadConfig)
 * @param {import("./store.mjs").Store} store
 * @param {object} [opts]
 * @param {number} [opts.days=14]
 * @param {string} [opts.from]  - YYYY-MM-DD; por defecto hoy
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ created: object[], costUsd: number }>}
 */
/**
 * Planifica el calendario, dejando rastro del trabajo en la base.
 *
 * El registro va aca y no adentro para no envolver toda la funcion en un
 * try/finally: `planCalendarInner` tiene varios returns. La clave "__plan" no
 * puede chocar con un id de item porque todos empiezan con la fecha.
 */
export async function planCalendar(cfg, store, opts = {}) {
  const JOB_ID = "__plan";
  store.startJob?.(JOB_ID, { kind: "plan", phase: "planificando" });
  try {
    return await planCalendarInner(cfg, store, opts);
  } finally {
    store.endJob?.(JOB_ID);
  }
}

async function planCalendarInner(cfg, store, { days = 14, from, log, brandId } = {}) {
  const note = typeof log === "function" ? log : () => {};
  // Todo lo que sigue mira UNA marca: su calendario, su conocimiento, su voz.
  const brand = brandId ? store.getBrand(brandId) : store.defaultBrand();
  if (!brand) throw new Error("no hay ninguna marca todavia: crea una antes de planificar");
  cfg = withBrand(cfg, brand);
  const dayCount = Math.max(1, Math.floor(Number(days) || 14));
  const start = from || today();
  if (!isIsoDate(start)) throw new Error(`from invalido, se espera YYYY-MM-DD: ${from}`);
  const end = addDays(start, dayCount - 1);

  // listItems limita a 100 por defecto: aca queremos el historico completo,
  // porque los angulos viejos son justamente lo que no hay que repetir.
  const all = store.listItems({ limit: 5000, brandId: brand.id });
  const inWindow = all.filter((i) => i.scheduled_for >= start && i.scheduled_for <= end);

  const { slots, perFormat } = planSlots(cfg, { days: dayCount, from: start, existing: inWindow });
  if (!slots.length) {
    note(`nada que planificar: ${start}..${end} ya tiene ${inWindow.length} items y cubre el mix`);
    return { created: [], costUsd: 0 };
  }
  note(
    `ventana ${start}..${end}: ${slots.length} slots a cubrir ` +
      `(${Object.entries(perFormat).map(([f, n]) => `${f} x${n}`).join(", ")})`,
  );

  const knowledge = loadKnowledgeContext(store, note, brand.id);
  const usedAngles = all.map((i) => i.angle).filter(Boolean);
  const takenIds = new Set(all.map((i) => i.id));

  let costUsd = 0;
  const accepted = [];
  let pending = slots;

  // Como maximo dos llamadas: la segunda solo si volvio menos del 60% del
  // calendario (cada invocacion recarga ~30k tokens, no se reintenta gratis).
  for (let round = 0; round < 2 && pending.length; round++) {
    const avoid = [...usedAngles, ...accepted.map((i) => i.angle)];
    const prompt = buildPlanPrompt({
      cfg,
      slots: pending,
      from: start,
      to: end,
      usedAngles: avoid,
      knowledge,
      retry: round > 0,
    });

    const started = Date.now();
    let res;
    try {
      res = await runClaudeJSON(prompt, {
        model: cfg?.models?.plan,
        timeoutMs: cfg?.limits?.claudeTimeoutMs,
        systemPrompt: brandSystemPrompt(cfg),
      });
    } catch (err) {
      store.logRun({
        kind: "plan",
        model: cfg?.models?.plan ?? null,
        ms: Date.now() - started,
        ok: false,
        detail: String(err?.message ?? err).slice(0, 500),
      });
      throw err;
    }

    costUsd += res.costUsd ?? 0;
    store.logRun({
      kind: "plan",
      model: res.model ?? cfg?.models?.plan ?? null,
      costUsd: res.costUsd,
      ms: res.ms,
      ok: true,
      detail: `slots=${pending.length} ronda=${round + 1}`,
    });

    const { items, dropped } = normalizeItems(pickItems(res.data), {
      cfg,
      from: start,
      to: end,
      takenIds,
      usedAngles: avoid,
    });
    for (const d of dropped) note(`descartado (${d.reason}): ${d.detail}`);

    for (const it of items) takenIds.add(it.id);
    accepted.push(...items);
    pending = remainingSlots(pending, items);

    if (!pending.length) break;
    const suficiente = accepted.length >= Math.ceil(slots.length * 0.6);
    if (round === 0 && !suficiente) {
      note(`solo ${accepted.length}/${slots.length} slots utiles; reintento los ${pending.length} que faltan`);
      continue;
    }
    note(`quedaron ${pending.length} slots sin cubrir; no se reintenta`);
    break;
  }

  if (!accepted.length) {
    note("el modelo no devolvio ningun item utilizable: el calendario quedo vacio");
    return { created: [], costUsd };
  }

  const created = accepted.map((it) => store.upsertItem({ ...it, brandId: brand.id }));
  note(`calendario ${start}..${end}: ${created.length} items persistidos`);
  return { created, costUsd };
}

// ---------------------------------------------------------------------------
// Grilla: fechas y formatos. Puro.
// ---------------------------------------------------------------------------

/** Formatos declarados en cfg.formats y no deshabilitados. */
export function enabledFormats(cfg) {
  const formats = cfg?.formats ?? {};
  return Object.keys(formats).filter((f) => formats[f] && formats[f].enabled !== false);
}

/**
 * Reparte `total` unidades entre los pesos de `mix` (metodo del resto mayor:
 * la suma da exactamente `total`, sin desvios por redondeo).
 */
/**
 * Cuantas piezas le tocan a cada idioma. Sale de `brand.languageMix`; sin esa
 * clave, todo al idioma por defecto (que es como se comportaba antes).
 */
/**
 * Crea una copia de un item en otro idioma.
 *
 * Es la via para "quiero esta misma pieza tambien en espanol": el hermano
 * comparte angulo y mensaje pero tiene su propio id, su propio brief y su propio
 * entregable, asi que se genera, se rechaza y se regenera por separado. No
 * traduce nada aca — el brief se escribe en el idioma del item.
 */
export function duplicateToLanguage(store, cfg, id, language) {
  const src = store.getItem(id);
  if (!src) throw new Error(`no existe el item ${id}`);

  const languages = cfg?.brand?.languages ?? [];
  if (!languages.includes(language)) {
    throw new Error(`idioma no configurado: ${language} (hay ${languages.join(", ")})`);
  }
  if (src.language === language) {
    throw new Error(`${id} ya esta en ${language}`);
  }

  const taken = new Set(store.listItems({ limit: 5000 }).map((i) => i.id));
  const base = `${src.scheduled_for}-${slugify(src.angle)}-${language}`;
  let newId = base;
  for (let n = 2; taken.has(newId); n++) newId = `${base}-${n}`;

  return store.upsertItem({
    id: newId,
    scheduled_for: src.scheduled_for,
    format: src.format,
    language,
    angle: src.angle,
    message: src.message,
  });
}

export function languageQuota(cfg, total) {
  const langs = cfg?.brand?.languages ?? [];
  const mixRaw = cfg?.brand?.languageMix ?? null;
  if (!mixRaw || !total) return {};
  const mix = {};
  for (const [k, v] of Object.entries(mixRaw)) {
    if (langs.includes(k) && Number(v) > 0) mix[k] = Number(v);
  }
  if (!Object.keys(mix).length) return {};
  return scaleMix(mix, total);
}

/**
 * Elige idioma y lo descuenta de la cuota.
 *
 * `preferred` es lo que sugirio el modelo: se respeta si es un idioma valido y
 * todavia queda cupo. Sin `languageMix` configurado la cuota viene vacia y manda
 * la sugerencia (o el default), que es el comportamiento de siempre.
 */
export function takeFromQuota(quota, languages, fallback, preferred = null) {
  const valid = preferred && languages.includes(preferred) ? preferred : null;

  if (valid && (quota[valid] ?? 0) > 0) {
    quota[valid] -= 1;
    return valid;
  }
  const pick = Object.entries(quota)
    .filter(([lang, n]) => n > 0 && languages.includes(lang))
    .sort((a, b) => b[1] - a[1])[0];
  if (pick) {
    quota[pick[0]] -= 1;
    return pick[0];
  }
  return valid ?? fallback;
}

export function scaleMix(mix, total) {
  const entries = Object.entries(mix ?? {}).filter(([, w]) => Number(w) > 0);
  const sum = entries.reduce((a, [, w]) => a + Number(w), 0);
  if (!entries.length || sum <= 0 || total <= 0) return {};

  const exact = entries.map(([f, w]) => ({ f, x: (Number(w) / sum) * total }));
  const out = {};
  let assigned = 0;
  for (const e of exact) {
    out[e.f] = Math.floor(e.x);
    assigned += out[e.f];
  }
  const byRest = exact
    .map((e) => ({ f: e.f, r: e.x - Math.floor(e.x) }))
    .sort((a, b) => b.r - a.r || a.f.localeCompare(b.f));
  for (let i = 0; assigned < total; i++, assigned++) {
    out[byRest[i % byRest.length].f]++;
  }
  return out;
}

/**
 * Grilla de slots para la ventana: cuantas piezas de cada formato y en que dia.
 * Descuenta lo que ya existe en la ventana (replanificar no duplica) y evita
 * apilar dos piezas el mismo dia mientras haya dias libres.
 *
 * @returns {{ slots: {scheduled_for: string, format: string}[], perFormat: Record<string, number>, total: number }}
 */
export function planSlots(cfg, { days = 14, from, existing = [] } = {}) {
  const dayCount = Math.max(1, Math.floor(Number(days) || 1));
  const start = from || today();
  const perWeek = Number(cfg?.calendar?.itemsPerWeek) > 0 ? Number(cfg.calendar.itemsPerWeek) : 5;
  const total = Math.max(1, Math.round((perWeek * dayCount) / 7));

  const allowed = enabledFormats(cfg);
  if (!allowed.length) return { slots: [], perFormat: {}, total: 0 };

  const mix = {};
  for (const [f, w] of Object.entries(cfg?.calendar?.mix ?? {})) {
    if (allowed.includes(f) && Number(w) > 0) mix[f] = Number(w);
  }
  // Sin mix util (o con todos sus formatos apagados): reparto parejo.
  if (!Object.keys(mix).length) for (const f of allowed) mix[f] = 1;

  const target = scaleMix(mix, total);

  const already = {};
  for (const it of existing) already[it.format] = (already[it.format] ?? 0) + 1;

  const perFormat = {};
  for (const [f, n] of Object.entries(target)) {
    const need = Math.max(0, n - (already[f] ?? 0));
    if (need > 0) perFormat[f] = need;
  }

  // Intercalar formatos (round-robin por el que mas falta) para no dejar tres
  // videos seguidos.
  const queue = Object.entries(perFormat)
    .map(([f, n]) => ({ f, n }))
    .sort((a, b) => b.n - a.n || a.f.localeCompare(b.f));
  const sequence = [];
  while (queue.some((q) => q.n > 0)) {
    for (const q of queue) {
      if (q.n > 0) {
        sequence.push(q.f);
        q.n--;
      }
    }
  }
  if (!sequence.length) return { slots: [], perFormat: {}, total: 0 };

  const busy = new Set(existing.map((i) => i.scheduled_for));
  const slots = sequence.map((format, i) => {
    const offset = Math.floor((i * dayCount) / sequence.length);
    return { scheduled_for: freeDate(start, offset, dayCount, busy), format };
  });

  return { slots, perFormat, total: sequence.length };
}

/** Primer dia libre desde `offset` hacia adelante (y si no hay, hacia atras). */
function freeDate(start, offset, dayCount, busy) {
  for (let k = 0; k < dayCount; k++) {
    const d = addDays(start, (offset + k) % dayCount);
    if (!busy.has(d)) {
      busy.add(d);
      return d;
    }
  }
  return addDays(start, offset); // ventana llena: se apila, es lo menos malo
}

/** Slots que ningun item devuelto cubre (se compara por formato). */
export function remainingSlots(slots, items) {
  const got = {};
  for (const it of items) got[it.format] = (got[it.format] ?? 0) + 1;
  const left = [];
  for (const s of slots) {
    if (got[s.format] > 0) got[s.format]--;
    else left.push(s);
  }
  return left;
}

// ---------------------------------------------------------------------------
// Validacion y normalizacion de lo que devuelve el modelo. Puro.
// ---------------------------------------------------------------------------

/** El modelo a veces envuelve el array; se acepta el array o el envoltorio. */
export function pickItems(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of ["items", "calendar", "plan", "posts", "content", "schedule"]) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}

/** YYYY-MM-DD y ademas una fecha real (rechaza 2026-02-31). */
export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** minusculas, sin acentos, sin puntuacion: para comparar frases prohibidas. */
export function normalizeForMatch(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Devuelve la frase prohibida encontrada, o null. Tolera puntuacion y mayusculas. */
export function findBannedPhrase(text, never = []) {
  const hay = ` ${normalizeForMatch(text)} `;
  for (const phrase of never) {
    const needle = normalizeForMatch(phrase);
    if (needle && hay.includes(` ${needle} `.replace(/\s+/g, " "))) return phrase;
  }
  return null;
}

/** Tokens significativos de un angulo (sin stopwords en/es/pt). */
export function angleTokens(s) {
  const all = normalizeForMatch(s).split(" ").filter(Boolean);
  const kept = all.filter((t) => !STOPWORDS.has(t) && t.length > 1);
  return new Set(kept.length ? kept : all);
}

/** Jaccard sobre tokens significativos: 1 = mismo angulo con otras palabras. */
export function angleSimilarity(a, b) {
  const A = angleTokens(a);
  const B = angleTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * `${scheduled_for}-${slugify(angle)}`, desambiguando con sufijo numerico si el
 * id ya esta tomado. **Reserva el id en `taken`** (Set), asi llamadas sucesivas
 * no vuelven a chocar.
 */
export function assignId(scheduledFor, angle, taken = new Set()) {
  const base = `${scheduledFor}-${slugify(angle) || "item"}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Filtra y normaliza los items crudos del modelo.
 *
 * Descarta: campos faltantes, formato inexistente o deshabilitado, fecha
 * invalida o fuera de [from, to], frases prohibidas de la marca y angulos que
 * repiten uno ya usado (o uno del mismo lote).
 *
 * @returns {{ items: object[], dropped: {reason: string, detail: string, raw: any}[] }}
 */
export function normalizeItems(raw, { cfg, from, to, takenIds = [], usedAngles = [], similarity = 0.6 } = {}) {
  const allowed = new Set(enabledFormats(cfg));
  const never = cfg?.brand?.never ?? [];
  const languages = cfg?.brand?.languages ?? [];
  // Reparto de idiomas segun brand.languageMix: el modelo elegia casi siempre el
  // default, y el usuario publica sobre todo en espanol. scaleMix ya sabe repartir
  // un total entre pesos, asi que se reusa.
  const langQuota = languageQuota(cfg, Array.isArray(raw) ? raw.length : 0);
  const defaultLanguage = cfg?.brand?.defaultLanguage ?? "en";
  const taken = new Set(takenIds instanceof Set ? takenIds : takenIds ?? []);
  const seenAngles = [...usedAngles];

  const items = [];
  const dropped = [];
  const drop = (reason, detail, r) => dropped.push({ reason, detail, raw: r });

  for (const r of Array.isArray(raw) ? raw : []) {
    if (!r || typeof r !== "object") {
      drop("invalido", "el item no es un objeto", r);
      continue;
    }
    const angle = str(r.angle);
    const message = str(r.message);
    const format = str(r.format).toLowerCase();
    const scheduledFor = str(r.scheduled_for ?? r.date ?? r.scheduledFor);

    if (!angle || !message) {
      drop("incompleto", `falta angle o message (${scheduledFor || "sin fecha"} ${format})`, r);
      continue;
    }
    if (!allowed.has(format)) {
      drop("formato", `"${format || "vacio"}" no existe en cfg.formats o esta deshabilitado — ${angle}`, r);
      continue;
    }
    if (!isIsoDate(scheduledFor)) {
      drop("fecha", `"${scheduledFor}" no es YYYY-MM-DD — ${angle}`, r);
      continue;
    }
    if (scheduledFor < from || scheduledFor > to) {
      drop("fecha", `${scheduledFor} cae fuera de ${from}..${to} — ${angle}`, r);
      continue;
    }
    const banned = findBannedPhrase(`${angle} ${message}`, never);
    if (banned) {
      drop("prohibido", `usa "${banned}" (cfg.brand.never) — ${angle}`, r);
      continue;
    }
    const twin = seenAngles.find((prev) => angleSimilarity(prev, angle) >= similarity);
    if (twin !== undefined) {
      drop("repetido", `"${angle}" repite "${twin}"`, r);
      continue;
    }

    // La cuota gobierna el reparto, pero no pisa una sugerencia valida del modelo.
    const language = takeFromQuota(langQuota, languages, defaultLanguage, str(r.language));
    items.push({
      id: assignId(scheduledFor, angle, taken),
      scheduled_for: scheduledFor,
      format,
      language,
      angle,
      message,
    });
    seenAngles.push(angle);
  }

  return { items, dropped };
}

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

// ---------------------------------------------------------------------------
// Prompts. Puros.
// ---------------------------------------------------------------------------

export function brandSystemPrompt(cfg) {
  const b = cfg?.brand ?? {};
  const never = (b.never ?? []).map((p) => `  - "${p}"`).join("\n");
  return [
    `Sos el estratega de contenido de ${b.name ?? "la marca"} (${b.site ?? ""}).`,
    `Audiencia: ${dot(b.audience ?? "desconocida")}`,
    `Voz: ${dot(b.voice ?? "directa y tecnica")}`,
    b.nameUsage ? `Como se escribe el nombre de marca: ${dot(b.nameUsage)}` : null,
    "Escribis como quien usa el producto todos los dias, no como un departamento de marketing.",
    never ? `Frases prohibidas (nunca, en ningun idioma, ni parafraseadas):\n${never}` : "",
    "Nada de adjetivos vacios ni promesas: hechos, numeros y cosas que se pueden ver funcionando.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Cierra una frase con un solo punto (cfg.brand.voice a veces ya trae el suyo). */
function dot(s) {
  const t = String(s).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function buildPlanPrompt({ cfg, slots, from, to, usedAngles = [], knowledge = "", retry = false } = {}) {
  const b = cfg?.brand ?? {};
  const formats = cfg?.formats ?? {};
  const recent = usedAngles.slice(-150);

  const formatLines = enabledFormats(cfg)
    .map((f) => `  - ${f}: ${describeFormat(formats[f])}`)
    .join("\n");

  const slotLines = slots
    .map((s, i) => `  ${i + 1}. { "scheduled_for": "${s.scheduled_for}", "format": "${s.format}" }`)
    .join("\n");

  const anglesBlock = recent.length
    ? recent.map((a) => `  - ${a}`).join("\n")
    : "  (ninguno todavia)";

  return [
    retry
      ? "Reintento: los items anteriores no sirvieron o no alcanzaron. Completa SOLO los slots de abajo."
      : `Planifica el calendario de contenido de ${b.name ?? "la marca"} entre ${from} y ${to}.`,
    "",
    "## Contexto de producto (lo unico que podes afirmar como cierto)",
    knowledge?.trim() ? knowledge.trim() : "(sin contexto disponible: no inventes features ni numeros)",
    "",
    "## Slots a cubrir",
    "Uno por uno, en este orden. La fecha y el formato ya estan decididos: no los cambies.",
    slotLines,
    "",
    "## Formatos y sus limites",
    formatLines,
    "",
    "## Angulos ya usados — NO los repitas",
    "Ni el mismo angulo, ni el mismo angulo con otras palabras, ni el mismo ejemplo.",
    "Si un angulo nuevo se parece a uno de esta lista, descartalo y pensa otro.",
    anglesBlock,
    "",
    "## Que es cada campo",
    '  - "angle": el gancho. De que va la pieza, en una linea. Es lo que hace que alguien pare de scrollear.',
    '  - "message": LA cosa que esa pieza tiene que comunicar, en UNA oracion afirmativa. Concreta y verificable.',
    `  - "language": uno de ${JSON.stringify(b.languages ?? ["en"])} (por defecto "${b.defaultLanguage ?? "en"}").`,
    `    La mayoria en "${b.defaultLanguage ?? "en"}"; usa los otros idiomas para algunas piezas, no traduzcas la misma.`,
    "",
    "## Reglas",
    "  - Un angulo distinto por pieza: cada una entra por un lado diferente del producto.",
    "  - Nada de generalidades sobre la industria. Producto concreto, problema concreto.",
    "  - Prohibido inventar features, numeros, clientes o precios que no esten en el contexto.",
    ...((b.never ?? []).length ? [`  - Prohibidas estas frases: ${JSON.stringify(b.never)}.`] : []),
    `  - Devolve exactamente ${slots.length} items, uno por slot, en el mismo orden.`,
    "",
    "## Salida",
    'Un objeto JSON: { "items": [ { "scheduled_for", "format", "language", "angle", "message" } ] }',
  ].join("\n");
}

function describeFormat(f = {}) {
  const bits = [];
  if (f.aspect) bits.push(f.aspect);
  if (f.slides) bits.push(`${f.slides} slides`);
  if (f.lengthSeconds) bits.push(`${f.lengthSeconds}s`);
  if (f.maxChars) bits.push(`hasta ${f.maxChars} caracteres`);
  return bits.length ? bits.join(", ") : "sin restricciones";
}

// ---------------------------------------------------------------------------

// Sin knowledge el calendario sale mas debil, pero planificar igual es mejor
// que no planificar: se avisa y se sigue.
function loadKnowledgeContext(store, note, brandId = null) {
  let ctx = "";
  try {
    ctx = knowledgeContext(store, { brandId }) ?? "";
  } catch (err) {
    note(`aviso: no se pudo leer el knowledge (${err?.message ?? err}); el calendario saldra mas generico`);
    return "";
  }
  if (!ctx.trim()) {
    note("aviso: el store no tiene knowledge todavia — corre `npm run sync` o el calendario saldra generico");
  }
  return ctx;
}
