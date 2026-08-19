// Generacion: convierte un item planificado en un entregable real.
//
// Tres fases, cada una marcada en el store:
//   planned -> briefed   el modelo escribe el brief (copy por escena/slide, cues, registro)
//           -> building  se materializa el entregable
//           -> built     asset_path + preview_path apuntan a archivos que existen
//
// Formatos:
//   text                 el brief ES el entregable -> content/<id>/post.md (una sola llamada al modelo)
//   image | carousel     proyecto HyperFrames + `snapshot` (PNG por slide)
//   video                proyecto HyperFrames + `render` (MP4) + frame de preview via ffmpeg
//
// El proyecto HyperFrames NO se inventa de cero: se clona del proyecto de referencia
// (cfg.hyperframes.referenceProject) su frame.md, su hyperframes.json y sus fuentes.
// frame.md es el sistema de diseno de marca; regenerarlo por pieza daria marcas
// inconsistentes, asi que se copia tal cual.
//
// index.html lo escribe ESTE modulo, no el modelo: ahi vive el contrato temporal
// (starts, durations, tracks, transiciones) y no se negocia. El modelo solo escribe
// las composiciones de escena bajo compositions/frames/.
//
// Antes de renderizar siempre corre `hyperframes check`: un render desperdicia
// minutos, un check falla en segundos y su salida vuelve al modelo como parche.

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, sep, dirname, relative } from "node:path";

import { conArchivos, extractJSON, imagenPng, runModeloChat, runModeloJSON, sinImagenes } from "./modelo.mjs";
import { LAYOUT_IDS, layoutCatalog, pantallaCompleta, renderLayout, validateSlots } from "./layouts.mjs";
import { META_DIR, rutaMeta, slugify } from "./config.mjs";


// Marcador que el modelo emite en vez de transcribir 140 KB de base64.
// Se declara aca porque HARD_RULES lo interpola al cargar el modulo.
export const FONT_MARKER = "/* @@BCA_FONTS@@ */";

// El marcador se llamaba asi antes del rename y esta escrito dentro de las
// composiciones ya generadas y del reference.html de cada marca. Se sigue
// aceptando al inyectar: un proyecto viejo tiene que recibir sus tipografias
// igual que siempre, sin regenerarlo.
const FONT_MARKER_VIEJO = "/* @@ADSAI_FONTS@@ */";

// ---------------------------------------------------------------------------
// Constantes de tiempo. Las duraciones no son gusto: `check` falla con
// `sweep_static` si una composicion de 3s+ no cambia geometria entre muestras,
// asi que las piezas quietas (imagen, slide) se mantienen cortas y sus reveals
// se reparten a lo largo de casi toda la ventana.
// ---------------------------------------------------------------------------

export const IMAGE_SCENE_SECONDS = 4;
export const CAROUSEL_SLIDE_SECONDS = 3;
export const SCENE_OVERLAP = 0.4; // cross-dissolve entre escenas de video
export const SETTLE_RATIO = 0.85; // en que punto de su ventana se fotografia un still

const CHECK_TIMEOUT_MS = 15 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;
const RENDER_TIMEOUT_MS = 45 * 60_000;
const FFMPEG_TIMEOUT_MS = 2 * 60_000;

// La reparacion de `check` es una conversacion: el modelo escribe, ve el
// resultado del check y ajusta. Estas son las vueltas y el gasto por defecto
// cuando la config no dice otra cosa (limits.repairTurns / repairTokenBudget).
export const DEFAULT_REPAIR_TURNS = 4;
export const DEFAULT_REPAIR_TOKEN_BUDGET = 600_000;

// Escalada cuando el mismo error bloqueante sobrevive vuelta tras vuelta.
// "Vistas" es cuantas veces un check lo reporto; la primera vez se repara, la
// segunda se repara diciendo que el arreglo anterior no sirvio, la tercera se
// descarta la escena y se recompone desde el brief, la cuarta se corta.
export const VISTAS_PARA_RECOMPONER = 3;
export const VISTAS_PARA_CORTAR = 4;

// Vueltas de revision visual (fotografiar, mirar, reparar con la foto) cuando
// la config no dice otra cosa (limits.reviewTurns). 0 apaga la revision.
export const DEFAULT_REVIEW_TURNS = 2;

const GSAP_FALLBACK_TAG =
  '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js" crossorigin="anonymous"></script>';

const LANGUAGE_NAMES = {
  en: "English",
  es: "Spanish (rioplatense, natural — not neutral-latino, not translated-sounding)",
  pt: "Brazilian Portuguese",
};

export class GenerateError extends Error {
  constructor(message, { phase, itemId } = {}) {
    super(message);
    this.name = "GenerateError";
    this.phase = phase;
    this.itemId = itemId;
  }
}

// ---------------------------------------------------------------------------
// Dependencias inyectables. El default es lo real; los tests pasan stubs para
// no llamar al modelo ni abrir un Chrome.
// ---------------------------------------------------------------------------

export function defaultDeps() {
  return {
    runModeloChat,
    runModeloJSON,
    hyperframes: runHyperframes,
    ffmpeg: extractFrame,
  };
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

/**
 * De que clase es un formato. El pipeline decide por esto, no por el nombre:
 * agregar "historia" o "reel" no deberia obligar a tocar seis `if` repartidos
 * por el archivo.
 *
 *   text   — el brief ES el entregable, sin render
 *   still  — una imagen
 *   slides — varias imagenes (carrusel)
 *   motion — video
 *
 * Los formatos que ya existian no declaran `kind`: se deduce del nombre.
 */
export function formatKind(format, formatCfg = {}) {
  if (formatCfg.kind) return String(formatCfg.kind);
  return { text: "text", image: "still", carousel: "slides", video: "motion" }[format] ?? "still";
}

/** ¿El lienzo es mas alto que ancho? Cambia como se compone. */
export function esVertical(formatCfg = {}) {
  const { width, height } = parseAspect(formatCfg.aspect ?? "1080x1080");
  return height > width;
}

/** Devuelve la config del formato o lanza. Un formato deshabilitado no se genera. */
export function validateFormat(cfg, format) {
  const formats = cfg?.formats ?? {};
  const f = format == null ? "" : String(format);
  if (!f || !Object.prototype.hasOwnProperty.call(formats, f)) {
    throw new GenerateError(
      `formato desconocido: ${JSON.stringify(format)} (validos: ${Object.keys(formats).join(", ") || "ninguno"})`,
    );
  }
  const spec = formats[f];
  if (!spec || spec.enabled === false) {
    throw new GenerateError(`formato deshabilitado en brand-content-ai.config.json: ${f}`);
  }
  return spec;
}

/** "1080x1350" -> { width: 1080, height: 1350 } */
export function parseAspect(aspect) {
  const m = /^\s*(\d{2,5})\s*[xX×]\s*(\d{2,5})\s*$/.exec(String(aspect ?? ""));
  if (!m) throw new GenerateError(`aspect invalido: ${JSON.stringify(aspect)} (esperado "AxB", ej "1080x1350")`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Numero corto y estable para meter en HTML (evita 4.900000000000001). */
export function fmt(n) {
  return Number(Number(n).toFixed(3));
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function str(v) {
  return v == null ? "" : String(v).trim();
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Concurrencia acotada, preservando el orden de los resultados. */
export async function mapLimit(items, limit, fn) {
  const list = [...items];
  const n = Math.max(1, Math.floor(Number(limit) || 1));
  const out = new Array(list.length);
  let next = 0;
  const workers = new Array(Math.min(n, list.length)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Bloque de conocimiento verificable para inyectar en los prompts.
 * Todo hecho o numero que aparezca en el contenido tiene que salir de aca:
 * es marketing publico, no hay margen para inventar.
 */
export function knowledgeBlock(store, { maxChars = 9000, brandId = null } = {}) {
  // Solo el conocimiento de ESTA marca: mezclar fuentes de dos marcas es la
  // forma mas rapida de publicar un hecho de una en la voz de la otra.
  const rows = store.allKnowledge(brandId).filter((k) => k.digest);
  const parts = [];
  for (const k of rows) {
    const sha = String(k.fingerprint ?? k.head_sha ?? "").slice(0, 7);
    const lines = [`### ${k.label ?? k.source_id}${sha ? ` (@${sha})` : ""}`, str(k.digest)];
    const facts = asArray(k.facts).filter((f) => f && (f.claim ?? f.Claim));
    if (facts.length) {
      lines.push("", "Citable facts:");
      for (const f of facts) {
        const claim = str(f.claim ?? f.Claim);
        const source = str(f.source ?? f.Source);
        if (claim) lines.push(`- ${claim}${source ? ` [${source}]` : ""}`);
      }
    }
    parts.push(lines.join("\n"));
  }
  const joined = parts.join("\n\n---\n\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n\n[...truncado]` : joined;
}

/** Sin knowledge no hay hechos citables, y sin hechos no se publica nada. */
export function requireKnowledge(store, brandId = null) {
  const block = knowledgeBlock(store, { brandId });
  if (!block.trim()) {
    throw new GenerateError(
      `no hay conocimiento sincronizado${brandId ? ` para la marca ${brandId}` : ""}: ` +
        "corre el sync de sus fuentes antes de generar (todo hecho publicado tiene que salir de ahi)",
    );
  }
  return block;
}

export function projectDirFor(cfg, itemId) {
  return join(cfg.hyperframes.projectsDir, itemId);
}

export function contentDirFor(cfg, itemId) {
  return join(cfg.paths.content, itemId);
}

/** Rutas ordenadas de los slides de un carrusel, para que telegram.mjs no adivine. */
export function carouselSlidePaths(dir, n) {
  return Array.from({ length: n }, (_, i) => join(dir, `slide-${String(i + 1).padStart(2, "0")}.png`));
}

/** El tag de GSAP (version + integrity) sale del proyecto de referencia, no de memoria. */
export function extractGsapTag(referenceIndexHtml) {
  const m = /<script\b[^>]*\bsrc="[^"]*gsap[^"]*"[^>]*><\/script>/i.exec(String(referenceIndexHtml ?? ""));
  return m ? m[0] : GSAP_FALLBACK_TAG;
}

/** Reparte `total` segundos entre N escenas respetando las proporciones pedidas. */
export function distributeDurations(durations, total, { min = 2, max = 12 } = {}) {
  const n = durations.length;
  if (n === 0) return [];
  let base = durations.map((d) => {
    const v = Number(d);
    return Number.isFinite(v) && v > 0 ? clamp(v, min, max) : total / n;
  });
  const sum = base.reduce((a, b) => a + b, 0) || n;
  base = base.map((d) => (d / sum) * total);
  const out = base.map((d) => Math.round(d * 10) / 10);
  const drift = Math.round((total - out.reduce((a, b) => a + b, 0)) * 10) / 10;
  out[n - 1] = Math.round((out[n - 1] + drift) * 10) / 10;
  return out;
}

/**
 * Contrato temporal de la pieza: ids, archivos, starts, durations y tracks.
 * Puro: el mismo brief da siempre el mismo layout.
 */
export function planScenes({ format, formatCfg, brief, itemId }) {
  const { width, height } = parseAspect(formatCfg.aspect);
  const used = new Set();
  const mkId = (i, label) => {
    const base = slugify(label || `scene-${i + 1}`, 28) || `scene-${i + 1}`;
    let id = `${String(i + 1).padStart(2, "0")}-${base}`;
    let bump = 2;
    while (used.has(id)) id = `${String(i + 1).padStart(2, "0")}-${base}-${bump++}`;
    used.add(id);
    return id;
  };

  const kind = formatKind(format, formatCfg);
  let raw;
  if (kind === "still") {
    raw = [{ label: brief?.concept || brief?.display_line || itemId, duration: IMAGE_SCENE_SECONDS }];
  } else if (kind === "slides") {
    const slides = asArray(brief?.slides);
    raw = slides.map((s, i) => ({
      label: s?.role || s?.display_line || `slide-${i + 1}`,
      duration: CAROUSEL_SLIDE_SECONDS,
    }));
  } else if (kind === "motion") {
    const scenes = asArray(brief?.scenes);
    raw = scenes.map((s, i) => ({
      label: s?.id || s?.title || `scene-${i + 1}`,
      duration: Number(s?.duration),
      focal: s?.focal === true,
    }));
  } else {
    throw new GenerateError(`planScenes no aplica al formato ${format}`);
  }

  if (raw.length === 0) throw new GenerateError(`el brief no trajo escenas para el formato ${format}`);

  const overlapped = kind === "motion";
  const total =
    kind === "motion"
      ? Number(formatCfg.lengthSeconds) || raw.reduce((a, s) => a + (Number(s.duration) || 4), 0)
      : raw.reduce((a, s) => a + s.duration, 0);

  const durations =
    kind === "motion" ? distributeDurations(raw.map((s) => s.duration), total) : raw.map((s) => s.duration);

  const scenes = [];
  let cursor = 0;
  for (let i = 0; i < raw.length; i++) {
    const d = durations[i];
    const last = i === raw.length - 1;
    const compId = mkId(i, raw[i].label);
    scenes.push({
      index: i,
      compId,
      file: `compositions/frames/${compId}.html`,
      start: fmt(cursor),
      hold: fmt(d), // cuanto dura el contenido propio de la escena
      duration: fmt(overlapped && !last ? d + SCENE_OVERLAP : d),
      trackIndex: overlapped ? i % 2 : 0,
      snapshotAt: fmt(cursor + d * SETTLE_RATIO),
      focal: raw[i].focal === true,
    });
    cursor = fmt(cursor + d);
  }

  return { format, kind, width, height, total: fmt(total), overlapped, scenes };
}

/** Momento representativo del video para el preview de Telegram. */
/**
 * En que segundo sacar el frame que representa al video.
 *
 * Manda lo que pidio el brief, despues la escena marcada como focal. Si no hay
 * ninguna, la escena MAS LARGA — no la del medio: la del medio puede ser un
 * respiro de dos segundos y el preview termina siendo un rectangulo negro, que
 * es justo lo que se ve en Telegram antes de abrir el video.
 *
 * El instante es el 85% de la escena, igual que en las imagenes: para entonces
 * la animacion ya asento y se ve la composicion completa.
 */
export function pickPreviewTime(brief, plan) {
  const total = plan.total;
  const asked = Number(brief?.preview_at_seconds);
  if (Number.isFinite(asked) && asked > 0 && asked < total) return fmt(clamp(asked, 0.2, total - 0.2));

  const focal = plan.scenes.find((s) => s.focal);
  const masLarga = [...plan.scenes].sort((a, b) => b.hold - a.hold)[0];
  const s = focal ?? masLarga ?? plan.scenes[0];
  return fmt(clamp(s.start + s.hold * SETTLE_RATIO, 0.2, total - 0.2));
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function brandBlock(brand) {
  const b = brand ?? {};
  const never = asArray(b.never);
  return [
    `Brand: ${b.name}${b.site ? ` (${b.site})` : ""}`,
    // El casing del nombre no puede ir en `never`: ese filtro ignora mayusculas y
    // tumbaria tambien la forma correcta. Va como instruccion explicita.
    b.nameUsage ? `How to write the brand name: ${b.nameUsage}` : "",
    `Audience: ${b.audience ?? "—"}`,
    `Voice: ${b.voice ?? "—"}`,
    never.length ? `Banned phrases (never write these, or anything in that register): ${never.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function feedbackBlock(item) {
  if (!item.feedback) return "";
  return [
    "## REJECTION FEEDBACK — THIS IS THE POINT OF THIS RUN",
    "",
    `A previous attempt (revision ${item.revision ?? 0}) was rejected by the reviewer with this feedback:`,
    "",
    `> ${String(item.feedback).split(/\r?\n/).join("\n> ")}`,
    "",
    "This is not a suggestion. The whole reason this piece is being made again is that feedback.",
    "Rules:",
    "- Change what the feedback asks to change. Do not re-ship the same idea with new words.",
    "- Do not silently drop the rest of the brief while fixing it.",
    "- You MUST return a `feedback_addressed` field: one concrete paragraph naming what you changed",
    "  and where it shows up in this piece. Vague restatements of the feedback are a failed run.",
  ].join("\n");
}

function formatSpecBlock(format, formatCfg) {
  const vertical = esVertical(formatCfg)
    ? " It is a vertical, full-screen piece: it will be watched on a phone, one hand, thumb ready to skip."
    : "";
  switch (formatKind(format, formatCfg)) {
    case "text":
      return `Format: text post. Hard cap ${formatCfg.maxChars} characters for the body (that is a hard cap, not a target).`;
    case "still":
      return `Format: single still image, ${formatCfg.aspect}.${vertical}`;
    case "slides":
      return `Format: carousel, ${formatCfg.slides} slides, ${formatCfg.aspect} each. Exactly ${formatCfg.slides}, no more, no fewer.${vertical}`;
    case "motion":
      return (
        `Format: video, ${formatCfg.aspect}, ${formatCfg.lengthSeconds} seconds total. ` +
        `No voiceover — the on-screen cues are the narration.${vertical}`
      );
    default:
      return `Format: ${format}`;
  }
}

function briefSchema(format, formatCfg) {
  const common = [
    '  "facts_used": ["<verbatim fact from the knowledge block, one per claim you make>"],',
    '  "feedback_addressed": "<required ONLY if rejection feedback was given above>"',
  ];
  switch (formatKind(format, formatCfg)) {
    case "text":
      return [
        "{",
        '  "headline": "<first line, <= 90 chars, no emoji, no hashtag>",',
        `  "body": "<the finished post, markdown, <= ${formatCfg.maxChars} chars including the headline. This IS the deliverable.>",`,
        '  "hashtags": ["<up to 3, lowercase, no generic ones>"],',
        ...common,
        "}",
      ].join("\n");
    case "still":
      return [
        "{",
        '  "concept": "<one line: what the frame IS, as a picture>",',
        '  "register": "dark" ,',
        '  "kicker": "<optional mono eyebrow, UPPERCASE, <= 28 chars>",',
        '  "display_line": "<the one big lowercase line, <= 46 chars — this is the frame>",',
        '  "support_line": "<optional second line, <= 90 chars>",',
        '  "accent_word": "<a word inside display_line or support_line that carries the lime accent>",',
        '  "caption": "<the post caption that ships with the image, <= 300 chars>",',
        ...common,
        "}",
      ].join("\n");
    case "slides":
      return [
        "{",
        '  "concept": "<one line: the arc across the slides>",',
        '  "slides": [',
        "    {",
        `      "n": 1, "role": "<hook|problem|mechanism|proof|objection|cta>",`,
        '      "register": "dark",',
        '      "kicker": "<optional mono eyebrow, UPPERCASE, <= 28 chars>",',
        '      "display_line": "<the big lowercase line, <= 42 chars>",',
        '      "support_line": "<optional, <= 110 chars>",',
        '      "accent_word": "<word that takes the lime accent>"',
        "    }",
        `    // exactly ${formatCfg.slides} entries, n = 1..${formatCfg.slides}`,
        "  ],",
        '  "caption": "<the post caption, <= 300 chars>",',
        ...common,
        "}",
      ].join("\n");
    case "motion":
      return [
        "{",
        '  "concept": "<one line: the arc of the 40 seconds>",',
        '  "scenes": [',
        "    {",
        '      "id": "<short kebab id, e.g. the-ask>",',
        '      "title": "<what this scene is>",',
        '      "duration": 4.5,',
        '      "register": "dark",',
        '      "on_screen": ["<cue 1>", "<cue 2>"],',
        '      "focal": false,',
        '      "note": "<what has to be TRUE on screen: the object, the layout, the beat>"',
        "    }",
        "    // 5 to 8 scenes; durations should sum to roughly the total, they get normalized anyway",
        "  ],",
        '  "preview_at_seconds": <the single second of the video that best sells it as a thumbnail>,',
        '  "caption": "<the post caption, <= 300 chars>",',
        ...common,
        "}",
      ].join("\n");
    default:
      return "{}";
  }
}

/**
 * Prompt del brief. El feedback de un rechazo entra SIEMPRE aca y arriba de todo:
 * es la funcion "no me gusto, hacelo de nuevo", y si el segundo intento lo ignora
 * el sistema entero no sirve.
 */
export function buildBriefPrompt({ cfg, brand, item, formatCfg, knowledge, complaint } = {}) {
  const lang = LANGUAGE_NAMES[item.language] ?? item.language ?? "English";
  const fb = feedbackBlock(item);
  return [
    `You are the creative director for ${brand?.name ?? "this brand"}. You write the brief that another`,
    "agent will execute literally. Be concrete: no mood words, no 'engaging visuals'.",
    "",
    "# Brand",
    brandBlock(brand),
    "",
    "# Verified knowledge — the ONLY source of facts",
    "This is public marketing. Every claim, number, feature name and price you write MUST come from",
    "the block below, verbatim in meaning. If something is not here, it does not exist and you do not",
    "say it. When in doubt, say less.",
    "",
    knowledge,
    "",
    "# The piece",
    `- id: ${item.id}`,
    `- scheduled for: ${item.scheduled_for}`,
    `- angle (the hook): ${item.angle}`,
    `- message (the ONE thing it must land): ${item.message}`,
    `- language of every word on screen and in the copy: ${lang}`,
    `- revision: ${item.revision ?? 0}`,
    formatSpecBlock(item.format, formatCfg),
    "",
    fb,
    "# Output",
    "Return exactly this JSON shape (comments in the schema are not part of the output):",
    "",
    briefSchema(item.format, formatCfg),
    "",
    complaint ? `# The previous attempt was rejected by the validator\n${complaint}\nFix exactly that.` : "",
  ]
    .filter((s) => s !== undefined && s !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const HARD_RULES = [
  "HARD RULES — these were verified against a real render; breaking any of them breaks the render:",
  "1. The composition root carries data-composition-id, data-start, data-duration, data-width, data-height.",
  "2. The full-bleed background lives on a layer with class=\"clip\", NEVER on #root.",
  "3. The animation is ONE paused GSAP timeline registered as window.__timelines[\"<composition-id>\"].",
  "4. FORBIDDEN: repeat, yoyo, Math.random, Date.now, new Date, CSS transition, CSS @keyframes,",
  "   requestAnimationFrame loops. The renderer seeks frame by frame; any of those desynchronise it.",
  "5. Hidden initial states use an IMMEDIATE gsap.set(...), never tl.set(..., 0). A zero-duration set",
  "   at position 0 does not apply when the playhead sits exactly on 0, and the element shows up on frame 0.",
  "6. Entrances use fromTo (or set + to), so seeking to any time lands on the right state.",
  "7. Do not let the reveal finish in the first third and then hold a frozen frame: `check` fails a",
  "   composition whose geometry never changes across its samples. Spread the reveals, or keep one",
  "   small element genuinely alive (a caret, a hairline) for the hold.",
  "8. Every px value is authored against the composition's own canvas size. No vh/vw, no media queries.",
  "8c. FILL THE CANVAS HORIZONTALLY TOO. Content crammed against the left edge with the right",
  "    half empty fails the same check. Use both halves: a two-column split, a wide rule, a panel",
  "    that spans the measure. The content must span at least 55% of the canvas WIDTH.",
  "8d. NOTHING TOUCHES THE EDGE. Keep a safe margin of at least 5% of the canvas on all four",
  "    sides for anything with text: on 1080px wide that is ~54px. A headline that reaches the",
  "    right edge is not dramatic, it is clipped — the renderer crops at the canvas, mid-glyph.",
  "    If the display line does not fit, step DOWN one level of the type ramp in frame.md or",
  "    break it into two lines; never let it run past the safe area. Full-bleed is only for",
  "    background fills and rules, never for type.",
  "8b. FILL THE CANVAS VERTICALLY. This is the single most common failure: composing for 16:9 habits",
  "    and leaving the bottom half of a tall canvas empty. The content block must span from roughly",
  "    12% to at least 80% of the canvas HEIGHT — or be optically centred with balanced margins.",
  "    On a 1080x1350 canvas that means the last element's bottom edge sits near y=1080, not y=600.",
  "    Do not solve it by inflating type past the frame.md ramp: add breathing room between blocks,",
  "    let the supporting line sit lower, and give the beat its own vertical space.",
  `9. No network: no <link> to fonts, no CDN images, no Google Fonts. Emit ${FONT_MARKER} and stop.`,
  "10. Every element that carries data-start / data-track-index, and every element the timeline animates,",
  "    needs a stable human-readable id (id=\"hero-line\", id=\"slide-2-stat\"). The linter warns without it",
  "    and a repair pass has nothing to aim at.",
  "11. ANIMATE TRANSFORMS ONLY: x, y, scale, rotation, skew, opacity, clipPath, filter and",
  "    color/background-color. FORBIDDEN as tween targets: letterSpacing, wordSpacing, fontSize,",
  "    lineHeight, width, height, margin, padding, top/left/right/bottom, borderWidth — they reflow",
  "    text and snap to integer device pixels, and `check` fails them as gsap_non_transform_motion,",
  "    which is an ERROR, not a warning. For a growing rule animate scaleX with transform-origin.",
  "11b. Per-character spans are a LAST RESORT, only for a real tracking effect, and never for a",
  "    plain fade-in — a headline animates fine as one element. If you do split it, every WORD must",
  "    be wrapped in its own span with white-space:nowrap and display:inline-block around the",
  "    letters: with bare per-letter spans the browser breaks the line MID-WORD and the headline",
  "    renders as 'ten es' instead of 'tenes'. Words break between words, never inside one.",
  "12. NO OVERLAPPING TEXT. Two text blocks whose boxes intersect fail `check` as content_overlap",
  "    (another error, not a warning). Give each block its own horizontal band or its own column,",
  "    and remember a block occupies its whole line-height, not just the glyphs.",
  "12b. The one legitimate overlap is a display headline set in several line spans with tight",
  "    leading (line-height under 1): those boxes DO intersect by design. Set each line as its own",
  "    element with display:block and put data-layout-allow-overlap on it — that is what the",
  "    attribute is for. Do not fix that case by loosening the leading or shrinking the type.",
].join("\n");

// El modelo NO transcribe las fuentes: 140 KB de base64 son ~35k tokens de salida,
// lentos, caros y faciles de corromper con un solo caracter. En la primera corrida
// real el modelo intento sortearlo escribiendo _part1.html/_part2.html y un
// _concat.js, y nunca produjo la composicion. Emite este marcador y lo cambiamos
// aca: deterministico, gratis e imposible de transcribir mal.

export function injectFonts(html, fontCss) {
  if (!fontCss) return html;
  for (const marcador of [FONT_MARKER, FONT_MARKER_VIEJO]) {
    if (html.includes(marcador)) return html.split(marcador).join(fontCss);
  }
  // El modelo se olvido del marcador: lo metemos al abrir el primer <style>.
  const m = html.match(/<style[^>]*>/i);
  if (!m) return html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + "\n" + fontCss + "\n" + html.slice(at);
}

// ---------------------------------------------------------------------------
// Compose: elegir un layout por escena y rellenar sus huecos
// ---------------------------------------------------------------------------
//
// El modelo NO escribe HTML de escena. Elige, para cada escena, uno de los
// layouts prefabricados de layouts.mjs y dice que va en cada hueco (kicker,
// display, cues, stat...) usando el copy del brief; el codigo renderiza. Es el
// reparto que ya rige para la marca ("el modelo decide los valores, el codigo
// arma el archivo") llevado a la escena: cuando el modelo escribia 300 lineas
// de HTML+GSAP a ciegas salian palabras partidas, mitades vacias, numeros que
// no aparecian. La maquetacion ya esta resuelta una vez, para todas las marcas.

/** El copy de cada escena, tal como lo fijo el brief, para el planificador. */
function sceneCopyBlock(format, brief, plan, scenes) {
  const lines = [];
  for (const s of scenes) {
    const src =
      plan.kind === "slides"
        ? asArray(brief.slides)[s.index] ?? {}
        : plan.kind === "motion"
          ? asArray(brief.scenes)[s.index] ?? {}
          : brief;
    lines.push(`### scene ${s.index + 1} of ${plan.scenes.length} — file: ${s.file}`);
    lines.push(plan.kind === "motion" ? `- on screen for ${s.hold}s` : "- a still frame");
    lines.push(`- suggested register: ${str(src.register) || "dark"}`);
    if (src.kicker) lines.push(`- kicker: ${str(src.kicker)}`);
    if (src.display_line) lines.push(`- display line: ${str(src.display_line)}`);
    if (src.support_line) lines.push(`- support line: ${str(src.support_line)}`);
    if (src.accent_word) lines.push(`- accent word: ${str(src.accent_word)}`);
    if (src.title) lines.push(`- scene: ${str(src.title)}`);
    if (src.role) lines.push(`- role in the arc: ${str(src.role)}`);
    const cues = asArray(src.on_screen).map(str).filter(Boolean);
    if (cues.length) {
      lines.push("- on-screen cues, IN ORDER:");
      for (const c of cues) lines.push(`    * ${c}`);
    }
    if (src.note) lines.push(`- direction: ${str(src.note)}`);
    if (s.focal) lines.push("- FOCAL scene: the moment the piece is about");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Lo que la pieza dice ademas de estas escenas, en una linea por escena, para
 * que una recomposicion parcial no repita el layout de la vecina.
 */
function otrasEscenasBlock(brief, plan, scenes, layoutPlan = {}) {
  const otras = plan.scenes.filter((s) => !scenes.includes(s));
  if (!otras.length) return [];
  return [
    "# The other scenes of the piece (already staged — do not restage them, do not repeat their layout right next to yours)",
    ...otras.map((s) => {
      const src = plan.kind === "slides" ? asArray(brief.slides)[s.index] ?? {} : plan.kind === "motion" ? asArray(brief.scenes)[s.index] ?? {} : brief;
      const usado = layoutPlan[s.file]?.layout;
      return `- scene ${s.index + 1}: ${str(src.title || src.display_line || src.role || "")}${usado ? `  (layout: ${usado})` : ""}`;
    }),
    "",
  ];
}

/**
 * Avisos de escenas rechazadas (layout flojo, check estancado), SOLO de las
 * que esta llamada va a componer. El resto no tiene por que enterarse.
 */
function layoutNotesBlock(scenes, layoutNotes = {}) {
  const entries = scenes.filter((s) => layoutNotes[s.file]).map((s) => [s.file, String(layoutNotes[s.file])]);
  if (!entries.length) return [];
  return [
    "# Fix this first",
    ...entries.map(([file, note]) => `The previous staging of ${file} was rejected:\n${note}\nChoose a DIFFERENT layout for it this time.`),
    "",
  ];
}

/**
 * El playbook: en positivo, que hace que una pieza se lea bien. Antes el prompt
 * de compose tenia doce prohibiciones y ningun patron; el modelo sabia que no
 * hacer y no que era bueno.
 */
const PLAYBOOK = [
  "# How to stage (the playbook)",
  "- ONE display moment per scene. `display` is the line that carries it — short (aim <= 45 chars, hard",
  "  limit 70), in the copy's own words, lowercase unless it is a proper noun. Everything else supports it.",
  "- The arc: scene 1 is the hook (hero or statement); the last scene is the close (cta); the FOCAL scene",
  "  is statement or stat. In between, vary: never the same layout twice in a row, and a piece of 5+ scenes",
  "  uses at least 3 different layouts.",
  "- stat ONLY when the copy has a real figure (a price, a count, a time). Put the figure alone in stat.value",
  "  (<= 8 chars: '5 min', '$29', '3x', '0') and what it measures in stat.label. Never invent a number.",
  "- cues when the scene is narrated in beats — the on-screen cues of a video scene: 2-4 short cues, in the",
  "  given order, one idea each. `display` is the headline of the beat: the scene title, or the first cue if",
  "  that IS the headline (then do not repeat it as a cue).",
  "- split for 2-4 label/value facts (what you get, the terms). steps for a process (how it works).",
  "- accent_word: exactly one word — or a two-word phrase — that appears VERBATIM in display and carries the",
  "  meaning ('backend', '5 minutos', 'sin tarjeta'). Never a filler word. Empty is fine.",
  "- kicker: optional mono eyebrow, UPPERCASE, <= 28 chars, naming the section (WHAT YOU GET, THE PRICE,",
  "  HOW IT WORKS). Same language as the copy. Use it consistently across the piece or not at all.",
  "- register: 'dark' or 'light' per scene. Keep the brief's suggestion unless a light scene between dark",
  "  ones gives the piece a breath at the right moment (the focal scene, the close). Never at random.",
  "- Do not invent copy. Every string comes from the brief's copy for that scene: you may shorten a line to",
  "  fit a slot, split a sentence into cues, or pull a figure out of a sentence; you may NOT add a claim,",
  "  a number or a name that is not there. Keep the copy's language.",
];

/**
 * Prompt del planificador de layouts: catalogo, playbook, el copy de las
 * escenas a componer, y el JSON que se espera. Una llamada por lote de escenas
 * pendientes (normalmente, todas).
 */
export function buildLayoutPlanPrompt({ brand, item, formatCfg, brief, plan, only, layoutNotes = {}, layoutPlan = {}, complaint = "" } = {}) {
  const scenes = Array.isArray(only) && only.length ? only : plan.scenes;
  const lang = LANGUAGE_NAMES[item?.language] ?? item?.language ?? "English";
  return [
    `You are staging a ${item?.format ?? plan.kind} piece for ${brand?.name ?? "the brand"}: ${plan.width}x${plan.height}, ${plan.scenes.length} scene(s).`,
    "The copy is fixed by the brief. Your job: choose ONE layout per scene from the catalog and fill its slots.",
    "You are not writing HTML — the layouts are prefabricated and already solve typography, spacing, safe",
    "areas and motion for this brand. Answer with JSON only.",
    "",
    ...(complaint
      ? ["# Your previous answer was rejected", complaint, "Fix exactly that and answer again.", ""]
      : []),
    ...layoutNotesBlock(scenes, layoutNotes),
    "# Layout catalog",
    layoutCatalog(),
    "",
    ...PLAYBOOK,
    "",
    `Language of every string: ${lang}. Concept of the piece: ${str(brief?.concept) || str(brief?.display_line) || "-"}`,
    "",
    "# The scenes to stage and their copy",
    sceneCopyBlock(item?.format, brief, plan, scenes),
    ...otrasEscenasBlock(brief, plan, scenes, layoutPlan),
    "# Answer — JSON only, this exact shape",
    "{",
    '  "scenes": [',
    "    {",
    `      "file": "<exactly as listed above>",`,
    `      "layout": "<${LAYOUT_IDS.join("|")}>",`,
    '      "register": "dark|light",',
    '      "kicker": "<optional>", "display": "<required>", "accent_word": "<optional>", "support": "<optional>",',
    '      "cues": ["..."],                       // cues layout only, 2-4',
    '      "rows": [{"label": "", "value": ""}],  // split layout only, 2-4',
    '      "steps": [{"title": "", "text": ""}],  // steps layout only, 2-4',
    '      "stat": {"value": "", "label": ""},    // stat layout only',
    '      "cta": {"line": "", "url": ""}         // cta layout only; url = the brand site or empty',
    "    }",
    "  ]",
    "}",
    `One entry per file listed above (${scenes.length}), same order. Include only the slots the chosen layout uses.`,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join("\n");
}

/**
 * Valida lo que devolvio el planificador contra el plan y los layouts. Lanza
 * con el detalle exacto (que archivo, que hueco) para poder reclamarselo.
 * Devuelve Map<file, { layout, slots }>.
 */
export function parseLayoutPlan(data, { plan, only } = {}) {
  const scenes = Array.isArray(only) && only.length ? only : plan.scenes;
  if (!data || typeof data !== "object" || !Array.isArray(data.scenes)) {
    throw new Error('la respuesta debe ser un objeto con "scenes": [...]');
  }
  const porArchivo = new Map();
  for (const entry of data.scenes) {
    const f = normalizePath(entry?.file);
    const scene = scenes.find((s) => normalizePath(s.file) === f) ?? scenes.find((s) => f && normalizePath(s.file).endsWith(`/${f.split("/").pop()}`));
    if (scene) porArchivo.set(scene.file, entry);
  }
  const errs = [];
  const out = new Map();
  let anterior = null;
  for (const s of scenes) {
    const e = porArchivo.get(s.file);
    if (!e) {
      errs.push(`falta la escena ${s.file}`);
      continue;
    }
    const layout = str(e.layout);
    const problemas = validateSlots(layout, e);
    if (problemas.length) errs.push(`${s.file}: ${problemas.join("; ")}`);
    if (anterior && anterior === layout && scenes.length > 2) errs.push(`${s.file}: repite el layout ${layout} de la escena anterior; variar`);
    anterior = layout;
    const { file: _f, layout: _l, ...slots } = e;
    out.set(s.file, { layout, slots });
  }
  if (errs.length) throw new Error(errs.join(" | "));
  return out;
}

/** El plan de layouts guardado en el proyecto, para saber que layout tiene cada escena. */
export function readLayoutPlan(projectDir) {
  const f = rutaMeta(projectDir, "layout-plan.json");
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

function writeLayoutPlan(projectDir, planDeLayouts) {
  const out = rutaMeta(projectDir, "layout-plan.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(planDeLayouts, null, 2));
}

/**
 * Un finding, para el modelo. Sin el `[severity]` de adelante: la seccion en la
 * que aparece ya dice si bloquea o no.
 */
function findingParaPrompt(f, i) {
  const donde = [f.codigo, [f.t ? `at t=${f.t}` : "", f.selector ? `selector \`${f.selector}\`` : ""].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" ");
  return [
    `${i + 1}. ${f.file || "(file not reported)"}`,
    `   ${donde}${f.mensaje ? ` — ${f.mensaje}` : ""}`,
    ...(f.fix ? [`   fix: ${f.fix}`] : []),
  ].join("\n");
}

/** Dos rutas hablan del mismo archivo si coinciden normalizadas o por nombre. */
function mismoArchivo(a, b) {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const base = (p) => p.split("/").pop();
  return na.endsWith(`/${base(nb)}`) || nb.endsWith(`/${base(na)}`);
}

/**
 * Los archivos del plan que tienen algun error bloqueante en este dictamen.
 * El linter reporta la ruta relativa al proyecto; se compara normalizada y,
 * si no coincide exacto, por nombre de archivo.
 */
export function archivosBloqueados(plan, check) {
  const out = [];
  for (const s of plan.scenes) {
    if ((check?.bloqueantes ?? []).some((f) => mismoArchivo(f.file, s.file))) out.push(s.file);
  }
  return out;
}

/** Bloque "que bloquea / que no": comun a la apertura y a cada vuelta. */
function bloqueDictamen(plan, check, { historia = {} } = {}) {
  const bloq = check.bloqueantes;
  const sec = check.secundarios;
  const out = [];
  if (bloq.length) {
    out.push(
      "# What blocks the render (fix these — nothing else matters until they pass)",
      ...bloq.map((f, i) => {
        const vistas = historia[firmaDe(f)] ?? 0;
        const nota =
          vistas >= 2
            ? `   NOTE: this exact error has now been reported ${vistas} times in this piece. Earlier repairs did not remove it.`
            : "";
        return [findingParaPrompt(f, i), nota].filter(Boolean).join("\n");
      }),
      "",
    );
  } else if (check.findings.length) {
    // El check fallo pero ningun finding viene marcado como error: no se puede
    // decir cual bloquea, asi que se muestran todos como candidatos.
    out.push(
      "# The check failed, but no finding is tagged as an error. The cause is among these:",
      ...check.findings.map(findingParaPrompt),
      "",
    );
  } else {
    out.push("# The check failed without structured findings. Raw output:", check.texto, "");
  }
  if (bloq.length && sec.length) {
    // Agrupados por regla: once renglones casi iguales solo compiten por la
    // atencion con el unico que importa.
    const grupos = new Map();
    for (const f of sec) {
      const k = `[${f.severity}] ${f.codigo}`;
      const g = grupos.get(k) ?? { n: 0, files: new Set() };
      g.n++;
      if (f.file) g.files.add(f.file.split("/").pop());
      grupos.set(k, g);
    }
    out.push(
      `# Everything below is cosmetic (${sec.length} finding${sec.length === 1 ? "" : "s"}). The check PASSES with these present.`,
      "Do not spend this turn on them.",
      ...[...grupos].map(
        ([k, g]) => `  ${k} x${g.n}${g.files.size ? ` (${[...g.files].slice(0, 3).join(", ")}${g.files.size > 3 ? ", ..." : ""})` : ""}`,
      ),
      "",
    );
  }
  return out;
}

function listaArchivos(plan, bloqueados) {
  return [
    "# Files you may edit",
    ...plan.scenes.map(
      (s) =>
        `- ${s.file}  (composition id: ${s.compId}, data-duration ${s.duration})` +
        (bloqueados.includes(s.file) ? "   <- has a blocking error" : ""),
    ),
    ...(bloqueados.length
      ? ["", `Only ${bloqueados.length === 1 ? "one file has" : `${bloqueados.length} files have`} a blocking error. Start there.`]
      : []),
    "",
    "index.html is owned by the pipeline: do not touch it, and do not change any data-start,",
    "data-duration, data-width, data-height or data-composition-id value listed above.",
  ];
}

const ENTREGA = [
  "# How to deliver the patched HTML",
  "There are no Edit or Write tools here. For every file you changed, print the FULL new",
  "contents in your answer using this exact fence shape:",
  "",
  "```html",
  "compositions/frames/01-name.html",
  "<!doctype html> ... the full file, exactly as it would be on disk ...",
  "```",
  "",
  "The first line inside the fence is the relative path and NOTHING else: no angle brackets,",
  "no quotes, no backticks, no prose. Copy it verbatim from the list above.",
  "",
  "Files you did NOT change must not appear in your answer. Do not write any summary or recap.",
  "",
  `The ${FONT_MARKER} line you see inside <style> is a placeholder: the real font faces are injected`,
  "after your answer. Keep that single line exactly as it is — never expand it, never paste",
  "base64, never add a <link> to a font.",
];

const FALLAS_TIPICAS = [
  "Notes on the usual failures:",
  "- contrast: the finding carries the sampled colors and a compliant suggestion in the same palette",
  "  direction — take it, do not invent a new colour.",
  "- content_overlap between spans of the SAME headline (tight leading): that overlap is intentional —",
  "  mark each line element with data-layout-allow-overlap instead of restaging. Two DIFFERENT blocks",
  "  overlapping is a real bug: give each its own band.",
  "- canvas_overflow: the type is too big for the safe area. Step down the type ramp or split the line;",
  "  do not delete the copy.",
  "- sweep_static: the animation finishes early and the rest of the window is frozen. Spread the reveals.",
];

/**
 * Apertura de la conversacion de reparacion: el dictamen del check separado
 * en lo que bloquea y lo que no, y los archivos marcados.
 *
 * `historia` son las veces que cada firma de error ya aparecio en esta pieza
 * (ver readCheckHistory): si el error viene de una sesion anterior, se dice.
 */
export function buildRepairPrompt({ plan, check, turn = 1, maxTurns = DEFAULT_REPAIR_TURNS, historia = {} } = {}) {
  const bloqueados = archivosBloqueados(plan, check);
  return [
    `\`hyperframes check\` failed (repair turn ${turn} of ${maxTurns}). Fix the composition files in place.`,
    "After your answer the files are written, the check runs again, and you get the result back in this",
    "same conversation — so fix what blocks, and only that; you will see whether it worked.",
    "",
    ...bloqueDictamen(plan, check, { historia }),
    ...listaArchivos(plan, bloqueados),
    "",
    ...ENTREGA,
    "",
    HARD_RULES,
    "",
    ...FALLAS_TIPICAS,
  ].join("\n");
}

/**
 * Una vuelta mas de la conversacion: lo que dijo el check despues de aplicar
 * lo que el modelo devolvio. La diferencia con la apertura es que aca se dice
 * QUE cambio respecto de la vuelta anterior — que errores sobrevivieron (el
 * arreglo no sirvio), cuales aparecieron y cuales se fueron. Sin eso el modelo
 * vuelve a mandar el mismo arreglo, porque desde su punto de vista nadie le
 * dijo que fallo.
 *
 * `previo` es la vuelta anterior: `{ check, escritos, truncado }`.
 */
export function buildRepairFollowUp({ plan, check, previo, turn, maxTurns = DEFAULT_REPAIR_TURNS, historia = {} } = {}) {
  const escritos = previo?.escritos ?? [];
  const bloqueados = archivosBloqueados(plan, check);

  if (escritos.length === 0) {
    return [
      "Your last answer contained NO ```html fences with a path on the first line, so nothing was written",
      "and the check was not re-run: the findings below are unchanged.",
      ...(previo?.truncado
        ? ["(The answer was cut off at the output limit. Keep it shorter: only the files that change, no prose.)"]
        : []),
      "",
      `Repair turn ${turn} of ${maxTurns}. Print the full contents of every file you fix, in the fence shape`,
      "described at the start of this conversation. Nothing else.",
      "",
      ...bloqueDictamen(plan, check, { historia }),
      ...listaArchivos(plan, bloqueados),
    ].join("\n");
  }

  const antes = new Map((previo?.check?.bloqueantes ?? []).map((f) => [firmaDe(f), f]));
  const ahora = new Map(check.bloqueantes.map((f) => [firmaDe(f), f]));
  const sobrevivieron = [...ahora.values()].filter((f) => antes.has(firmaDe(f)));
  const nuevos = [...ahora.values()].filter((f) => !antes.has(firmaDe(f)));
  const resueltos = [...antes.values()].filter((f) => !ahora.has(firmaDe(f)));

  const out = [
    `The check ran again after your rewrite of ${escritos.join(", ")} (repair turn ${turn} of ${maxTurns}).`,
    ...(previo?.truncado
      ? ["Your previous answer was cut off at the output limit; whatever was after the cut was lost."]
      : []),
    "",
  ];
  if (sobrevivieron.length) {
    out.push(
      `# Still blocking — ${sobrevivieron.length === 1 ? "this error" : "these errors"} SURVIVED your rewrite. The fix did not work.`,
      ...sobrevivieron.map((f, i) => {
        const vistas = historia[firmaDe(f)] ?? 0;
        const tocado = escritos.some((e) => mismoArchivo(e, f.file));
        const nota = tocado
          ? `   You rewrote this file and the linter still reports the exact same selector and time (seen ${vistas}x). Do not apply the same fix again: change the element's size, position, nesting or timing, or the layout it lives in.`
          : "   You did NOT rewrite this file last turn. It is the one that blocks the render.";
        return `${findingParaPrompt(f, i)}\n${nota}`;
      }),
      "",
    );
  }
  if (nuevos.length) {
    out.push(
      `# New blocking error${nuevos.length === 1 ? "" : "s"} (not present before your rewrite)`,
      ...nuevos.map(findingParaPrompt),
      "",
    );
  }
  if (resueltos.length) {
    out.push(
      `# Resolved by your rewrite (do not touch again): ${resueltos.map((f) => `${f.codigo} in ${f.file?.split("/").pop() ?? "?"}`).join("; ")}`,
      "",
    );
  }
  if (!sobrevivieron.length && !nuevos.length) {
    // Fallo sin bloqueantes identificables: el bloque generico lo explica.
    out.push(...bloqueDictamen(plan, check, { historia }));
  } else if (check.secundarios.length) {
    out.push(`# Cosmetic (${check.secundarios.length}, the check passes with them): ignore.`, "");
  }
  out.push(
    ...listaArchivos(plan, bloqueados),
    "",
    "Deliver again: full contents of every file you change, one ```html fence per file, path on the first line, nothing else.",
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Validacion del brief
// ---------------------------------------------------------------------------

/** Normaliza y valida el brief que devolvio el modelo. Lanza con el detalle exacto. */
export function parseBrief(data, { item, formatCfg } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new GenerateError("el brief no es un objeto JSON");
  }
  const errs = [];
  const brief = { ...data, format: item.format, language: item.language || "en" };

  brief.facts_used = asArray(brief.facts_used).map(str).filter(Boolean);
  if (brief.facts_used.length === 0) {
    errs.push("facts_used esta vacio: toda pieza tiene que citar al menos un hecho del knowledge");
  }

  if (item.feedback) {
    brief.feedback_addressed = str(brief.feedback_addressed);
    if (brief.feedback_addressed.length < 20) {
      errs.push(
        "falta feedback_addressed: hay que explicar concretamente que cambio este intento respecto del rechazo",
      );
    }
  }

  switch (formatKind(item.format, formatCfg)) {
    case "text": {
      brief.headline = str(brief.headline);
      brief.body = str(brief.body);
      brief.hashtags = asArray(brief.hashtags).map(str).filter(Boolean).slice(0, 3);
      if (!brief.body) errs.push("falta body: en formato text el brief ES el entregable");
      const cap = Number(formatCfg.maxChars) || 600;
      if (brief.body.length > cap) {
        errs.push(`body de ${brief.body.length} caracteres, el maximo es ${cap}: recortalo, no lo trunques`);
      }
      break;
    }
    case "still": {
      brief.register = str(brief.register) === "orange" ? "orange" : "dark";
      brief.display_line = str(brief.display_line);
      brief.support_line = str(brief.support_line);
      brief.kicker = str(brief.kicker);
      brief.accent_word = str(brief.accent_word);
      brief.caption = str(brief.caption);
      brief.concept = str(brief.concept);
      if (!brief.display_line) errs.push("falta display_line: la imagen es esa linea");
      break;
    }
    case "slides": {
      const want = Number(formatCfg.slides) || 6;
      const slides = asArray(brief.slides);
      if (slides.length !== want) {
        errs.push(`el carrusel necesita exactamente ${want} slides, llegaron ${slides.length}`);
      }
      brief.slides = slides.map((s, i) => ({
        n: i + 1,
        role: str(s?.role) || `slide-${i + 1}`,
        register: str(s?.register) === "orange" ? "orange" : "dark",
        kicker: str(s?.kicker),
        display_line: str(s?.display_line),
        support_line: str(s?.support_line),
        accent_word: str(s?.accent_word),
      }));
      const empty = brief.slides.filter((s) => !s.display_line).map((s) => s.n);
      if (empty.length) errs.push(`slides sin display_line: ${empty.join(", ")}`);
      brief.caption = str(brief.caption);
      brief.concept = str(brief.concept);
      break;
    }
    case "motion": {
      const scenes = asArray(brief.scenes);
      if (scenes.length < 4 || scenes.length > 10) {
        errs.push(`el video necesita entre 4 y 10 escenas, llegaron ${scenes.length}`);
      }
      brief.scenes = scenes.map((s, i) => ({
        id: str(s?.id) || `scene-${i + 1}`,
        title: str(s?.title),
        duration: Number(s?.duration),
        register: str(s?.register) === "orange" ? "orange" : "dark",
        on_screen: asArray(s?.on_screen).map(str).filter(Boolean),
        focal: s?.focal === true,
        note: str(s?.note),
      }));
      const mute = brief.scenes.filter((s) => s.on_screen.length === 0).map((s) => s.id);
      if (mute.length) errs.push(`escenas sin on_screen (sin voz en off, los cues son el reloj): ${mute.join(", ")}`);
      brief.preview_at_seconds = Number(brief.preview_at_seconds);
      brief.caption = str(brief.caption);
      brief.concept = str(brief.concept);
      break;
    }
    default:
      errs.push(`formato sin validador: ${item.format}`);
  }

  if (errs.length) throw new GenerateError(errs.join("; "));
  return brief;
}

// ---------------------------------------------------------------------------
// Materializacion
// ---------------------------------------------------------------------------

/** post.md se arma del brief: en formato text no hace falta una segunda llamada al modelo. */
export function renderPostMarkdown(brief, item) {
  const tags = asArray(brief.hashtags)
    .map((t) => (String(t).startsWith("#") ? String(t) : `#${t}`))
    .join(" ");
  const front = [
    "---",
    `id: ${item.id}`,
    `scheduled_for: ${item.scheduled_for}`,
    `format: ${item.format}`,
    `language: ${item.language}`,
    `revision: ${item.revision ?? 0}`,
    `angle: ${JSON.stringify(item.angle)}`,
    "---",
  ].join("\n");
  const body = brief.body.trim();
  const head = brief.headline && !body.startsWith(brief.headline) ? `${brief.headline}\n\n` : "";
  const facts = asArray(brief.facts_used);
  const appendix = facts.length ? `\n\n<!-- facts_used:\n${facts.map((f) => `- ${f}`).join("\n")}\n-->` : "";
  return `${front}\n\n${head}${body}${tags ? `\n\n${tags}` : ""}${appendix}\n`;
}

/** index.html: el contrato temporal de la pieza, generado, nunca escrito por el modelo. */
/**
 * Diseno sonoro minimo del video.
 *
 * Los SFX se copiaban al proyecto y nadie los montaba: el MP4 salia mudo. Un
 * promo sin sonido se nota enseguida. La regla es simple y deliberadamente
 * sobria: un golpe en la apertura, un whoosh en cada corte y un cierre suave.
 * Cada `<audio>` va en su propia pista alta para no pelear con las de video.
 *
 * Las duraciones son las reales de la libreria (medidas del manifest de
 * media-use); sobrar decimas no molesta porque el clip termina con el archivo.
 */
const SFX_LIB = {
  "impact-bass-1": 2.12,
  "whoosh-short": 0.57,
  whoosh: 1.0,
  "whoosh-cinematic": 2.4,
  riser: 2.4,
  ping: 1.32,
  chime: 2.5,
  sparkle: 1.6,
  pop: 0.4,
};

export function sfxTrack(plan, { available } = {}) {
  const has = (name) => !available || available.includes(`${name}.mp3`);
  const scenes = plan.scenes ?? [];
  const cues = [];

  if (has("impact-bass-1")) cues.push({ name: "impact-bass-1", at: 0, vol: 0.35 });
  if (has("riser")) cues.push({ name: "riser", at: 0, vol: 0.22 });

  // Un whoosh en cada corte menos el primero: marca el cambio de escena.
  for (let i = 1; i < scenes.length; i++) {
    const name = i === scenes.length - 1 ? "whoosh-cinematic" : "whoosh-short";
    if (!has(name)) continue;
    // Un pelin antes del corte, para que el sonido anticipe la imagen.
    const at = Math.max(0, Number(scenes[i].start) - 0.12);
    cues.push({ name, at: Number(at.toFixed(2)), vol: 0.3 });
  }

  if (has("sparkle")) {
    const last = scenes[scenes.length - 1];
    const at = last ? Number(last.start) + 0.35 : 0;
    cues.push({ name: "sparkle", at: Number(at.toFixed(2)), vol: 0.25 });
  }

  return cues.map((c, i) => ({ ...c, id: `el-sfx-${i}`, dur: SFX_LIB[c.name] ?? 1.5, track: 20 + i }));
}

export function renderIndexHtml({ id, plan, gsapTag, sfx = [] }) {
  const { width, height, total, scenes, overlapped } = plan;
  const mounts = scenes
    .map((s) =>
      [
        "      <div",
        `        id="el-${s.compId}"`,
        '        class="scene"',
        `        data-composition-id="${s.compId}"`,
        `        data-composition-src="${s.file}"`,
        `        data-start="${s.start}"`,
        `        data-duration="${s.duration}"`,
        `        data-track-index="${s.trackIndex}"`,
        "      ></div>",
      ].join("\n"),
    )
    .join("\n\n");

  const audio = sfx.length
    ? "\n\n      <!-- SFX -->\n" +
      sfx
        .map((c) =>
          [
            "      <audio",
            `        id="${c.id}"`,
            `        src="assets/sfx/${c.name}.mp3"`,
            `        data-start="${c.at}"`,
            `        data-duration="${c.dur}"`,
            `        data-track-index="${c.track}"`,
            `        data-volume="${c.vol}"`,
            "      ></audio>",
          ].join("\n"),
        )
        .join("\n")
    : "";

  const transitions = [];
  if (overlapped) {
    for (let i = 1; i < scenes.length; i++) {
      const at = scenes[i].start;
      transitions.push(
        `        tl.to("#el-${scenes[i - 1].compId}", { opacity: 0, duration: ${SCENE_OVERLAP}, ease: "power2.inOut" }, ${at});`,
        `        tl.fromTo("#el-${scenes[i].compId}", { opacity: 0 }, { opacity: 1, duration: ${SCENE_OVERLAP}, ease: "power2.inOut" }, ${at});`,
      );
    }
  }

  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    `    <meta name="viewport" content="width=${width}, height=${height}" />`,
    `    ${gsapTag}`,
    "    <style>",
    "      * { margin: 0; padding: 0; box-sizing: border-box; }",
    `      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #0C0F08; }`,
    // #root deliberadamente sin background: el fondo full-bleed vive en la capa .clip de cada escena.
    `      #root { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; }`,
    "      .scene { position: absolute; inset: 0; width: 100%; height: 100%; }",
    "    </style>",
    "  </head>",
    "  <body>",
    "    <div",
    '      id="root"',
    `      data-composition-id="${id}"`,
    '      data-start="0"',
    `      data-duration="${total}"`,
    `      data-width="${width}"`,
    `      data-height="${height}"`,
    "    >",
    mounts,
    audio,
    "    </div>",
    "",
    "    <script>",
    "      window.__timelines = window.__timelines || {};",
    `      window.__timelines["${id}"] = gsap.timeline({ paused: true });`,
    `      (function () { var tl = window.__timelines["${id}"];`,
    ...transitions,
    `        tl.to({}, { duration: ${total} }, 0); // ancla de duracion total`,
    "      })();",
    "    </script>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/** Archivos del proyecto de referencia que se clonan tal cual. */
export function referenceAssets(format, formatCfg = {}) {
  const files = ["frame.md", "hyperframes.json"];
  const dirs = [join("assets", "fonts")];
  const optionalFiles = [join("assets", "logo-mark.svg")];
  // Los efectos de sonido solo tienen sentido en algo que se mueve.
  if (formatKind(format, formatCfg) === "motion") dirs.push(join("assets", "sfx"));
  return { files, dirs, optionalFiles };
}

/**
 * Escribe en el proyecto una copia de la composicion de referencia SIN los data
 * URI de las fuentes.
 *
 * El original pesa 155 KB de los cuales 140 KB son base64. El modelo lo leia
 * entero — unos 35k tokens — solo para mirar una estructura de 11 KB, y eso era
 * el grueso de los 8,6 minutos que tardaba `compose` en el primer intento.
 * Devuelve la ruta relativa que el prompt debe citar.
 */
/**
 * La composicion que se le muestra al modelo como ejemplo de forma. Cada marca
 * trae la suya; el proyecto de referencia historico guardaba una escena real.
 */
export function referenceCompositionPath(ref) {
  if (!ref) return null;
  const candidatos = [
    rutaMeta(ref, "reference.html"),
    join(ref, "compositions", "frames", "reference.html"),
    join(ref, "compositions", "frames", "02-name.html"),
  ];
  for (const c of candidatos) if (existsSync(c)) return c;
  const dir = join(ref, "compositions", "frames");
  const primera = safeList(dir).find((f) => f.endsWith(".html"));
  return primera ? join(dir, primera) : null;
}

export function writeCleanReference(cfg, dir, { ref: refDir } = {}) {
  const ref = refDir ?? cfg.hyperframes?.referenceProject;
  const src = referenceCompositionPath(ref);
  if (!src) return null;

  const clean = readFileSync(src, "utf8").replace(
    /data:font\/woff2;base64,[A-Za-z0-9+/=]+/g,
    "BASE64-OMITIDO",
  );
  // rutaMeta decide la carpeta (.bca, o la vieja si este proyecto ya la tiene);
  // la ruta relativa se deriva de ahi para que lo que se crea, lo que se escribe
  // y lo que se le dice al modelo sean el mismo lugar.
  const out = rutaMeta(dir, "reference.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, clean);
  return relative(dir, out).split(sep).join("/");
}

function ensureProject(cfg, item, { log, brief, brand } = {}) {
  // El molde de la pieza es el proyecto base de su marca; el de la config es el
  // respaldo para una instalacion vieja que todavia no migro a marcas.
  const ref = brand?.projectDir ?? cfg.hyperframes?.referenceProject;
  if (!ref || !existsSync(ref)) {
    throw new GenerateError(
      brand
        ? `la marca ${brand.name} no tiene su proyecto base en disco (${ref}) — volve a guardarla desde el panel`
        : `no existe el proyecto de referencia de HyperFrames: ${ref}`,
    );
  }
  const dir = projectDirFor(cfg, item.id);
  mkdirSync(join(dir, "assets"), { recursive: true });

  const { files, dirs, optionalFiles } = referenceAssets(item.format, cfg.formats?.[item.format] ?? {});
  for (const f of files) {
    const src = join(ref, f);
    if (!existsSync(src)) throw new GenerateError(`falta ${f} en el proyecto de referencia (${ref})`);
    copyFileSync(src, join(dir, f));
  }
  for (const f of optionalFiles) {
    const src = join(ref, f);
    if (existsSync(src)) {
      mkdirSync(join(dir, "assets"), { recursive: true });
      copyFileSync(src, join(dir, f));
    }
  }
  for (const d of dirs) {
    const src = join(ref, d);
    if (existsSync(src)) cpSync(src, join(dir, d), { recursive: true, force: true });
  }

  writeCleanReference(cfg, dir, { ref });

  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: slugify(item.id, 64) || "bca-piece", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, "meta.json"),
    `${JSON.stringify({ id: item.id, name: item.id, createdAt: new Date().toISOString() }, null, 2)}\n`,
  );

  // Las escenas de un intento anterior solo sobran si el brief cambio: si es el
  // mismo, conservarlas es progreso real — un fallo en la escena 5 de 6 no obliga
  // a pagar de nuevo las cuatro que ya estaban bien.
  const stampFile = rutaMeta(dir, "brief.sha");
  const stamp = brief ? createHash("sha256").update(JSON.stringify(brief)).digest("hex") : null;
  const prev = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : null;
  const sameBrief = Boolean(stamp && prev && stamp === prev);

  if (!sameBrief) {
    rmSync(join(dir, "compositions"), { recursive: true, force: true });
    // Con otro brief los errores de check anteriores no dicen nada de estas escenas.
    clearCheckHistory(dir);
  } else {
    log?.("mismo brief que el intento anterior: las escenas que ya estaban escritas se conservan y solo se componen las que faltan");
  }
  mkdirSync(join(dir, "compositions", "frames"), { recursive: true });
  if (stamp) {
    mkdirSync(dirname(stampFile), { recursive: true });
    writeFileSync(stampFile, stamp);
  }

  log?.(`proyecto hyperframes listo: ${dir}`);
  return dir;
}

// ---------------------------------------------------------------------------
// CLI de HyperFrames + ffmpeg
// ---------------------------------------------------------------------------

// Los hijos que lanza esta corrida (npx -> node -> Chrome del render). Se
// registran para poder bajarlos: si el proceso se va sin matarlos, en Windows
// quedan huerfanos comiendo RAM y reteniendo el proyecto.
const liveChildren = new Set();

/**
 * Mata el arbol entero de un hijo. `child.kill()` solo mata al proceso directo,
 * que en Windows es el `cmd.exe` del wrapper: npx, node y Chrome sobreviven.
 */
function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        timeout: 5000,
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* ya estaba muerto, o taskkill no esta: nada mas que hacer */
  }
}

/** Baja todos los hijos vivos. La usa el hook de salida del proceso. */
export function killLiveChildren() {
  for (const child of liveChildren) killTree(child);
  liveChildren.clear();
}

function execFile(bin, args, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    // Mismo criterio que modelo.mjs: en Windows `npx` es un .cmd, asi que va por
    // `cmd.exe /c` con los argumentos como array. Nada de `shell: true`, que
    // concatena sin escapar (DEP0190) y convierte una ruta rara en inyeccion.
    const isWin = process.platform === "win32";
    const argv = args.map(String);
    const child = spawn(
      isWin ? process.env.COMSPEC || "cmd.exe" : bin,
      isWin ? ["/d", "/s", "/c", bin, ...argv] : argv,
      {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        windowsVerbatimArguments: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve(res);
    };
    const timer = setTimeout(() => {
      killTree(child);
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr: `${stderr}\n[timeout tras ${timeoutMs}ms]`, timedOut: true });
    }, timeoutMs ?? 10 * 60_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => finish({ code: -1, stdout, stderr: `${stderr}\n${err.message}` }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

/** `npx hyperframes@<cliVersion> ...` con cwd en el proyecto. */
export async function runHyperframes(cfg, projectDir, args, { timeoutMs, log } = {}) {
  const version = cfg.hyperframes?.cliVersion;
  const pkg = version ? `hyperframes@${version}` : "hyperframes";
  log?.(`hyperframes ${args.join(" ")}`);
  const res = await execFile("npx", ["--yes", pkg, ...args], {
    cwd: projectDir,
    timeoutMs,
    env: { npm_config_yes: "true", FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
  });
  return res;
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

/**
 * El dictamen de `check`, separado en lo que importa y lo que no.
 *
 *   bloqueantes  findings con severidad `error`: son los que hacen fallar el
 *                check (el mismo criterio que checkPassed) y los UNICOS que hay
 *                que arreglar para poder renderizar.
 *   secundarios  warnings e infos. El check PASA con ellos presentes.
 *   texto        todo aplanado, errores primero — para logs y mensajes de error.
 *
 * Antes esto devolvia solo `texto`, ordenado por severidad y nada mas. En una
 * corrida real (1 error contra 11 warnings) el modelo se paso dos reparaciones
 * arreglando los warnings de otros archivos: nadie le habia dicho que uno solo
 * de esos renglones era el que bloqueaba. La estructura existe para poder
 * decirselo.
 */
export function summarizeCheck({ stdout = "", stderr = "", maxChars = 6000 } = {}) {
  const clean = String(stdout).replace(ANSI, "");
  const data = extractJSON(clean);
  const findings = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || depth > 7) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    if (node.code || node.message || node.rule) {
      const severity = str(node.severity) || str(node.level) || "error";
      const codigo = str(node.code) || str(node.rule);
      const mensaje = str(node.message).slice(0, 400);
      const file = str(node.file ?? node.sourceFile ?? node.source);
      const selector = str(node.selector);
      const time = node.time ?? node.firstSeen;
      const t = time != null && time !== "" ? String(time) : "";
      const fix = str(node.suggestion ?? node.fix ?? node.fixHint).slice(0, 240);
      const linea = [
        `[${severity}]`,
        codigo,
        mensaje,
        file ? `file=${file}` : "",
        selector ? `selector=${selector}` : "",
        t ? `t=${t}` : "",
        fix ? `fix=${fix}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      if (!seen.has(linea)) {
        seen.add(linea);
        findings.push({ severity, codigo, mensaje, file, selector, t, fix, linea, bloqueante: severity === "error" });
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(data, 0);

  // Lo que gatea el exit code va primero: el modelo tiene que arreglar errores,
  // no perder el presupuesto de atencion en avisos de Studio.
  const rank = { error: 0, warning: 1, warn: 1, info: 2 };
  findings.sort((a, b) => (rank[a.severity] ?? 0) - (rank[b.severity] ?? 0));

  let texto;
  if (findings.length) {
    texto = findings.slice(0, 40).map((f) => f.linea).join("\n");
  } else {
    const tail = `${clean}\n${String(stderr).replace(ANSI, "")}`.trim();
    texto = tail.slice(-maxChars) || "check fallo sin salida legible";
  }
  if (texto.length > maxChars) texto = `${texto.slice(0, maxChars)}\n[...truncado]`;

  return {
    findings,
    bloqueantes: findings.filter((f) => f.bloqueante),
    secundarios: findings.filter((f) => !f.bloqueante),
    texto,
  };
}

/**
 * La firma de un finding: lo que hace que dos dictamenes hablen del MISMO
 * error aunque el resto del report haya cambiado. Se compara esto y no el
 * report entero porque los warnings fluctuan de una vuelta a otra (un `info`
 * cambia de selector cuando se reescribe el archivo) y comparar todo hacia
 * imposible ver que el error bloqueante era identico las tres veces.
 */
export function firmaDe(f) {
  return [f.codigo, f.file, f.selector, f.t].map((v) => String(v ?? "")).join("|");
}

/** Firmas ordenadas de los errores bloqueantes de un dictamen. */
export function firmasBloqueantes(check) {
  return [...new Set((check?.bloqueantes ?? []).map(firmaDe))].sort();
}

export function checkPassed({ code, stdout }) {
  const data = extractJSON(String(stdout ?? "").replace(ANSI, ""));
  if (data && typeof data === "object" && "ok" in data) return data.ok === true && code === 0;
  return code === 0;
}

/**
 * ffmpeg: lo que digan los ajustes -> instalaciones tipicas de Windows -> PATH.
 *
 * Se usa solo para sacar el frame de preview de un video: si no aparece, la
 * pieza igual se genera y el preview cae en el propio MP4.
 */
export function resolveFfmpeg(env = process.env) {
  const explicit = env.BCA_FFMPEG || env.ADSAI_FFMPEG;
  if (explicit && existsSync(explicit)) return explicit;

  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA ?? "";
    const candidatos = [
      // WinGet no fija la version en la ruta, asi que se busca la carpeta.
      local && join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
      "C:/ffmpeg/bin/ffmpeg.exe",
      join(env.ProgramFiles ?? "C:/Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
      ...buscarEnWinGet(local),
    ].filter(Boolean);
    for (const c of candidatos) if (existsSync(c)) return c;
  }
  return "ffmpeg"; // que lo resuelva el PATH; si no esta, degradamos
}

/** Las carpetas de WinGet traen la version en el nombre: hay que mirar adentro. */
function buscarEnWinGet(localAppData) {
  if (!localAppData) return [];
  const base = join(localAppData, "Microsoft", "WinGet", "Packages");
  const out = [];
  for (const paquete of safeList(base).filter((d) => /ffmpeg/i.test(d))) {
    for (const build of safeList(join(base, paquete))) {
      out.push(join(base, paquete, build, "bin", "ffmpeg.exe"));
    }
  }
  return out;
}

/** Extrae un frame del MP4. Devuelve true/false: nunca hace fallar la generacion. */
export async function extractFrame(mp4Path, seconds, outPng, { log } = {}) {
  const bin = resolveFfmpeg();
  const res = await execFile(
    bin,
    ["-y", "-ss", String(seconds), "-i", mp4Path, "-frames:v", "1", "-q:v", "2", outPng],
    { timeoutMs: FFMPEG_TIMEOUT_MS },
  );
  const ok = res.code === 0 && existsSync(outPng);
  if (!ok) log?.(`ffmpeg no pudo extraer el preview (${bin}): ${String(res.stderr).slice(-300)}`);
  return ok;
}

// ---------------------------------------------------------------------------
// Guardas contra items colgados en `building`
// ---------------------------------------------------------------------------

const inflight = new Map(); // store -> Set<itemId>
let exitHookInstalled = false;

function armInflight(store, itemId) {
  if (!inflight.has(store)) inflight.set(store, new Set());
  inflight.get(store).add(itemId);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // node:sqlite es sincrono, asi que esto sirve en un handler de 'exit'.
    process.on("exit", () => {
      // Primero los hijos: un Chrome huerfano sobrevive al proceso que lo
      // lanzo y sigue ocupando medio giga hasta que alguien lo note.
      killLiveChildren();
      for (const [s, ids] of inflight) {
        for (const id of ids) {
          try {
            s.setStatus(id, "planned", { error: "el proceso termino mientras el item estaba en building" });
          } catch {
            /* nada que hacer en el exit */
          }
        }
      }
    });
  }
}

function disarmInflight(store, itemId) {
  inflight.get(store)?.delete(itemId);
}

/**
 * Devuelve a `planned` cualquier item que quedo en `building` de una corrida
 * anterior que murio. Sin esto un item se traba para siempre.
 */
/**
 * Un job cuyo proceso ya no existe esta muerto, sin importar cuando fue su
 * ultimo latido. Sin esta comprobacion habia que esperar el silencio completo
 * (dos minutos) para volver a generar algo que se corto con Ctrl+C hace cinco
 * segundos — y el mensaje mientras tanto decia "ya se esta generando".
 *
 * Sin pid confiable devuelve true: que decida el latido, como antes.
 */
export function jobAlive(job) {
  const pid = Number(job?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // existe pero es de otro usuario
  }
}

export function rescueStuck(store, { log, staleSeconds = 120 } = {}) {
  // Trabajos cuyo proceso murio sin poder limpiar: sin esto el panel los muestra
  // "generando" para siempre.
  for (const j of store.activeJobs({ staleSeconds })) {
    if (j.stale) {
      store.endJob(j.item_id);
      log?.(`job sin senal descartado: ${j.item_id} (${j.silent_s}s en silencio)`);
    } else if (!jobAlive(j)) {
      store.endJob(j.item_id);
      log?.(`job huerfano descartado: ${j.item_id} (el pid ${j.pid} ya no existe)`);
    }
  }
  // Solo se reencola lo que NO tiene un proceso latiendo: antes esto pisaba una
  // generacion viva y la dejaba huerfana a mitad de camino.
  const alive = new Set(
    store
      .activeJobs({ staleSeconds })
      .filter((j) => !j.stale && jobAlive(j))
      .map((j) => j.item_id),
  );
  const stuck = store.listItems({ status: "building", limit: 500 }).filter((it) => !alive.has(it.id));
  for (const it of stuck) {
    store.setStatus(it.id, "planned", {
      error: "quedo en building en una corrida anterior; se reencola",
    });
    log?.(`rescatado de building: ${it.id}`);
  }
  return stuck.map((i) => i.id);
}

// ---------------------------------------------------------------------------
// Helpers para el flujo compose / repair sin tools de filesystem.
// ---------------------------------------------------------------------------

// El info string (```html <ruta>) es opcional: la ruta puede venir ahi o en la
// primera linea del cuerpo. Se aceptan las dos porque el modelo alterna.
const HTML_FENCE_RE = /```(?:html|HTML)?[ \t]*([^\n]*)\n([\s\S]*?)```/g;

/**
 * Parsea la respuesta del modelo y devuelve `{ "<relpath>": "<html>" }`.
 *
 * Cada bloque ```html trae la ruta relativa pegada al fence o en su primera
 * linea y, desde ahi, el cuerpo del archivo. Si una ruta no matchea ninguna
 * escena del plan se ignora con aviso.
 */
export function extractCompositions(text, plan) {
  const out = {};
  const skipped = [];
  const seen = new Set();
  const wanted = new Map(plan.scenes.map((s) => [normalizePath(s.file), s]));
  if (!text) return { files: out, skipped, missing: plan.scenes.map((s) => normalizePath(s.file)) };

  const orphans = []; // bloques con HTML pero sin ruta reconocible
  let m;
  HTML_FENCE_RE.lastIndex = 0;
  while ((m = HTML_FENCE_RE.exec(text)) !== null) {
    const info = normalizePath(m[1]);
    const inner = m[2];
    // La ruta pegada al fence gana; si no, es la primera linea del cuerpo.
    let path;
    let body;
    if (info && wanted.has(info)) {
      path = info;
      body = inner;
    } else {
      const nl = inner.indexOf("\n");
      if (nl < 0) continue;
      const head = normalizePath(inner.slice(0, nl));
      const rest = inner.slice(nl + 1);
      if (!head || !rest) continue;
      // El modelo a veces deja restos del ejemplo pegados a la ruta
      // ("<relpath-from-cwd>compositions/frames/01.html", "File: ..."). Si
      // adentro de esa linea hay UNA sola ruta del plan, es esa.
      path = wanted.has(head) ? head : (embeddedPath(head, wanted) ?? head);
      body = rest;
    }
    if (!wanted.has(path)) {
      skipped.push(path);
      if (body && body.trim()) orphans.push(body);
      continue;
    }
    // Si el modelo duplico una escena gana la ultima aparicion (la "final").
    seen.add(path);
    out[path] = body;
  }

  const missing = plan.scenes.map((s) => normalizePath(s.file)).filter((f) => !seen.has(f));

  // Rescate del caso de una sola escena: el modelo devolvio el archivo pero sin
  // ruta reconocible (la escribio en prosa, la puso como comentario, o no la
  // puso). Descartarlo obliga a pagar otra reparacion entera para conseguir lo
  // que ya esta en la respuesta.
  if (missing.length === 1 && plan.scenes.length === 1 && seen.size === 0) {
    const cuerpo = orphans.find(looksLikeComposition) ?? bareComposition(text);
    if (cuerpo) {
      out[missing[0]] = cuerpo;
      return { files: out, skipped, missing: [] };
    }
  }
  return { files: out, skipped, missing };
}

/**
 * Busca en `line` una de las rutas esperadas. Devuelve la ruta si hay
 * exactamente una: con dos o mas no se puede decidir sin adivinar.
 */
function embeddedPath(line, wanted) {
  const hits = [...wanted.keys()].filter((p) => line.includes(p));
  return hits.length === 1 ? hits[0] : null;
}

/** Un cuerpo es una composicion si trae la raiz que espera el render. */
function looksLikeComposition(body) {
  return /<template|data-composition-id|id="root"/i.test(String(body ?? ""));
}

/** Composicion sin fence: se toma desde el primer <template> o <div id="root">. */
function bareComposition(text) {
  const t = String(text ?? "");
  const at = t.search(/<template\b|<div[^>]*id="root"/i);
  if (at < 0) return null;
  const cuerpo = t.slice(at).trim();
  return cuerpo.length > 200 ? cuerpo : null;
}

/**
 * Normaliza una ruta a forward-slashes y le saca el envoltorio con el que el
 * modelo la decora: "./", comillas, backticks y los angulos de <ruta> — que en
 * una corrida real hicieron descartar la reparacion entera por un caracter.
 */
function normalizePath(p) {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^[<"'`]+|[>"'`]+$/g, "")
    .replace(/^\.\//, "")
    .trim();
}


/**
 * Junta los archivos que el wrapper mete en el prompt para compose / repair:
 *   - frame.md (sistema de diseno, fuente normativa)
 *   - .bca/reference.html (composicion de referencia sin base64 de fuentes)
 *   - las composiciones existentes del plan (para repair: el modelo las edita in-place)
 *
 * Devuelve `{}` si los archivos no existen — los prompts igualmente funcionan,
 * pero el modelo queda ciego a la marca y a la composicion previa.
 */
export function gatherContextFiles(projectDir, plan, { includeExisting = false } = {}) {
  const out = {};
  const frame = join(projectDir, "frame.md");
  if (existsSync(frame)) out["frame.md"] = readFileSync(frame, "utf8");

  const ref = rutaMeta(projectDir, "reference.html");
  if (existsSync(ref)) out[`${META_DIR}/reference.html`] = readFileSync(ref, "utf8");

  if (includeExisting) {
    // Las composiciones en disco ya pasaron por applyFonts: traen ~140 KB de
    // fuentes en base64. Inlinearlas asi costaba ~40k tokens de ENTRADA por
    // escena y, peor, el prompt pide devolver el archivo completo: el modelo se
    // ponia a transcribir base64 y se cortaba a mitad de camino, con lo cual la
    // reparacion entera se perdia. Se manda con el marcador y despues se
    // reinyectan las fuentes aca.
    const fontCss = readFontCss(projectDir);
    for (const s of plan.scenes ?? []) {
      const f = join(projectDir, s.file ?? "");
      if (existsSync(f)) out[s.file] = stripEmbeddedFonts(readFileSync(f, "utf8"), fontCss);
    }
  }
  return out;
}

/** El CSS de fuentes del proyecto, o null si todavia no se copio. */
function readFontCss(projectDir) {
  const cssPath = join(projectDir, "assets", "fonts", "bricolage.css");
  return existsSync(cssPath) ? readFileSync(cssPath, "utf8") : null;
}

/**
 * Deshace lo que hizo injectFonts: devuelve el HTML con el marcador en lugar de
 * las fuentes embebidas. Si no se puede identificar el CSS exacto, al menos se
 * recortan los data URIs, que son el 95% del peso.
 */
export function stripEmbeddedFonts(html, fontCss) {
  const text = String(html ?? "");
  if (fontCss && text.includes(fontCss)) return text.split(fontCss).join(FONT_MARKER);
  return text.replace(/data:font\/woff2;base64,[A-Za-z0-9+\/=]+/g, "BASE64-OMITIDO");
}

/**
 * Aplica el dictamen del parser a disco: crea directorios y escribe cada
 * composicion en su `scene.file` absoluta. Lanza con detalle si falta alguna.
 */
function writeCompositionsFromAnswer(files, plan, projectDir) {
  const written = [];
  for (const s of plan.scenes) {
    const key = normalizePath(s.file);
    const html = files[key];
    if (typeof html !== "string") continue;
    const dest = join(projectDir, s.file);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, html);
    written.push(s.file);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Fases
// ---------------------------------------------------------------------------

async function makeBrief(cfg, store, item, formatCfg, { log, deps, brand }) {
  const knowledge = requireKnowledge(store, brand?.id);
  let complaint = "";
  let cost = 0;
  let lastErr;

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildBriefPrompt({ cfg, brand, item, formatCfg, knowledge, complaint });
    const res = await deps.runModeloJSON(prompt, {
      model: cfg.models?.brief,
      timeoutMs: cfg.limits?.modelTimeoutMs,
    });
    cost += res.costUsd ?? 0;
    store.logRun({
      kind: "brief",
      itemId: item.id,
      model: res.model,
      costUsd: res.costUsd,
      ms: res.ms,
      ok: true,
      detail: `attempt ${attempt + 1}`,
    });
    try {
      const brief = parseBrief(res.data, { item, formatCfg });
      return { brief, cost };
    } catch (err) {
      lastErr = err;
      complaint = err.message;
      log?.(`brief invalido (intento ${attempt + 1}): ${err.message}`);
    }
  }
  throw new GenerateError(`el brief no paso validacion tras 2 intentos: ${lastErr?.message}`, {
    phase: "brief",
    itemId: item.id,
  });
}

async function writeCompositions(cfg, store, item, formatCfg, brief, plan, projectDir, { log, deps, brand }) {
  const layoutNotes = readLayoutNotes(projectDir);
  const layoutPlan = readLayoutPlan(projectDir);
  const pending = plan.scenes.filter((sc) => !existsSync(join(projectDir, sc.file)));
  const reused = plan.scenes.length - pending.length;

  if (!pending.length) {
    log?.(`composiciones: las ${reused} ya estaban escritas del intento anterior (mismo brief); no hay nada que componer, se pasa al check`);
    return 0;
  }
  const cuales = pending.map((s) => s.file.split("/").pop()).join(", ");
  log?.(
    `compose: ${pending.length} escena(s) por componer (${cuales}) — el modelo elige un layout por escena y rellena sus huecos con el copy del brief, en una llamada; el codigo renderiza el HTML` +
      (reused ? `. Las otras ${reused} ya estaban escritas y se conservan` : "") +
      " — suele tardar menos de un minuto",
  );

  // Una llamada JSON, corta. Si el plan no valida se le reclama con el detalle
  // exacto, una vez; despues se falla en fase compose (reintentable).
  let staged = null;
  let complaint = "";
  let cost = 0;
  let lastErr;
  for (let attempt = 0; attempt < 2 && !staged; attempt++) {
    const prompt = buildLayoutPlanPrompt({ brand, item, formatCfg, brief, plan, only: pending, layoutNotes, layoutPlan, complaint });
    const res = await deps.runModeloJSON(prompt, {
      model: cfg.models?.compose,
      timeoutMs: cfg.limits?.modelTimeoutMs,
    });
    cost += res.costUsd ?? 0;
    store.logRun({
      kind: "compose",
      itemId: item.id,
      model: res.model,
      costUsd: res.costUsd,
      ms: res.ms,
      ok: true,
      detail: `plan de layouts (intento ${attempt + 1}, ${pending.length} escena(s))`,
    });
    try {
      staged = parseLayoutPlan(res.data, { plan, only: pending });
    } catch (err) {
      lastErr = err;
      complaint = err.message;
      log?.(`  el plan de layouts no valida (intento ${attempt + 1}): ${err.message.slice(0, 300)}`, "aviso");
    }
  }
  if (!staged) {
    throw new GenerateError(`el plan de layouts no paso validacion tras 2 intentos: ${lastErr?.message}`, {
      phase: "compose",
      itemId: item.id,
    });
  }

  const vertical = pantallaCompleta(plan.width, plan.height);
  for (const scene of pending) {
    const { layout, slots } = staged.get(scene.file);
    let html;
    try {
      html = renderLayout(layout, { brand, width: plan.width, height: plan.height, scene, total: plan.scenes.length, slots, vertical });
    } catch (err) {
      throw new GenerateError(`no se pudo renderizar ${scene.file} con el layout ${layout}: ${String(err?.message ?? err).slice(0, 200)}`, {
        phase: "compose",
        itemId: item.id,
      });
    }
    const dest = join(projectDir, scene.file);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, html);
    layoutPlan[scene.file] = { layout, register: slots.register ?? "dark", display: str(slots.display) };
    log?.(`  ${scene.file.split("/").pop()}: layout ${layout}${slots.register === "light" ? ", registro claro" : ""} — "${str(slots.display).slice(0, 60)}"`);
  }
  writeLayoutPlan(projectDir, layoutPlan);
  store.beat(item.id, `compose ${plan.scenes.length}/${plan.scenes.length}`);
  log?.(
    `composiciones: ${pending.length} compuesta(s)` +
      (reused ? ` + ${reused} reusada(s) del intento anterior` : "") +
      ` = ${plan.scenes.length} listas`,
  );
  return cost;
}

/** Cuantas vueltas de reparacion por sesion de check admite la config. */
export function repairTurnsDe(cfg) {
  const n = Number(cfg?.limits?.repairTurns);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_REPAIR_TURNS;
}

function repairTokenBudgetDe(cfg) {
  const n = Number(cfg?.limits?.repairTokenBudget);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REPAIR_TOKEN_BUDGET;
}

/**
 * Cuantas veces cada firma de error bloqueante aparecio en los checks de esta
 * pieza (`.bca/check-history.json`, `{ "<firma>": vistas }`).
 *
 * Vive en disco y no en memoria porque una sesion que agota sus vueltas hace
 * fallar el item con fase `check`, que es reintentable: el intento siguiente
 * arranca otra sesion y tiene que saber que ese error ya sobrevivio a dos
 * reparaciones, para no volver a empezar de cero con el. Se borra cuando el
 * check pasa y cuando cambia el brief (ensureProject).
 */
export function readCheckHistory(projectDir) {
  const f = rutaMeta(projectDir, "check-history.json");
  if (!existsSync(f)) return {};
  try {
    const data = JSON.parse(readFileSync(f, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function writeCheckHistory(projectDir, historia) {
  const out = rutaMeta(projectDir, "check-history.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(historia, null, 2));
}

export function clearCheckHistory(projectDir) {
  rmSync(rutaMeta(projectDir, "check-history.json"), { force: true });
}

/**
 * Descarta las escenas con errores bloqueantes que sobrevivieron a todo y deja
 * anotado por que, para que la recomposicion no repita el planteo. Es la
 * misma maquinaria de la fase `layout`: borrar el archivo hace que
 * writeCompositions lo rehaga (el brief no cambio, asi que las demas escenas
 * se conservan) y la nota viaja en el prompt de esa escena.
 */
function descartarEscenas(projectDir, plan, check, files, { vistas, log }) {
  const notes = readLayoutNotes(projectDir);
  for (const file of files) {
    const propios = check.bloqueantes.filter((f) => mismoArchivo(f.file, file));
    const lineas = propios.map((f) => `- ${f.codigo}${f.selector ? ` on \`${f.selector}\`` : ""}${f.t ? ` at t=${f.t}` : ""}${f.mensaje ? `: ${f.mensaje}` : ""}`);
    const fixes = [...new Set(propios.map((f) => f.fix).filter(Boolean))];
    notes[file] =
      `The previous version of this scene failed \`hyperframes check\` ${vistas} times in a row with the same error, ` +
      `even after being rewritten twice to fix it:\n${lineas.join("\n")}\n` +
      "Do NOT patch that version: compose the scene again from the brief with a different staging " +
      "(other block distribution, other type sizes, other reveal sequence) so that this error cannot occur." +
      (fixes.length ? ` The linter suggests: ${fixes.join(" / ")}` : "");
    const abs = join(projectDir, file);
    if (existsSync(abs)) rmSync(abs, { force: true });
    log?.(`  descartada para recomponer desde el brief: ${file}`, "aviso");
  }
  writeLayoutNotes(projectDir, notes);
}

/**
 * `check` antes de renderizar, siempre. Renderizar sin validar desperdicia
 * minutos. Si falla, se abre una conversacion con el modelo: le llega el
 * dictamen separado en lo que bloquea y lo que no, escribe los archivos, se
 * corre el check de nuevo y el resultado vuelve como mensaje siguiente de la
 * MISMA conversacion. Asi el modelo ve el efecto de lo que hizo y puede probar
 * otra cosa, en vez de disparar a ciegas una vez por llamada.
 *
 * Cuando el mismo error bloqueante (misma firma: codigo+archivo+selector+t)
 * sobrevive vuelta tras vuelta se escala, no se insiste:
 *   vista 2  se le dice que su arreglo no sirvio y que cambie de planteo
 *   vista 3  se descarta la escena y se recompone desde el brief
 *   vista 4  se corta con `check-estancado` (no reintentable): ni parchar ni
 *            rehacer la escena alcanza — el brief pide algo que no entra, y
 *            eso lo decide una persona.
 *
 * Topes: `limits.repairTurns` vueltas (una recomposicion cuenta como vuelta) y
 * `limits.repairTokenBudget` tokens acumulados, porque el historial crece.
 * Agotarlos falla con fase `check`, reintentable: el intento siguiente reusa
 * las escenas y la historia de firmas, asi que cuesta solo las reparaciones.
 */
async function checkAndRepair(cfg, store, item, formatCfg, brief, plan, projectDir, indexHtml, { log, deps, brand }) {
  const maxTurns = repairTurnsDe(cfg);
  const budget = repairTokenBudgetDe(cfg);
  const historia = readCheckHistory(projectDir);
  let cost = 0;
  let tokens = 0;
  let turnos = 0;
  let checks = 0;
  let mensajes = null; // la conversacion en curso; null = todavia no se abrio (o se reinicio)
  let previo = null; // { check, escritos, truncado } de la vuelta anterior
  let check = null; // ultimo dictamen
  let necesitaCheck = true;

  for (;;) {
    if (necesitaCheck) {
      // index.html se reescribe antes de cada check: el contrato temporal es nuestro.
      writeFileSync(join(projectDir, "index.html"), indexHtml);
      checks++;
      store.beat(item.id, `check ${checks}`);
      log?.(
        checks === 1
          ? "check: hyperframes abre un navegador y mide contraste, solapes, desbordes y animacion de cada escena — suele tardar menos de un minuto (mas la primera vez, que npx baja la CLI)"
          : `check ${checks}: se vuelve a medir con lo que se acaba de escribir`,
      );
      const res = await deps.hyperframes(cfg, projectDir, ["check", "--json"], {
        timeoutMs: CHECK_TIMEOUT_MS,
        log,
      });
      if (checkPassed(res)) {
        clearCheckHistory(projectDir);
        store.logRun({ kind: "render", itemId: item.id, ok: true, detail: `check ok (check ${checks}, ${turnos} vuelta(s) de reparacion)` });
        log?.(`check ok${turnos ? ` tras ${turnos} vuelta(s) de reparacion` : " a la primera"}: se puede renderizar`);
        return cost;
      }
      check = summarizeCheck(res);
      store.logRun({ kind: "render", itemId: item.id, ok: false, detail: `check fallo: ${check.texto.slice(0, 300)}` });

      // Que fallo, no solo que fallo algo — y de todo lo que fallo, que parte
      // impide renderizar. En consola y en el panel se ve lo mismo que le llega
      // al modelo: lo bloqueante aparte de lo cosmetico.
      const bloq = check.bloqueantes;
      const sec = check.secundarios;
      if (bloq.length) {
        log?.(`check fallo: ${bloq.length} error(es) bloqueante(s)${sec.length ? ` y ${sec.length} aviso(s) cosmetico(s) que no impiden renderizar` : ""}`, "error");
        for (const f of bloq.slice(0, 6)) log?.(`    ${f.linea}`, "error");
        if (bloq.length > 6) log?.(`    (+${bloq.length - 6} bloqueantes mas)`, "error");
        for (const f of sec.slice(0, 3)) log?.(`    ${f.linea}`, "aviso");
        if (sec.length > 3) log?.(`    (+${sec.length - 3} cosmeticos mas)`, "aviso");
      } else {
        log?.("check fallo sin errores marcados como bloqueantes:", "error");
        for (const linea of check.texto.split("\n").slice(0, 6)) log?.(`    ${linea}`, "error");
      }

      // Contar cuantas veces se vio cada error bloqueante y decidir si se
      // sigue conversando, se recompone o se corta.
      for (const firma of firmasBloqueantes(check)) historia[firma] = (historia[firma] ?? 0) + 1;
      if (bloq.length) writeCheckHistory(projectDir, historia);
      const vistasDe = (f) => historia[firmaDe(f)] ?? 0;
      const peor = Math.max(0, ...bloq.map(vistasDe));

      if (peor >= VISTAS_PARA_CORTAR) {
        const tercos = bloq.filter((f) => vistasDe(f) >= VISTAS_PARA_CORTAR);
        const archivos = archivosBloqueados(plan, { bloqueantes: tercos });
        log?.(
          `el mismo error volvio ${peor} veces (${archivos.join(", ")}): sobrevivio a dos reparaciones y a recomponer la escena desde cero. Se corta: el brief pide algo que esa escena no puede cumplir; rechazala con un comentario para rehacer el brief`,
          "error",
        );
        throw new GenerateError(
          `hyperframes check devuelve el mismo error ${peor} veces seguidas en ${archivos.join(", ")}, ` +
            `despues de reparar dos veces y recomponer la escena desde el brief; reintentar no lo va a arreglar. ` +
            `Probablemente el brief pide algo que no entra en esa escena: rechazala con un comentario para que se rehaga el brief.\n` +
            tercos.map((f) => f.linea).join("\n"),
          { phase: "check-estancado", itemId: item.id },
        );
      }

      if (peor >= VISTAS_PARA_RECOMPONER) {
        const tercos = bloq.filter((f) => vistasDe(f) >= VISTAS_PARA_RECOMPONER);
        const archivos = archivosBloqueados(plan, { bloqueantes: tercos });
        log?.(`el mismo error sobrevivio a ${peor - 1} reparaciones en ${archivos.join(", ")}: se deja de parchar y se recompone esa escena desde el brief`, "aviso");
        descartarEscenas(projectDir, plan, check, archivos, { vistas: peor, log });
        if (turnos >= maxTurns) {
          // Sin vueltas para recomponer aca; el intento siguiente del item lo
          // hace (la escena ya no esta y la nota quedo escrita).
          throw new GenerateError(
            `hyperframes check sigue fallando tras ${turnos} vuelta(s) de reparacion; ${archivos.join(", ")} se descarto para recomponerla en el proximo intento:\n${check.texto}`,
            { phase: "check", itemId: item.id },
          );
        }
        cost += await writeCompositions(cfg, store, item, formatCfg, brief, plan, projectDir, { log, deps, brand });
        applyFonts(projectDir, plan, { log });
        turnos++;
        // La conversacion hablaba de un archivo que ya no existe: se reinicia.
        mensajes = null;
        previo = null;
        continue;
      }
    }
    necesitaCheck = true;

    if (turnos >= maxTurns) {
      log?.(`se agotaron las ${maxTurns} vueltas de reparacion de esta sesion y el check sigue fallando`, "error");
      throw new GenerateError(`hyperframes check sigue fallando tras ${turnos} vueltas de reparacion:\n${check.texto}`, {
        phase: "check",
        itemId: item.id,
      });
    }
    if (tokens >= budget) {
      log?.(`la conversacion de reparacion ya gasto ${tokens} tokens (tope ${budget}) y el check sigue fallando`, "error");
      throw new GenerateError(`la reparacion supero el tope de ${budget} tokens (limits.repairTokenBudget) sin pasar el check:\n${check.texto}`, {
        phase: "check",
        itemId: item.id,
      });
    }

    const turno = turnos + 1;
    if (!mensajes) {
      // Apertura: el dictamen y los archivos, con el prefijo largo (frame.md,
      // referencia, escenas) marcado como cacheable, porque cada vuelta lo repite.
      const prompt = buildRepairPrompt({ plan, check, turn: turno, maxTurns, historia });
      const files = gatherContextFiles(projectDir, plan, { includeExisting: true });
      mensajes = [{ role: "user", content: conArchivos(prompt, files, { cache: true }) }];
    } else {
      mensajes.push({ role: "user", content: buildRepairFollowUp({ plan, check, previo, turn: turno, maxTurns, historia }) });
    }
    const bloqueados = archivosBloqueados(plan, check);
    log?.(
      `reparacion, vuelta ${turno}/${maxTurns}: el modelo ${previo ? "ve el resultado de su arreglo anterior y " : ""}reescribe ` +
        (bloqueados.length ? `lo que tiene el error bloqueante (${bloqueados.map((f) => f.split("/").pop()).join(", ")})` : "lo que haga falta") +
        " — una llamada al modelo tarda de uno a diez minutos segun el largo",
    );

    // Reparar es aplicar el dictamen del linter: va al modelo de repair (o al
    // de compose si no hay uno aparte). Es el mismo en toda la conversacion.
    store.beat(item.id, `repair ${turno}/${maxTurns}`);
    const fix = await deps.runModeloChat(mensajes, {
      model: cfg.models?.repair ?? cfg.models?.compose,
      timeoutMs: cfg.limits?.modelTimeoutMs,
    });
    mensajes = fix.mensajes ?? [...mensajes, { role: "assistant", content: fix.text }];
    tokens += (fix.inputTokens ?? 0) + (fix.outputTokens ?? 0) + (fix.cacheReadTokens ?? 0);
    cost += fix.costUsd ?? 0;
    turnos++;
    store.logRun({
      kind: "compose",
      itemId: item.id,
      model: fix.model,
      costUsd: fix.costUsd,
      ms: fix.ms,
      ok: true,
      detail: `reparacion, vuelta ${turno}${fix.cacheReadTokens ? ` (${fix.cacheReadTokens} tokens desde cache)` : ""}`,
    });

    const { files: answered, skipped } = extractCompositions(fix.text, plan);
    if (skipped.length) {
      log?.(`  aviso: el modelo devolvio bloques que no son del plan (${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "..." : ""})`, "aviso");
    }
    const truncado = fix.stopReason === "max_tokens";
    if (truncado) log?.("  aviso: la respuesta se corto en max_tokens", "aviso");
    const escritos = Object.keys(answered);
    if (escritos.length === 0) {
      // Nada cambio en disco: correr el check daria lo mismo. Se le reclama en
      // la misma conversacion sin gastar un check.
      log?.("  la reparacion no trajo ningun archivo: no se escribio nada, se le vuelve a pedir", "aviso");
      previo = { check, escritos: [], truncado };
      necesitaCheck = false;
      continue;
    }
    try {
      writeCompositionsFromAnswer(answered, plan, projectDir);
    } catch (writeErr) {
      throw new GenerateError(`no se pudo escribir la reparacion: ${String(writeErr?.message ?? writeErr).slice(0, 300)}`, {
        phase: "repair",
        itemId: item.id,
      });
    }
    // Decir si toco lo que habia que tocar. En la corrida que motivo esto
    // reparo dos archivos que no tenian el error y nadie se entero.
    const tocoBloqueados = bloqueados.filter((b) => escritos.some((e) => normalizePath(e) === normalizePath(b)));
    const faltan = bloqueados.filter((b) => !tocoBloqueados.includes(b));
    const nombres = escritos.map((f) => f.split("/").pop()).join(", ");
    if (!bloqueados.length) {
      log?.(`  reparadas ${escritos.length} composicion(es): ${nombres}`);
    } else if (!faltan.length) {
      log?.(`  reparadas ${escritos.length} composicion(es): ${nombres} — ${bloqueados.length === 1 ? "la que tenia" : "todas las que tenian"} el error bloqueante`);
    } else {
      log?.(
        `  reparadas ${escritos.length} composicion(es): ${nombres} — ` +
          (tocoBloqueados.length ? `pero no toco ${faltan.map((f) => f.split("/").pop()).join(", ")}, que tambien tiene error bloqueante` : `ninguna es la que tiene el error bloqueante (${faltan.map((f) => f.split("/").pop()).join(", ")})`),
        "aviso",
      );
    }
    // La reparacion vuelve con el marcador donde iban las fuentes: sin esto el
    // check siguiente mide una composicion con la tipografia de respaldo, que
    // no es la que se va a renderizar.
    applyFonts(projectDir, plan, { log });
    previo = { check, escritos, truncado };
  }
}

// ---------------------------------------------------------------------------
// Revision visual: fotografiar cada escena y que un modelo con vision la mire
// ---------------------------------------------------------------------------
//
// El linter mide cajas: contraste, solapes, desbordes. No ve una palabra
// partida a mitad de linea, una mitad del lienzo muerta, un numero que no
// aparecio ni un texto tapado por un grafico — que es exactamente lo que se
// veia en las piezas. Aca se fotografia cada escena en su instante
// representativo (el mismo del snapshot de un still) y el modelo de vision
// responde contra una lista corta. Lo que encuentra vuelve a la conversacion
// de reparacion CON la imagen adjunta, para que quien arregla vea lo mismo.
//
// Las imagenes viajan solo en el mensaje de esa vuelta: el historial que se
// reenvia guarda un marcador de texto en su lugar (sinImagenes), nada de
// base64 en el prompt siguiente, en los logs ni en la base.

export function reviewTurnsDe(cfg) {
  const n = Number(cfg?.limits?.reviewTurns);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_REVIEW_TURNS;
}

/** Fotografia todas las escenas en su instante representativo. PNGs en orden. */
async function snapshotScenes(cfg, item, plan, projectDir, tag, { log, deps }) {
  const rel = `snapshots/${tag}`;
  const outDir = join(projectDir, rel);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const at = plan.scenes.map((s) => s.snapshotAt).join(",");
  const res = await deps.hyperframes(cfg, projectDir, ["snapshot", "--at", at, "--no-end", "-o", rel], {
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    log,
  });
  const pngs = snapshotOutputs(outDir);
  if (res.code !== 0 && pngs.length === 0) {
    throw new GenerateError(`hyperframes snapshot fallo: ${summarizeCheck(res).texto.slice(0, 800)}`, {
      phase: "snapshot",
      itemId: item.id,
    });
  }
  if (pngs.length < plan.scenes.length) {
    throw new GenerateError(`snapshot devolvio ${pngs.length} PNG y se esperaban ${plan.scenes.length}`, {
      phase: "snapshot",
      itemId: item.id,
    });
  }
  return pngs;
}

const REVIEW_CODES = ["word_broken", "text_clipped", "overlap", "empty_area", "missing_copy", "illegible", "too_small", "misplaced"];

/** El copy que deberia verse en una escena, para que el revisor sepa que buscar. */
function copyEsperado(brief, plan, scene) {
  const src = plan.kind === "slides" ? asArray(brief.slides)[scene.index] ?? {} : plan.kind === "motion" ? asArray(brief.scenes)[scene.index] ?? {} : brief;
  const partes = [];
  if (src.kicker) partes.push(`kicker: ${str(src.kicker)}`);
  if (src.display_line) partes.push(`display: ${str(src.display_line)}`);
  if (src.support_line) partes.push(`support: ${str(src.support_line)}`);
  const cues = asArray(src.on_screen).map(str).filter(Boolean);
  if (cues.length) partes.push(`cues: ${cues.join(" | ")}`);
  if (src.title) partes.push(`scene: ${str(src.title)}`);
  return partes.join("; ") || "-";
}

/**
 * El mensaje del revisor: instrucciones, y por escena el copy esperado y la
 * foto. Devuelve los bloques de contenido (texto + imagenes).
 */
export function buildReviewMessage({ plan, brief, pngs, layoutPlan = {} }) {
  const bloques = [
    {
      type: "text",
      text: [
        `Visual review of ${plan.scenes.length} rendered scene(s) of a ${plan.width}x${plan.height} ${plan.kind === "motion" ? "video" : "still"} piece.`,
        "Each image below is one scene photographed at its representative instant, after all its reveals. Look at each",
        "one as a viewer would and report ONLY problems a viewer would notice. Codes:",
        "- word_broken: a word split across two lines mid-word (e.g. 'otr / a')",
        "- text_clipped: text cut by the canvas edge or by a container",
        "- overlap: text over text, or a graphic covering text",
        "- empty_area: a whole half or a big region with nothing, while the rest is crammed",
        "- missing_copy: a listed line/cue/number that does not appear (a dash or blank where a figure should be counts)",
        "- illegible: text unreadable (contrast, size against the canvas)",
        "- too_small: the main line is not readable at arm's length on a phone",
        "- misplaced: an element sits outside the safe area or breaks the grid visibly",
        "Do NOT report taste, style or things you would merely do differently. Balanced, readable, complete = ok.",
        "At most 3 problems per scene, the most visible first. Answer JSON only:",
        '{ "scenes": [ { "file": "<as listed>", "ok": true|false, "problems": [ { "code": "<one of the codes>", "detail": "<what and where, one sentence>", "fix": "<the concrete change>" } ] } ] }',
        "",
      ].join("\n"),
    },
  ];
  plan.scenes.forEach((s, i) => {
    bloques.push({
      type: "text",
      text: `Scene ${i + 1} — file: ${s.file}${layoutPlan[s.file]?.layout ? ` (layout: ${layoutPlan[s.file].layout})` : ""}. Expected copy: ${copyEsperado(brief, plan, s)}`,
    });
    if (pngs[i]) bloques.push(imagenPng(readFileSync(pngs[i])));
  });
  return bloques;
}

/** Normaliza el veredicto del revisor contra el plan. [{ scene, ok, problems }] */
export function parseReview(data, plan) {
  const entries = Array.isArray(data?.scenes) ? data.scenes : [];
  return plan.scenes.map((s) => {
    const f = normalizePath(s.file);
    const e = entries.find((x) => normalizePath(x?.file) === f) ?? entries.find((x) => normalizePath(x?.file).split("/").pop() === f.split("/").pop());
    const problems = (Array.isArray(e?.problems) ? e.problems : [])
      .map((p) => ({ code: str(p?.code).toLowerCase(), detail: str(p?.detail), fix: str(p?.fix) }))
      .filter((p) => REVIEW_CODES.includes(p.code) && p.detail)
      .slice(0, 3);
    return { scene: s, ok: !e || (e.ok !== false && problems.length === 0), problems };
  });
}

/**
 * Prompt de reparacion visual: por escena, lo que ve mal el revisor; la foto
 * va adjunta como bloque de imagen despues del texto. Misma entrega (fences)
 * y mismas reglas duras que la reparacion del linter.
 */
export function buildVisualRepairPrompt({ plan, malas, turn, maxTurns, layoutPlan = {} } = {}) {
  return [
    turn === 1
      ? "A visual review of the rendered scenes found problems that the linter cannot see. Below, per scene: what a viewer"
      : "The scenes were photographed again after your rewrite. A visual review still finds problems. Below, per scene: what a viewer",
    "sees wrong and the snapshot itself. Fix the HTML in place — keep the scene's layout and copy, change what is needed:",
    "type size or line breaks (one word per line-span, never let the browser split a word), positions, spacing, stacking order.",
    `Visual repair turn ${turn} of ${maxTurns}. After your answer the files are written, the linter runs, the scenes are photographed`,
    "again and you see the result.",
    "",
    "# What is wrong",
    ...malas.flatMap(({ scene, problems }, i) => [
      `${i + 1}. ${scene.file}${layoutPlan[scene.file]?.layout ? ` (layout: ${layoutPlan[scene.file].layout})` : ""}`,
      ...problems.map((p) => `   - ${p.code}: ${p.detail}${p.fix ? ` → ${p.fix}` : ""}`),
    ]),
    "",
    "# Files you may edit",
    ...malas.map(({ scene }) => `- ${scene.file}  (composition id: ${scene.compId}, data-duration ${scene.duration})`),
    "",
    "index.html is owned by the pipeline: do not touch it, and do not change any data-start,",
    "data-duration, data-width, data-height or data-composition-id value listed above.",
    "",
    ...ENTREGA,
    "",
    HARD_RULES,
  ].join("\n");
}

/**
 * Fotografiar, revisar, y si hace falta reparar con la foto a la vista — hasta
 * `limits.reviewTurns` vueltas. Devuelve los PNG de la ultima foto (los stills
 * los usan como entregable) y el costo.
 *
 * Quedarse sin vueltas NO falla la pieza: una observacion visual es calidad,
 * no un bloqueo. Se renderiza igual y queda dicho en la bitacora.
 */
async function reviewAndRepair(cfg, store, item, formatCfg, brief, plan, projectDir, indexHtml, { log, deps, brand }) {
  const maxTurns = reviewTurnsDe(cfg);
  const necesitaFotos = plan.kind !== "motion" || maxTurns > 0;
  if (!necesitaFotos) return { cost: 0, pngs: null };
  const layoutPlan = readLayoutPlan(projectDir);
  let cost = 0;
  let turnos = 0;
  let mensajes = null;
  let pngs = null;

  for (;;) {
    store.beat(item.id, `review ${turnos + 1}`);
    log?.(
      turnos === 0
        ? `snapshot: hyperframes fotografia las ${plan.scenes.length} escena(s) en su instante representativo — suele tardar menos de un minuto`
        : "snapshot: se vuelven a fotografiar las escenas con lo que se acaba de escribir",
    );
    pngs = await snapshotScenes(cfg, item, plan, projectDir, `review-${turnos}`, { log, deps });
    if (maxTurns === 0) return { cost, pngs };

    log?.(`revision visual ${turnos + 1}/${maxTurns}: el modelo mira cada foto y busca palabras partidas, texto cortado, solapes, mitades vacias, copy faltante`);
    const veredicto = await revisarFotos(cfg, store, item, plan, brief, pngs, layoutPlan, { log, deps });
    cost += veredicto.cost;
    if (!veredicto.review) return { cost, pngs };
    const malas = veredicto.review.filter((r) => !r.ok && r.problems.length);
    if (!malas.length) {
      log?.("revision visual: sin observaciones, las escenas se ven bien");
      return { cost, pngs };
    }
    log?.(`revision visual: ${malas.length} escena(s) con observaciones`, "aviso");
    for (const m of malas) log?.(`    ${m.scene.file.split("/").pop()}: ${m.problems.map((p) => `${p.code} — ${p.detail}`).join("; ")}`, "aviso");
    if (turnos >= maxTurns) {
      log?.(`se agotaron las ${maxTurns} vuelta(s) de revision visual: se renderiza igual, con esas observaciones a la vista`, "aviso");
      return { cost, pngs };
    }

    // Reparar con la foto adjunta. Solo los archivos con observaciones viajan
    // inline; la imagen va en este mensaje y nada mas que en este.
    const turno = turnos + 1;
    const prompt = buildVisualRepairPrompt({ plan, malas, turn: turno, maxTurns, layoutPlan });
    const files = gatherContextFiles(projectDir, { scenes: malas.map((m) => m.scene) }, { includeExisting: true });
    const texto = conArchivos(prompt, files, { cache: mensajes === null });
    const bloques = Array.isArray(texto) ? [...texto] : [{ type: "text", text: texto }];
    for (const m of malas) {
      const png = pngs[m.scene.index];
      if (!png) continue;
      bloques.push({ type: "text", text: `Snapshot of ${m.scene.file} at ${m.scene.snapshotAt}s:` }, imagenPng(readFileSync(png)));
    }
    mensajes = mensajes ? [...mensajes, { role: "user", content: bloques }] : [{ role: "user", content: bloques }];
    log?.(`reparacion visual, vuelta ${turno}/${maxTurns}: el modelo ve la foto de ${malas.map((m) => m.scene.file.split("/").pop()).join(", ")} y reescribe`);
    store.beat(item.id, `repair visual ${turno}/${maxTurns}`);
    const fix = await deps.runModeloChat(mensajes, {
      model: cfg.models?.repair ?? cfg.models?.compose,
      timeoutMs: cfg.limits?.modelTimeoutMs,
    });
    // El historial sigue sin base64: la imagen ya cumplio.
    mensajes = sinImagenes(fix.mensajes ?? [...mensajes, { role: "assistant", content: fix.text }]);
    cost += fix.costUsd ?? 0;
    turnos++;
    store.logRun({
      kind: "compose",
      itemId: item.id,
      model: fix.model,
      costUsd: fix.costUsd,
      ms: fix.ms,
      ok: true,
      detail: `reparacion visual, vuelta ${turno}${fix.cacheReadTokens ? ` (${fix.cacheReadTokens} tokens desde cache)` : ""}`,
    });
    const { files: answered } = extractCompositions(fix.text, { scenes: malas.map((m) => m.scene) });
    const escritos = Object.keys(answered);
    if (!escritos.length) {
      log?.("  la reparacion visual no trajo ningun archivo: se deja como esta", "aviso");
      return { cost, pngs };
    }
    writeCompositionsFromAnswer(answered, plan, projectDir);
    applyFonts(projectDir, plan, { log });
    log?.(`  reescritas ${escritos.length} composicion(es): ${escritos.map((f) => f.split("/").pop()).join(", ")}`);
    // Lo reescrito tiene que volver a pasar el linter antes de fotografiarse.
    cost += await checkAndRepair(cfg, store, item, formatCfg, brief, plan, projectDir, indexHtml, { log, deps, brand });
  }
}

/** Una llamada al modelo de vision; reintenta una vez si no vuelve JSON. */
async function revisarFotos(cfg, store, item, plan, brief, pngs, layoutPlan, { log, deps }) {
  const contenido = buildReviewMessage({ plan, brief, pngs, layoutPlan });
  let cost = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await deps.runModeloChat([{ role: "user", content: contenido }], {
      model: cfg.models?.review ?? cfg.models?.compose,
      timeoutMs: cfg.limits?.modelTimeoutMs,
      maxTokens: 4000,
    });
    cost += res.costUsd ?? 0;
    store.logRun({
      kind: "review",
      itemId: item.id,
      model: res.model,
      costUsd: res.costUsd,
      ms: res.ms,
      ok: true,
      detail: `revision visual de ${plan.scenes.length} escena(s) (intento ${attempt + 1})`,
    });
    const data = extractJSON(res.text);
    if (data && Array.isArray(data.scenes)) return { review: parseReview(data, plan), cost };
    log?.(`  la revision visual no devolvio un veredicto legible (intento ${attempt + 1})`, "aviso");
  }
  log?.("  sin veredicto visual: se sigue sin revisar", "aviso");
  return { review: null, cost };
}

function snapshotOutputs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^frame-\d+.*\.png$/i.test(f))
    .sort((a, b) => {
      const ai = Number(/^frame-(\d+)/.exec(a)?.[1] ?? 0);
      const bi = Number(/^frame-(\d+)/.exec(b)?.[1] ?? 0);
      return ai - bi;
    })
    .map((f) => join(dir, f));
}

/** Avisos de layout por archivo, para que el reintento de UNA escena los vea. */
export function readLayoutNotes(projectDir) {
  const f = rutaMeta(projectDir, "layout-notes.json");
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

export function writeLayoutNotes(projectDir, notes) {
  const out = rutaMeta(projectDir, "layout-notes.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(notes, null, 2));
}

export const MIN_INK_COVERAGE = 0.6;

/** Minimo del ANCHO que debe cubrir el contenido. Algo menor deja media pantalla muerta. */
export const MIN_INK_COVERAGE_X = 0.55;

/**
 * Lo mismo para una pieza vertical. Es mas bajo a proposito: la app tapa el 14%
 * de arriba y el 20% de abajo, asi que el contenido bien compuesto ocupa la
 * franja del medio y nunca llegaria al 60% del alto total.
 */
export const MIN_INK_COVERAGE_VERTICAL = 0.45;

/** Cada cuanto late un trabajo en curso, para distinguir "lento" de "muerto". */
export const BEAT_INTERVAL_MS = 20_000;

/**
 * Mide que porcion del ALTO ocupa el contenido de un PNG.
 *
 * El modelo compone con habitos de 16:9 y en un lienzo alto deja la mitad de
 * abajo vacia — el mismo defecto que arruinaba los videos hechos a mano. El
 * linter de HyperFrames no lo ve: no es un error, es una composicion floja.
 * Se mide asi: ffmpeg saca la luminancia cruda, la luminancia mas frecuente es
 * el fondo, y una fila cuenta como "con tinta" si un 0,2% de sus pixeles se
 * aparta de ese fondo. Devuelve null si ffmpeg no esta disponible: sin medicion
 * se sigue adelante, nunca se bloquea la entrega por no poder medir.
 */
export function measureInk(pngPath, width, height, ffmpegPath) {
  if (!ffmpegPath || !existsSync(pngPath)) return null;
  let raw;
  try {
    raw = execFileSync(
      ffmpegPath,
      ["-v", "error", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { maxBuffer: 1 << 28 },
    );
  } catch {
    return null;
  }
  if (raw.length < width * height) return null;

  const hist = new Uint32Array(256);
  for (let i = 0; i < width * height; i++) hist[raw[i]]++;
  let bg = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[bg]) bg = v;

  const minInkPixels = Math.max(1, Math.floor(width * 0.002));
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    let ink = 0;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (Math.abs(raw[row + x] - bg) > 12) {
        ink++;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
    if (ink > minInkPixels) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return { top: 0, bottom: 0, left: 0, right: 0, coverage: 0, coverageX: 0 };
  return {
    top,
    bottom,
    left,
    right,
    coverage: (bottom - top + 1) / height,
    coverageX: right < 0 ? 0 : (right - left + 1) / width,
  };
}

/** Devuelve los PNG que no llenan el alto, con el dato para pedir la correccion. */
export function findThinLayouts(pngs, plan, ffmpegPath) {
  const bad = [];
  for (let i = 0; i < pngs.length; i++) {
    const ink = measureInk(pngs[i], plan.width, plan.height, ffmpegPath);
    if (!ink) return bad; // sin ffmpeg no se mide y no se inventa un veredicto
    // Alto y ancho: medir solo el alto dejaba pasar composiciones que se
    // apretujaban contra el borde izquierdo con media pantalla vacia a la derecha.
    // En vertical el contenido vive en la franja central (las apps tapan arriba
    // y abajo): exigirle el 60% del alto total seria pedirle que invada
    // justamente lo que se va a tapar.
    const minY = plan.height > plan.width ? MIN_INK_COVERAGE_VERTICAL : MIN_INK_COVERAGE;
    const thinY = ink.coverage < minY;
    const thinX = ink.coverageX < MIN_INK_COVERAGE_X;
    if (thinY || thinX) {
      bad.push({
        index: i,
        file: plan.scenes?.[i]?.file ?? `escena ${i + 1}`,
        coverage: ink.coverage,
        coverageX: ink.coverageX,
        axis: thinY && thinX ? "alto y ancho" : thinY ? "alto" : "ancho",
        top: ink.top,
        bottom: ink.bottom,
        left: ink.left,
        right: ink.right,
      });
    }
  }
  return bad;
}

async function buildStills(cfg, item, plan, projectDir, contentDir, pngs, { log, deps }) {
  // Los PNG ya los tomo la revision visual: son el estado final de las escenas.
  const thin = findThinLayouts(pngs, plan, resolveFfmpeg());
  if (thin.length) {
    const detalle = thin
      .map(
        (t) =>
          `${t.file}: ${Math.round(t.coverage * 100)}% del alto (y ${t.top}-${t.bottom}) y ` +
          `${Math.round(t.coverageX * 100)}% del ancho (x ${t.left}-${t.right}) — flojo en ${t.axis}`,
      )
      .join("; ");
    log?.(`layout flojo en ${thin.length}/${pngs.length}: ${detalle}`);
    // Borrar SOLO las composiciones flojas. Como el brief no cambia, ensureProject
    // conserva el resto: el proximo intento rehace unicamente estas y reusa las que
    // ya pasaron. Sin este borrado se reusaria la mala y fallaria en bucle.
    const notes = readLayoutNotes(projectDir);
    for (const t of thin) {
      const bad = join(projectDir, t.file);
      if (existsSync(bad)) {
        rmSync(bad, { force: true });
        log?.(`  descartada para rehacer: ${t.file}`);
      }
      notes[t.file] =
        `El intento anterior quedo flojo en ${t.axis}: ocupo el ${Math.round(t.coverage * 100)}% del alto ` +
        `(y ${t.top}-${t.bottom} de ${plan.height}px) y el ${Math.round(t.coverageX * 100)}% del ancho ` +
        `(x ${t.left}-${t.right} de ${plan.width}px). Hace falta al menos ${Math.round(MIN_INK_COVERAGE * 100)}% ` +
        `del alto y ${Math.round(MIN_INK_COVERAGE_X * 100)}% del ancho. Componer para el lienzo entero: ` +
        `usar las dos mitades, no amontonar todo arriba a la izquierda.`;
    }
    writeLayoutNotes(projectDir, notes);
    throw new GenerateError(
      `el contenido no llena el alto del lienzo — ${detalle}. ` +
        `Cada composicion tiene que ocupar al menos el ${Math.round(MIN_INK_COVERAGE * 100)}% del alto ` +
        `(regla 8b): bajar el bloque de apoyo, repartir el aire entre bloques, no dejar la mitad inferior vacia.`,
      { phase: "layout", itemId: item.id, thin },
    );
  }

  if (plan.kind === "still") {
    const dest = join(contentDir, "image.png");
    copyFileSync(pngs[0], dest);
    log?.(`imagen lista: ${dest}`);
    return { assetPath: dest, previewPath: dest };
  }

  const slidesDir = join(contentDir, "slides");
  rmSync(slidesDir, { recursive: true, force: true });
  mkdirSync(slidesDir, { recursive: true });
  const dests = carouselSlidePaths(slidesDir, plan.scenes.length);
  dests.forEach((dest, i) => copyFileSync(pngs[i], dest));
  log?.(`carrusel listo: ${dests.length} slides en ${slidesDir}`);
  return { assetPath: slidesDir, previewPath: dests[0] };
}

async function buildVideo(cfg, item, brief, plan, projectDir, contentDir, { log, deps }) {
  const rel = "renders/video.mp4";
  log?.(`render: hyperframes graba ${plan.total ?? "los"} segundos de video frame a frame en calidad alta — varios minutos, mas cuanto mas largo el video`);
  const res = await deps.hyperframes(cfg, projectDir, ["render", "--quality", "high", "--output", rel], {
    timeoutMs: RENDER_TIMEOUT_MS,
    log,
  });
  const mp4 = join(projectDir, "renders", "video.mp4");
  if (!existsSync(mp4)) {
    throw new GenerateError(`hyperframes render no produjo el MP4: ${summarizeCheck(res).texto.slice(0, 800)}`, {
      phase: "render",
      itemId: item.id,
    });
  }
  const dest = join(contentDir, "video.mp4");
  copyFileSync(mp4, dest);

  // preview_path SIEMPRE tiene que existir: Telegram necesita mostrar algo.
  const at = pickPreviewTime(brief, plan);
  const previewDest = join(contentDir, "preview.png");
  let previewPath = null;
  if (await deps.ffmpeg(dest, at, previewDest, { log })) {
    // El preview es lo que se ve en Telegram y en el panel: si cayo en una
    // transicion o en un respiro de la animacion, es un rectangulo negro. Se
    // mide y, si esta vacio, se prueba en otros momentos de la pieza.
    previewPath = previewDest;
  } else {
    // Degradacion 1: pedirle el frame al propio renderer.
    const outRel = `snapshots/preview-${item.revision ?? 0}`;
    const outDir = join(projectDir, outRel);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const snap = await deps.hyperframes(cfg, projectDir, ["snapshot", "--at", String(at), "--no-end", "-o", outRel], {
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      log,
    });
    const pngs = snapshotOutputs(outDir);
    if (pngs.length) {
      copyFileSync(pngs[0], previewDest);
      previewPath = previewDest;
    } else {
      log?.(`sin preview propio (snapshot code ${snap.code}); se usa el MP4 como preview`);
      previewPath = dest; // Degradacion 2: que Telegram mande el video directamente.
    }
  }
  log?.(`video listo: ${dest}`);
  return { assetPath: dest, previewPath };
}

// ---------------------------------------------------------------------------
// API publica
// ---------------------------------------------------------------------------

/**
 * Genera un item completo. Deja el item en `built` o lo devuelve a `planned`
 * con el error: nunca queda colgado en `building`.
 */
/**
 * Cambia el marcador de fuentes por el CSS real en cada composicion que escribio
 * el modelo. Va despues de writeCompositions y antes del check: si el marcador
 * llegara al renderer, la fuente de display no cargaria y el texto saldria con
 * una fallback del sistema — el defecto exacto que arruinaba los videos.
 */
export function applyFonts(projectDir, plan, { log } = {}) {
  // Cada marca trae su propio css de fuentes (brand.css); el proyecto viejo
  // traia bricolage.css. Se toma lo que haya en la carpeta.
  const fontsDir = join(projectDir, "assets", "fonts");
  const hojas = safeList(fontsDir).filter((f) => f.endsWith(".css"));
  if (!hojas.length) {
    log?.("aviso: el proyecto no tiene css de fuentes; las composiciones quedan con la del sistema");
    return 0;
  }
  const css = hojas.map((f) => readFileSync(join(fontsDir, f), "utf8")).join("\n");
  let n = 0;
  for (const scene of plan.scenes ?? []) {
    const file = join(projectDir, scene.file ?? "");
    if (!scene.file || !existsSync(file)) continue;
    const html = readFileSync(file, "utf8");
    if (html.includes("data:font/woff2")) continue; // ya tiene las fuentes
    const out = injectFonts(html, css);
    if (out !== html) {
      writeFileSync(file, out);
      n++;
    }
  }
  if (n) log?.(`fuentes embebidas en ${n} composicion(es)`);
  return n;
}

/**
 * El brief guardado, si corresponde a la revision actual del item.
 *
 * `__forRevision` lo estampa generateItem al crearlo. Un rechazo del usuario sube
 * `revision`, el sello deja de coincidir y el brief se rehace atendiendo el nuevo
 * feedback. Un reintento por un fallo tecnico conserva el brief — y con el, las
 * composiciones que ya habian pasado.
 */
export function reusableBrief(item) {
  if (!item?.brief) return null;
  let parsed;
  try {
    parsed = JSON.parse(item.brief);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return (parsed.__forRevision ?? -1) === (item.revision ?? 0) ? parsed : null;
}

/**
 * La bitacora de una pieza: cada linea va a la consola (si hay) y a la base con
 * su nivel (info | aviso | error), para que el panel muestre lo mismo que se ve
 * en una terminal — en vivo mientras corre y despues.
 */
export function bitacoraDe(store, itemId, log) {
  return (texto, nivel = "info") => {
    log?.(texto);
    try {
      store.addLog(itemId, nivel, texto);
    } catch {
      /* la bitacora no puede tumbar la generacion */
    }
  };
}

/**
 * La marca de una pieza: la suya, o la marca por defecto si la pieza es vieja.
 * Sin marcas todavia, devuelve null y el pipeline cae al proyecto de la config.
 */
export function resolveBrand(store, item) {
  const propia = item?.brand_id ? store.getBrand(item.brand_id) : null;
  return propia ?? store.defaultBrand();
}

export async function generateItem(cfg, store, itemId, { log: logExterno, deps: overrides } = {}) {
  const deps = { ...defaultDeps(), ...(overrides ?? {}) };
  const item = store.getItem(itemId);
  if (!item) throw new GenerateError(`item no encontrado: ${itemId}`);
  const formatCfg = validateFormat(cfg, item.format);
  const brand = resolveBrand(store, item);
  // Todo lo que se diga de esta pieza va a la consola Y a la base: el panel
  // muestra la bitacora en vivo y despues.
  const log = bitacoraDe(store, item.id, logExterno);
  store.pruneLogs(item.id);

  // Un solo generador por item. Sin esto dos procesos (el panel y una terminal,
  // por ejemplo) escriben la misma fila de `jobs` y el contador de escenas va
  // 2 -> 4 -> 3; peor todavia, se paga el doble y se pisan los archivos.
  const staleSeconds = Number(cfg.limits?.jobStaleSeconds ?? 120);
  const live = store.activeJobs({ staleSeconds }).find((j) => j.item_id === item.id && !j.stale);
  if (live && !jobAlive(live)) {
    // El proceso que lo tenia murio (Ctrl+C, taskkill, corte de luz): el job es
    // un fantasma y no tiene por que hacer esperar dos minutos.
    store.endJob(item.id);
    log?.(`[${item.id}] habia un job del pid ${live.pid}, que ya no existe: lo descarto`);
  } else if (live) {
    throw new GenerateError(
      `${item.id} ya se esta generando (fase ${live.phase ?? "?"}, pid ${live.pid}, ` +
        `latido hace ${live.silent_s}s, empezo hace ${live.age_s}s)`,
      { phase: "lock", itemId: item.id },
    );
  }

  const contentDir = contentDirFor(cfg, item.id);
  let costUsd = 0;
  let pulse = null;

  try {
    // ---- fase 1: brief -----------------------------------------------------
    // El registro del trabajo va PRIMERO: el brief tarda uno o dos minutos y, si
    // se anotaba despues, el panel decia "planificado" mientras ya se estaba
    // trabajando. Ese hueco era justo lo que hacia dudar si estaba corriendo.
    store.startJob(item.id, { kind: "generate", phase: "brief" });
    // Latido periodico ademas del de cada fase: una fase larga (el brief tarda uno
    // o dos minutos, un render varios) quedaba en silencio y parecia un proceso
    // muerto. Con esto el silencio solo crece de verdad cuando el proceso murio,
    // que es lo que permite bajar el umbral de `stale` sin falsos positivos.
    pulse = setInterval(() => {
      try {
        store.beat(item.id);
      } catch {
        /* si la base no acepta el latido, el trabajo se marcara stale y esta bien */
      }
    }, BEAT_INTERVAL_MS);
    pulse.unref?.(); // no debe impedir que el proceso termine

    // Reusar el brief guardado si sigue valiendo para esta revision.
    //
    // Rehacerlo en cada intento salia caro dos veces: la llamada al modelo, y que
    // el brief nuevo casi nunca daba el mismo hash — asi que ensureProject borraba
    // TODAS las composiciones y el progreso parcial nunca llegaba a aplicarse. El
    // brief se rehace cuando no hay, o cuando el usuario rechazo (sube revision).
    const saved = reusableBrief(item);
    let brief;
    log?.(`[${item.id}] generacion de ${item.format} (revision ${item.revision ?? 0})`);
    if (saved) {
      brief = saved;
      log?.(`brief reusado de esta misma revision: no se vuelve a pagar; se va directo a componer`);
    } else {
      log?.(
        `brief (${item.format}${item.feedback ? ", con feedback de rechazo" : ""}): el modelo decide narrativa, escenas y copy — una llamada, suele tardar 1 a 2 minutos`,
      );
      const made = await makeBrief(cfg, store, item, formatCfg, { log, deps, brand });
      brief = made.brief;
      costUsd += made.cost;
      brief.__forRevision = item.revision ?? 0;
    }
    store.setStatus(item.id, "briefed", { brief: JSON.stringify(brief, null, 2), error: null });

    // ---- fase 2: building --------------------------------------------------
    // El registro en memoria cubre el caso "el proceso muere": su handler de exit
    // devuelve el item a planned. El de la base es el que ve el panel.
    armInflight(store, item.id);
    store.setStatus(item.id, "building");
    store.beat(item.id, "compose");
    mkdirSync(contentDir, { recursive: true });

    let assetPath;
    let previewPath;

    if (formatKind(item.format, formatCfg) === "text") {
      // El brief es el entregable: una sola llamada al modelo para todo el post.
      assetPath = join(contentDir, "post.md");
      writeFileSync(assetPath, renderPostMarkdown(brief, item));
      // No hay imagen; el preview apunta al propio post para que Telegram tenga algo que mandar.
      previewPath = assetPath;
      log?.(`post listo: ${assetPath}`);
    } else {
      const plan = planScenes({ format: item.format, formatCfg, brief, itemId: item.id });
      const projectDir = ensureProject(cfg, item, { log, brief, brand });
      const gsapTag = extractGsapTag(safeRead(join(brand?.projectDir ?? cfg.hyperframes.referenceProject, "index.html")));
      // Diseno sonoro solo en video: una imagen o un carrusel no llevan audio.
      const sfxDir = join(projectDir, "assets", "sfx");
      const sfx =
        plan.kind === "motion" && existsSync(sfxDir)
          ? sfxTrack(plan, { available: readdirSync(sfxDir) })
          : [];
      const indexHtml = renderIndexHtml({ id: "main", plan, gsapTag, sfx });
      writeFileSync(join(projectDir, "index.html"), indexHtml);

      costUsd += await writeCompositions(cfg, store, item, formatCfg, brief, plan, projectDir, { log, deps, brand });
      applyFonts(projectDir, plan, { log });
      store.beat(item.id, "check");
      costUsd += await checkAndRepair(cfg, store, item, formatCfg, brief, plan, projectDir, indexHtml, { log, deps, brand });
      const revisado = await reviewAndRepair(cfg, store, item, formatCfg, brief, plan, projectDir, indexHtml, { log, deps, brand });
      costUsd += revisado.cost;
      store.beat(item.id, "render");

      const built =
        plan.kind === "motion"
          ? await buildVideo(cfg, item, brief, plan, projectDir, contentDir, { log, deps })
          : await buildStills(cfg, item, plan, projectDir, contentDir, revisado.pngs, { log, deps });
      assetPath = built.assetPath;
      previewPath = built.previewPath;

      if (brief.caption) writeFileSync(join(contentDir, "caption.md"), `${brief.caption}\n`);
    }

    // ---- fase 3: built -----------------------------------------------------
    store.setStatus(item.id, "built", {
      asset_path: assetPath,
      preview_path: previewPath,
      error: null,
    });
    clearInterval(pulse);
    disarmInflight(store, item.id);
    try {
      store.endJob(item.id);
    } catch {
      /* el estado del item ya se escribio; el job huerfano lo limpia rescueStuck */
    }
    store.logRun({
      kind: "render",
      itemId: item.id,
      costUsd: null,
      ok: true,
      detail: `built ${item.format} (la pieza costo $${costUsd.toFixed(4)}, ya contado en brief/compose)`,
    });
    return { itemId: item.id, assetPath, previewPath, costUsd };
  } catch (err) {
    const detail = String(err?.message ?? err);
    // Nunca dejar el item en `building`.
    try {
      // El layout NO va a `feedback`: feedback es lo que pidio el usuario y entra
      // al brief, y cambiar el brief borraria TODAS las composiciones, incluidas
      // las que ya habian pasado. El aviso de layout viaja por el proyecto
      // (.bca/layout-notes.json) y solo afecta a la escena que fallo.
      store.setStatus(item.id, "planned", { error: detail.slice(0, 4000) });
    } catch {
      // si ni siquiera se puede escribir el estado, el error original manda
    } finally {
      clearInterval(pulse);
      disarmInflight(store, item.id);
      // Tambien en el camino de error: si no, el panel muestra "generando" para
      // siempre un item que ya fallo.
      try {
        store.endJob(item.id);
      } catch {
        /* lo barre rescueStuck cuando el latido quede viejo */
      }
    }
    // Igual que en el camino feliz: el gasto ya esta anotado por fase, aca solo
    // se registra que la pieza fallo.
    store.logRun({ kind: "render", itemId: item.id, costUsd: null, ok: false, detail: detail.slice(0, 1000) });
    log?.(`[${item.id}] fallo: ${detail}`);
    throw err;
  }
}

/** Contenido de un directorio, o vacio si no existe. */
function safeList(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Genera lo pendiente respetando cfg.limits.maxConcurrentGenerations.
 * Un item que falla no aborta el lote: se registra y se sigue.
 */
/**
 * Fases cuyo fallo mejora solo con volver a intentar.
 *
 * No es optimismo: cada una deja el terreno preparado para el intento
 * siguiente. `layout` borra las composiciones flojas y anota por que;
 * `check`/`repair` dejan el dictamen del linter; `compose` conserva las escenas
 * que si salieron. Un fallo de `brief` o de `lock`, en cambio, va a fallar
 * igual: esos no se reintentan.
 */
export const RETRIABLE_PHASES = new Set(["layout", "check", "repair", "compose", "snapshot"]);

// `check-estancado` queda AFUERA a proposito. Es el fallo de check en el que el
// mismo error bloqueante (misma firma) volvio cuatro veces: sobrevivio a dos
// reparaciones y a recomponer la escena desde el brief. El problema no es una
// mala tirada del modelo, es que el brief pide algo que esa escena no puede
// cumplir. Reintentar la pieza entera cuesta un compose y otra ronda de
// reparaciones para terminar en el mismo lugar. Mejor fallar con el dictamen a
// la vista y que alguien decida (rechazar con feedback rehace el brief).

/**
 * Genera un item y, si el fallo es de los que mejoran con el siguiente intento,
 * lo reintenta. Sin esto cada pieza pedia una segunda pasada a mano: el sistema
 * ya sabia que hacer, solo faltaba que alguien volviera a apretar el boton.
 */
export async function generateWithRetry(cfg, store, itemId, { log, deps, retries } = {}) {
  const max = Number.isFinite(Number(retries ?? cfg.limits?.retriesPerItem))
    ? Math.max(0, Number(retries ?? cfg.limits?.retriesPerItem))
    : 1;
  let last;
  for (let attempt = 0; ; attempt++) {
    try {
      return await generateItem(cfg, store, itemId, { log, deps });
    } catch (err) {
      last = err;
      const phase = err?.phase;
      if (attempt >= max || !RETRIABLE_PHASES.has(phase)) throw err;
      bitacoraDe(store, itemId, log)(
        `[${itemId}] fallo en ${phase}; reintento ${attempt + 2}/${max + 1} — se reusan el brief y las escenas que ya estaban bien`,
        "aviso",
      );
    }
  }
}

export async function generatePending(cfg, store, { limit, through, brandId, log, deps } = {}) {
  rescueStuck(store, { log });

  const maxRegen = Number(cfg.limits?.maxRegenerationsPerItem ?? Infinity);
  const take = Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : 20;

  const candidates = store
    .listItems({ status: ["planned", "briefed"], to: through ?? undefined, brandId, limit: 500 })
    .filter((it) => {
      if ((it.revision ?? 0) > maxRegen) {
        log?.(`[${it.id}] omitido: supera maxRegenerationsPerItem (${maxRegen})`);
        return false;
      }
      try {
        validateFormat(cfg, it.format);
        return true;
      } catch (err) {
        log?.(`[${it.id}] omitido: ${err.message}`);
        return false;
      }
    })
    .slice(0, take);

  const concurrency = Math.max(1, Number(cfg.limits?.maxConcurrentGenerations ?? 1));
  log?.(`generando ${candidates.length} item(s), concurrencia ${concurrency}`);

  return mapLimit(candidates, concurrency, async (item) => {
    try {
      return { ...(await generateWithRetry(cfg, store, item.id, { log, deps })), ok: true };
    } catch (err) {
      return { itemId: item.id, ok: false, error: String(err?.message ?? err) };
    }
  });
}
