// Layouts prefabricados de escena: composiciones HyperFrames que el codigo
// renderiza a partir de la marca y de unos pocos huecos (kicker, display,
// support, cues, stat...).
//
// Por que existen: cuando el modelo escribia cada escena desde cero salian
// palabras partidas a mitad de linea, mitades del lienzo vacias, numeros que
// no aparecian y textos tapados. Todo eso pasa por diseñar sin ojos. Un layout
// prefabricado ya resolvio la maquetacion (columnas, aire, jerarquia, safe area
// vertical, ajuste del tipo para que ninguna palabra se corte, timeline
// seek-safe) y deja al modelo lo que hace bien: elegir que layout va con que
// escena y que dice cada hueco.
//
// Agnosticos de marca por construccion: NO traen un solo color ni familia
// tipografica propios. Todo sale de `brand.palette` (bg, surface, ink, muted,
// hint, line, accent, onAccent) y `brand.fonts` (display, mono), y las medidas
// se calculan del lienzo (1 unidad = 1% del ancho, como el `cqw` de frame.md).
// Cualquier marca que pase por normalizePalette rinde legible con estos
// layouts; el registro (dark/light) se resuelve por escena invirtiendo tierra y
// tinta y re-derivando los tonos intermedios con el contraste garantizado.
//
// El HTML que sale cumple HARD_RULES de generate.mjs: root con data-*, tierra
// en una capa .clip, timeline unica pausada en window.__timelines[id], estados
// iniciales con gsap.set inmediato, solo transforms/opacity, un elemento vivo
// (la regla que crece) durante todo el hold, ids estables, marcador de fuentes.

import { contrast, esOscuro, forzarContraste, mezclar, toHex } from "./color.mjs";

export const FONT_MARKER = "/* @@BCA_FONTS@@ */";

// Escala tipografica en unidades (1u = 1% del ancho del lienzo), la misma que
// declara renderFrameMd. Se repite aca para no parsear el YAML de vuelta.
const RAMP = {
  display: 11.0,
  h1: 7.5,
  stat: 5.5,
  h2: 4.5,
  h3: 2.8,
  support: 2.2, // entre lead y h3: la linea de apoyo de un poster
  lead: 1.7,
  body: 1.5,
  label: 1.25,
  caption: 1.15,
};

const PAD = 5.5; // u: pad-x / pad-y de frame.md
const GAP_LG = 3.5;
const GAP_MD = 2;
const GAP_SM = 1;

// ---------------------------------------------------------------------------
// Tonos por registro
// ---------------------------------------------------------------------------

/**
 * La paleta de la marca aplicada a un registro. En el registro "natural" (el
 * fondo de la marca ya es de ese tono) se usa tal cual; en el invertido, la
 * tinta pasa a ser tierra y los intermedios se re-derivan forzando el
 * contraste, porque muted/hint/line de la paleta estan pensados contra `bg`.
 */
export function tonos(palette = {}, register = "dark") {
  const bg = toHex(palette.bg) ?? "#0C0F08";
  const ink = toHex(palette.ink) ?? "#E8EDDF";
  const accent = toHex(palette.accent) ?? "#C4EF3D";
  const quiereOscuro = register !== "light";
  const natural = esOscuro(bg) === quiereOscuro;

  if (natural) {
    return {
      ground: bg,
      surface: toHex(palette.surface) ?? mezclar(bg, ink, 0.05),
      ink,
      muted: toHex(palette.muted) ?? forzarContraste(mezclar(ink, bg, 0.35), bg, 4.5),
      hint: toHex(palette.hint) ?? forzarContraste(mezclar(ink, bg, 0.5), bg, 3),
      line: toHex(palette.line) ?? mezclar(ink, bg, 0.85),
      accent: forzarContraste(accent, bg, 3),
      accentText: forzarContraste(accent, bg, 4.5),
      onAccent: toHex(palette.onAccent) ?? (esOscuro(accent) ? "#FFFFFF" : "#000000"),
    };
  }
  const ground = ink;
  const tinta = bg;
  return {
    ground,
    surface: mezclar(ground, tinta, 0.06),
    ink: tinta,
    // 4.5:1 es AA pero en una etiqueta mono chica se ve apagado (lo marco la
    // revision visual en una corrida real): se pide mas.
    muted: forzarContraste(mezclar(tinta, ground, 0.3), ground, 6),
    hint: forzarContraste(mezclar(tinta, ground, 0.5), ground, 3),
    line: mezclar(tinta, ground, 0.86),
    accent: forzarContraste(accent, ground, 3),
    // El acento en texto chico (kicker, etiquetas, url) tiene que llegar a AA.
    accentText: forzarContraste(accent, ground, 4.5),
    onAccent: toHex(palette.onAccent) ?? (esOscuro(accent) ? "#FFFFFF" : "#000000"),
  };
}

// ---------------------------------------------------------------------------
// Medir y ajustar texto (sin fuente cargada: estimacion conservadora)
// ---------------------------------------------------------------------------

/**
 * Ancho estimado de un texto en px. No hay metricas reales de la fuente aca,
 * asi que se estima por clase de glifo con margen: preferible que una linea
 * quede un poco mas corta que verla partirse en dos donde no se planeo.
 */
export function anchoTexto(text, px, { weight = 400, tracking = 0 } = {}) {
  let em = 0;
  for (const ch of String(text)) {
    if (ch === " ") em += 0.3;
    else if (/[A-ZÁÉÍÓÚÑÜ]/.test(ch)) em += 0.68;
    else if (/[a-záéíóúñü]/.test(ch)) em += 0.55;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else if (/[.,:;'!|]/.test(ch)) em += 0.3;
    else if (/[mwMW@%]/.test(ch)) em += 0.85;
    else em += 0.6;
    em += tracking;
  }
  const bold = weight >= 700 ? 1.06 : weight >= 600 ? 1.03 : 1;
  return em * px * bold * 1.04;
}

/**
 * Corta `text` en lineas de a lo sumo `maxWidth` px a `px`, sin partir
 * palabras nunca. Devuelve null si una palabra sola no entra: hay que bajar el
 * cuerpo, no romperla.
 */
function partirEnLineas(text, px, maxWidth, medida) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let actual = "";
  for (const w of words) {
    if (anchoTexto(w, px, medida) > maxWidth) return null;
    const prueba = actual ? `${actual} ${w}` : w;
    if (anchoTexto(prueba, px, medida) <= maxWidth) {
      actual = prueba;
    } else {
      lines.push(actual);
      actual = w;
    }
  }
  if (actual) lines.push(actual);
  return lines;
}

/**
 * El cuerpo mas grande (<= maxPx) con el que el texto entra en `maxLines`
 * lineas de `maxWidth` px sin partir palabras y sin pasar `maxHeight`.
 * Devuelve { px, lines }. Si ni con minPx entra en las lineas pedidas, se
 * queda en minPx y deja las lineas que hagan falta: la revision visual lo ve.
 */
export function ajustarTexto(text, { maxWidth, maxPx, minPx, maxLines = 2, lineHeight = 1, maxHeight = Infinity, weight = 700, tracking = 0 }) {
  const medida = { weight, tracking };
  const lo = Math.max(8, Math.round(minPx));
  for (let px = Math.round(maxPx); px >= lo; px -= Math.max(1, Math.round(maxPx / 60))) {
    const lines = partirEnLineas(text, px, maxWidth, medida);
    if (!lines) continue;
    if (lines.length <= maxLines && lines.length * px * lineHeight <= maxHeight) return { px, lines };
  }
  const lines = partirEnLineas(text, lo, maxWidth, medida) ?? [String(text).trim()];
  return { px: lo, lines };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Envuelve `accent` (palabra o frase, sin distinguir mayusculas) en .hot. */
function conAcento(line, accent) {
  const t = esc(line);
  const a = String(accent ?? "").trim();
  if (!a) return t;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^\\p{L}\\p{N}])`, "iu");
  return t.replace(re, (_, pre, hit) => `${pre}<span class="hot">${hit}</span>`);
}

const r = (n) => Math.round(n);

// ---------------------------------------------------------------------------
// Contexto de una escena
// ---------------------------------------------------------------------------

/**
 * Geometria comun: caja util (safe area en vertical), unidad, tonos, fuentes.
 * `scene` es la del plan (compId, hold, duration, index); `total` cuantas hay.
 */
function contexto({ brand, width, height, scene, total, register, vertical }) {
  const u = width / 100;
  const pad = PAD * u;
  const T = vertical ? r(height * 0.14 + 2 * u) : r(pad);
  const B = vertical ? r(height * 0.8 - 2 * u) : r(height - pad);
  const L = r(pad);
  const R = r(width - pad);
  return {
    u,
    pad,
    W: R - L,
    H: B - T,
    L,
    R,
    T,
    B,
    width,
    height,
    vertical: Boolean(vertical),
    landscape: width > height,
    tone: tonos(brand?.palette, register),
    display: brand?.fonts?.display?.family ?? "Inter",
    mono: brand?.fonts?.mono?.family ?? "JetBrains Mono",
    id: `s${String(scene.compId).replace(/[^A-Za-z0-9_-]/g, "-")}`,
    compId: scene.compId,
    hold: Number(scene.hold) || 4,
    duration: Number(scene.duration) || Number(scene.hold) || 4,
    n: (scene.index ?? 0) + 1,
    total: total ?? 1,
    brandName: brand?.name ?? "",
  };
}

/** Kicker + pie (chrome): lo que toda escena comparte para leerse como una serie. */
function chrome(c, { kicker, right } = {}) {
  const labelPx = r(RAMP.label * c.u * (c.landscape ? 1.15 : 1));
  const capPx = r(RAMP.caption * c.u * (c.landscape ? 1.1 : 1));
  const css = `
    .${c.id}-kicker { position:absolute; left:${c.L}px; top:${c.T}px; font-family:"${c.mono}",monospace; font-size:${labelPx}px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:${c.tone.accentText}; white-space:nowrap; }
    .${c.id}-foot { position:absolute; left:${c.L}px; right:${c.width - c.R}px; top:${c.B - capPx}px; height:${capPx}px; display:flex; justify-content:space-between; align-items:center; font-family:"${c.mono}",monospace; font-size:${capPx}px; letter-spacing:.12em; text-transform:uppercase; color:${c.tone.muted}; white-space:nowrap; }
    .${c.id}-rule { position:absolute; left:${c.L}px; top:${c.B - capPx - r(GAP_MD * c.u)}px; width:${r(22 * c.u)}px; height:${Math.max(2, r(0.2 * c.u))}px; background:${c.tone.accent}; transform-origin:left center; }`;
  const derecha = right ?? (c.total > 1 ? `${String(c.n).padStart(2, "0")} / ${String(c.total).padStart(2, "0")}` : "");
  const html = [
    kicker ? `<div id="${c.id}-kicker" class="${c.id}-kicker">${esc(kicker)}</div>` : "",
    `<div id="${c.id}-rule" class="${c.id}-rule"></div>`,
    `<div id="${c.id}-foot" class="${c.id}-foot"><span>${esc(c.brandName)}</span><span>${esc(derecha)}</span></div>`,
  ].join("\n      ");
  const footTop = c.B - capPx - r(GAP_MD * c.u) - r(GAP_SM * c.u); // arriba de la regla
  return { css, html, footTop, kickerBottom: c.T + labelPx };
}

/** Un bloque de titular en lineas explicitas (cada linea su span, sin partir palabras). */
function titular(c, { cls, text, accent, maxWidth, maxPx, minPx, maxLines, maxHeight, lineHeight = 0.95, weight = 800, tracking = -0.03, color, align = "left", top, left, width }) {
  const fit = ajustarTexto(text, { maxWidth, maxPx, minPx, maxLines, lineHeight, maxHeight, weight, tracking });
  const heightPx = r(fit.lines.length * fit.px * lineHeight);
  const css = `
    .${cls} { position:absolute; left:${r(left)}px; top:${r(top)}px; width:${r(width)}px; font-family:"${c.display}",sans-serif; font-size:${fit.px}px; font-weight:${weight}; line-height:${lineHeight}; letter-spacing:${tracking}em; color:${color ?? c.tone.ink}; text-align:${align}; }
    .${cls} .line { display:block; white-space:nowrap; }
    .${cls} .hot { color:${c.tone.accent}; }`;
  // Con line-height < 1 las cajas de las lineas se tocan: es a proposito y se declara.
  const allow = lineHeight < 1 ? " data-layout-allow-overlap" : "";
  const html = `<div id="${cls}" class="${cls}">${fit.lines.map((l, i) => `<span id="${cls}-l${i + 1}" class="line"${allow}>${conAcento(l, accent)}</span>`).join("")}</div>`;
  return { css, html, height: heightPx, px: fit.px, lines: fit.lines.length, selectorLineas: `.${cls} .line` };
}

/** Un parrafo de apoyo: cuerpo fijo, hasta N lineas, sin partir palabras. */
function apoyo(c, { cls, text, accent, maxWidth, px, maxLines = 2, lineHeight = 1.4, color, top, left, width, align = "left", weight = 400 }) {
  const fit = ajustarTexto(text, { maxWidth, maxPx: px, minPx: px * 0.7, maxLines, lineHeight, weight, tracking: 0 });
  const css = `
    .${cls} { position:absolute; left:${r(left)}px; top:${r(top)}px; width:${r(width)}px; font-family:"${c.display}",sans-serif; font-size:${fit.px}px; font-weight:${weight}; line-height:${lineHeight}; color:${color ?? c.tone.muted}; text-align:${align}; }
    .${cls} .line { display:block; white-space:nowrap; }
    .${cls} .hot { color:${c.tone.accent}; }`;
  const html = `<div id="${cls}" class="${cls}">${fit.lines.map((l, i) => `<span class="line">${conAcento(l, accent)}</span>`).join("")}</div>`;
  return { css, html, height: r(fit.lines.length * fit.px * lineHeight), px: fit.px };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * Los tiempos de una escena en funcion de su hold. Las entradas terminan antes
 * del 72% (un still se fotografia al 85%: todo debe estar quieto y legible), y
 * la regla del pie crece hasta el 96%: algo cambia de geometria durante todo
 * el hold, que es lo que evita el sweep_static del check.
 */
function tiempos(hold, nLista = 0, solape = 0) {
  const t = {
    // En video las escenas se funden 0.4s con la anterior: el kicker y el pie
    // ocupan el mismo lugar en todas, asi que entran cuando el fundido termino
    // (si no, el check marca el solape entre ambas escenas).
    kicker: 0.1 + solape,
    foot: 0.3 + solape,
    display: 0.22,
    displayStagger: 0.1,
    support: 0.7,
    lista: [],
    ruleAt: Math.max(0.6, hold * 0.45),
    ruleDur: Math.max(0.6, hold * 0.96 - Math.max(0.6, hold * 0.45)),
  };
  if (nLista > 0) {
    // De la primera a la ultima entrada entre el 20% y el 58% del hold: la
    // ultima termina de entrar (0.6s) antes del 85%, que es cuando se
    // fotografia un still.
    const t0 = Math.min(0.9, hold * 0.2);
    const t1 = hold * 0.58;
    for (let i = 0; i < nLista; i++) t.lista.push(nLista === 1 ? t0 : t0 + (i * (t1 - t0)) / (nLista - 1));
  }
  return t;
}

/** El script de la timeline: un solo gsap.timeline pausado, seek-safe. */
function timeline(c, pasos) {
  const sets = [];
  const tweens = [];
  for (const p of pasos) {
    if (p.tipo === "up") {
      sets.push(`gsap.set(${JSON.stringify(p.sel)}, { opacity: 0, y: ${p.y ?? 26} });`);
      tweens.push(
        `tl.fromTo(${JSON.stringify(p.sel)}, { opacity: 0, y: ${p.y ?? 26} }, { opacity: 1, y: 0, duration: ${(p.dur ?? 0.62).toFixed(2)}, ease: "power3.out"${p.stagger ? `, stagger: ${p.stagger.toFixed(2)}` : ""} }, ${p.at.toFixed(2)});`,
      );
    } else if (p.tipo === "fade") {
      sets.push(`gsap.set(${JSON.stringify(p.sel)}, { opacity: 0 });`);
      tweens.push(`tl.fromTo(${JSON.stringify(p.sel)}, { opacity: 0 }, { opacity: 1, duration: ${(p.dur ?? 0.5).toFixed(2)}, ease: "power2.out" }, ${p.at.toFixed(2)});`);
    } else if (p.tipo === "grow") {
      sets.push(`gsap.set(${JSON.stringify(p.sel)}, { scaleX: 0 });`);
      tweens.push(`tl.fromTo(${JSON.stringify(p.sel)}, { scaleX: 0 }, { scaleX: 1, duration: ${(p.dur ?? 1).toFixed(2)}, ease: "${p.ease ?? "power2.out"}" }, ${p.at.toFixed(2)});`);
    }
  }
  return [
    "  <script>",
    "    window.__timelines = window.__timelines || {};",
    "    (function () {",
    "      var tl = gsap.timeline({ paused: true });",
    ...sets.map((s) => `      ${s}`),
    ...tweens.map((s) => `      ${s}`),
    `      window.__timelines[${JSON.stringify(c.compId)}] = tl;`,
    "    })();",
    "  </script>",
  ].join("\n");
}

/** El documento completo alrededor de un layout. */
function documento(c, { css, html, pasos }) {
  return [
    "<!doctype html>",
    "<template>",
    "  <style>",
    `    ${FONT_MARKER}`,
    `    #root { position:absolute; inset:0; width:${c.width}px; height:${c.height}px; overflow:hidden; container-type:size; font-family:"${c.display}",sans-serif; color:${c.tone.ink}; }`,
    `    .${c.id}-ground { position:absolute; inset:0; background:${c.tone.ground}; }`,
    `    .${c.id}-stage { position:absolute; inset:0; }`,
    css,
    "  </style>",
    "",
    `  <div id="root" data-composition-id="${esc(c.compId)}" data-start="0" data-duration="${c.duration}"`,
    `       data-width="${c.width}" data-height="${c.height}">`,
    `    <div id="${c.id}-ground" class="clip ${c.id}-ground" data-start="0" data-duration="${c.duration}" data-track-index="0"></div>`,
    `    <div id="${c.id}-stage" class="clip ${c.id}-stage" data-start="0" data-duration="${c.duration}" data-track-index="1">`,
    `      ${html}`,
    "    </div>",
    "  </div>",
    "",
    timeline(c, pasos),
    "</template>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Los layouts
// ---------------------------------------------------------------------------

const LAYOUTS = {};

/**
 * hero — kicker, UNA linea de display grande (1-3 lineas), apoyo debajo.
 * El default. Sirve para el gancho, para una afirmacion, para casi todo.
 */
LAYOUTS.hero = {
  id: "hero",
  when: "the default: one big statement (display) with an optional support line. Hook, claim, single message.",
  slots: "kicker?, display, accent_word?, support?",
  render(c, s) {
    const ch = chrome(c, { kicker: s.kicker });
    const t = tiempos(c.hold, 0, c.duration - c.hold);
    const maxLines = 3;
    // Se mide primero y se ubica despues: el bloque entero (display + apoyo)
    // va centrado en la caja util, un poco por encima del medio optico. Antes
    // colgaba del tercio superior y la mitad de abajo quedaba muerta.
    const supH = s.support ? RAMP.support * c.u * 1.4 * 2 + GAP_LG * c.u : 0;
    const disp = titular(c, {
      cls: `${c.id}-display`,
      text: s.display,
      accent: s.accent_word,
      maxWidth: c.W * 0.96,
      maxPx: RAMP.display * c.u,
      minPx: RAMP.h1 * c.u * 0.7,
      maxLines,
      maxHeight: c.H * (c.landscape ? 0.58 : 0.46),
      lineHeight: 0.92,
      top: 0,
      left: c.L,
      width: c.W,
    });
    const top = Math.max(ch.kickerBottom + GAP_LG * c.u, c.T + (c.H - disp.height - supH) / 2 - c.H * 0.06);
    let css = ch.css + disp.css.replace(/top:0px/, `top:${r(top)}px`);
    let html = `${ch.html}\n      ${disp.html}`;
    const pasos = [
      ...(s.kicker ? [{ tipo: "up", sel: `#${c.id}-kicker`, at: t.kicker, y: 14, dur: 0.5 }] : []),
      { tipo: "up", sel: disp.selectorLineas, at: t.display, dur: 0.72, stagger: t.displayStagger, y: 34 },
    ];
    if (s.support) {
      const sup = apoyo(c, {
        cls: `${c.id}-support`,
        text: s.support,
        accent: s.accent_word,
        maxWidth: c.W * 0.7,
        px: RAMP.support * c.u,
        maxLines: 2,
        top: top + disp.height + GAP_LG * c.u,
        left: c.L,
        width: c.W * 0.7,
      });
      css += sup.css;
      html += `\n      ${sup.html}`;
      pasos.push({ tipo: "up", sel: `#${c.id}-support`, at: t.support, dur: 0.6, y: 18 });
    }
    pasos.push({ tipo: "grow", sel: `#${c.id}-rule`, at: t.ruleAt, dur: t.ruleDur, ease: "power1.inOut" }, { tipo: "fade", sel: `#${c.id}-foot`, at: t.foot });
    return documento(c, { css, html, pasos });
  },
};

/**
 * statement — la frase, centrada y grande, con una regla de acento arriba.
 * Para la escena focal, la cita, el momento en que la pieza dice lo suyo.
 */
LAYOUTS.statement = {
  id: "statement",
  when: "the focal moment: one sentence centred and large, nothing competing with it. Use once per piece at most.",
  slots: "kicker?, display, accent_word?, support?",
  render(c, s) {
    const ch = chrome(c, { kicker: s.kicker });
    const t = tiempos(c.hold, 0, c.duration - c.hold);
    const width = c.W * 0.9;
    const left = c.L + (c.W - width) / 2;
    const disp = titular(c, {
      cls: `${c.id}-display`,
      text: s.display,
      accent: s.accent_word,
      maxWidth: width,
      maxPx: RAMP.display * c.u * (c.landscape ? 0.92 : 0.9),
      minPx: RAMP.h1 * c.u * 0.65,
      maxLines: c.landscape ? 2 : 3,
      maxHeight: c.H * 0.46,
      lineHeight: 0.95,
      top: 0, // se centra abajo
      left,
      width,
      align: "center",
    });
    const supH = s.support ? RAMP.support * c.u * 1.4 * 2 + GAP_MD * c.u : 0;
    const bloque = disp.height + supH + GAP_MD * c.u + 3;
    const top = c.T + (c.H - bloque) / 2;
    const dispCss = disp.css.replace(/top:0px/, `top:${r(top)}px`);
    const barW = r(8 * c.u);
    let css =
      ch.css +
      dispCss +
      `
    .${c.id}-bar { position:absolute; left:${r(c.L + c.W / 2 - barW / 2)}px; top:${r(top - GAP_MD * c.u - 3)}px; width:${barW}px; height:${Math.max(3, r(0.28 * c.u))}px; background:${c.tone.accent}; transform-origin:center; }`;
    let html = `${ch.html}\n      <div id="${c.id}-bar" class="${c.id}-bar"></div>\n      ${disp.html}`;
    const pasos = [
      ...(s.kicker ? [{ tipo: "up", sel: `#${c.id}-kicker`, at: t.kicker, y: 14, dur: 0.5 }] : []),
      { tipo: "grow", sel: `#${c.id}-bar`, at: 0.12, dur: 0.6 },
      { tipo: "up", sel: disp.selectorLineas, at: t.display + 0.1, dur: 0.75, stagger: t.displayStagger, y: 30 },
    ];
    if (s.support) {
      const sup = apoyo(c, {
        cls: `${c.id}-support`,
        text: s.support,
        accent: s.accent_word,
        maxWidth: c.W * 0.7,
        px: RAMP.support * c.u,
        maxLines: 2,
        top: top + disp.height + GAP_MD * c.u,
        left: c.L + c.W * 0.15,
        width: c.W * 0.7,
        align: "center",
      });
      css += sup.css;
      html += `\n      ${sup.html}`;
      pasos.push({ tipo: "up", sel: `#${c.id}-support`, at: t.support + 0.15, dur: 0.6, y: 16 });
    }
    pasos.push({ tipo: "grow", sel: `#${c.id}-rule`, at: t.ruleAt, dur: t.ruleDur, ease: "power1.inOut" }, { tipo: "fade", sel: `#${c.id}-foot`, at: t.foot });
    return documento(c, { css, html, pasos });
  },
};

/**
 * stat — un dato enorme (valor + etiqueta) y el titular al lado. En vertical,
 * el dato arriba y el titular abajo.
 */
LAYOUTS.stat = {
  id: "stat",
  when: "there is ONE number or short figure that carries the scene (a price, a count, a time, a percentage). The figure gets the display size; the headline explains it.",
  slots: "kicker?, stat.value (<= 8 chars), stat.label (<= 28 chars), display, accent_word?, support?",
  render(c, s) {
    const ch = chrome(c, { kicker: s.kicker });
    const t = tiempos(c.hold, 0, c.duration - c.hold);
    const value = String(s.stat?.value ?? "").trim();
    const label = String(s.stat?.label ?? "").trim();
    const labelPx = r(RAMP.label * c.u * 1.3);
    const stacked = !c.landscape;
    const colW = stacked ? c.W : c.W * 0.44;
    const valFit = ajustarTexto(value, { maxWidth: colW * 0.96, maxPx: RAMP.display * c.u * (stacked ? 1.15 : 1.25), minPx: RAMP.h1 * c.u, maxLines: 1, lineHeight: 0.9, weight: 800, tracking: -0.04 });
    // Con line-height 0.9 los glifos sobresalen de la caja de linea: el hueco
    // hasta la etiqueta lo tiene que absorber, si no el linter ve solape.
    const valH = r(valFit.px * 0.9 + valFit.px * 0.14);
    const sobre = r(valFit.px * 0.14);
    const statTop = stacked ? c.T + c.H * 0.12 : 0;
    const headLeft = stacked ? c.L : c.L + c.W * 0.5;
    const headW = stacked ? c.W : c.W * 0.5;
    const head = titular(c, {
      cls: `${c.id}-display`,
      text: s.display,
      accent: s.accent_word,
      maxWidth: headW * 0.96,
      maxPx: RAMP.h1 * c.u * (stacked ? 1 : 0.9),
      minPx: RAMP.h2 * c.u * 0.8,
      maxLines: 3,
      maxHeight: c.H * 0.4,
      lineHeight: 0.98,
      top: 0,
      left: headLeft,
      width: headW,
    });
    const supH = s.support ? RAMP.support * c.u * 1.4 * 2 + GAP_MD * c.u : 0;
    let statBlockTop;
    let headTop;
    if (stacked) {
      const bloque = labelPx + GAP_SM * c.u + valH + GAP_LG * c.u + head.height + supH;
      statBlockTop = Math.max(statTop, c.T + (c.H - bloque) / 2 - c.H * 0.04);
      headTop = statBlockTop + labelPx + GAP_SM * c.u + valH + GAP_LG * c.u;
    } else {
      const bloque = Math.max(labelPx + GAP_SM * c.u + valH, head.height + supH);
      statBlockTop = c.T + (c.H - bloque) / 2;
      headTop = statBlockTop + (labelPx + GAP_SM * c.u + valH - head.height - supH) / 2;
      headTop = Math.max(headTop, c.T + c.H * 0.14);
    }
    const headCss = head.css.replace(/top:0px/, `top:${r(headTop)}px`);
    let css =
      ch.css +
      headCss +
      `
    .${c.id}-slabel { position:absolute; left:${c.L}px; top:${r(statBlockTop)}px; font-family:"${c.mono}",monospace; font-size:${labelPx}px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:${c.tone.accentText}; white-space:nowrap; }
    .${c.id}-svalue { position:absolute; left:${c.L}px; top:${r(statBlockTop + labelPx + GAP_SM * c.u + sobre)}px; width:${r(colW)}px; font-family:"${c.display}",sans-serif; font-size:${valFit.px}px; font-weight:800; line-height:0.9; letter-spacing:-0.04em; color:${c.tone.ink}; white-space:nowrap; }`;
    let html = `${ch.html}\n      <div id="${c.id}-slabel" class="${c.id}-slabel">${esc(label)}</div>\n      <div id="${c.id}-svalue" class="${c.id}-svalue">${esc(value)}</div>\n      ${head.html}`;
    const pasos = [
      ...(s.kicker ? [{ tipo: "up", sel: `#${c.id}-kicker`, at: t.kicker, y: 14, dur: 0.5 }] : []),
      { tipo: "up", sel: `#${c.id}-slabel`, at: 0.18, y: 12, dur: 0.5 },
      { tipo: "up", sel: `#${c.id}-svalue`, at: 0.28, y: 10, dur: 0.8 },
      { tipo: "up", sel: head.selectorLineas, at: 0.62, dur: 0.66, stagger: 0.09, y: 24 },
    ];
    if (s.support) {
      const sup = apoyo(c, {
        cls: `${c.id}-support`,
        text: s.support,
        accent: s.accent_word,
        maxWidth: headW * 0.9,
        px: RAMP.support * c.u,
        maxLines: 2,
        top: headTop + head.height + GAP_MD * c.u,
        left: headLeft,
        width: headW * 0.9,
      });
      css += sup.css;
      html += `\n      ${sup.html}`;
      pasos.push({ tipo: "up", sel: `#${c.id}-support`, at: 1.05, dur: 0.6, y: 16 });
    }
    pasos.push({ tipo: "grow", sel: `#${c.id}-rule`, at: t.ruleAt, dur: t.ruleDur, ease: "power1.inOut" }, { tipo: "fade", sel: `#${c.id}-foot`, at: t.foot });
    return documento(c, { css, html, pasos });
  },
};

/**
 * split — titular a la izquierda, panel con 2-4 filas (etiqueta + valor) a la
 * derecha. En vertical: titular arriba, panel abajo a todo el ancho.
 */
LAYOUTS.split = {
  id: "split",
  when: "the scene lists 2-4 concrete facts (label + value): what you get, specs, the terms. Headline on one side, a panel of rows on the other.",
  slots: "kicker?, display, accent_word?, support?, rows[2-4] of { label (<= 22 chars), value (<= 40 chars) }",
  render(c, s) {
    const ch = chrome(c, { kicker: s.kicker });
    const t = tiempos(c.hold, 0, c.duration - c.hold);
    const rows = (Array.isArray(s.rows) ? s.rows : []).slice(0, 4);
    const stacked = !c.landscape;
    const headW = stacked ? c.W : c.W * 0.46;
    const panelW = stacked ? c.W : c.W * 0.46;
    const panelLeft = stacked ? c.L : c.R - panelW;
    const labelPx = r(RAMP.label * c.u * 1.25);
    const valuePx = r(RAMP.h3 * c.u * (c.landscape ? 0.85 : 0.95));
    const rowH = r(labelPx + GAP_SM * c.u * 0.8 + valuePx * 1.15 + GAP_MD * c.u * 1.5);
    const panelPad = r(GAP_LG * c.u * 0.8);
    const panelH = rows.length * rowH + panelPad * 2 - r(GAP_MD * c.u * 0.5);
    const head = titular(c, {
      cls: `${c.id}-display`,
      text: s.display,
      accent: s.accent_word,
      maxWidth: headW * 0.96,
      maxPx: RAMP.h1 * c.u * (stacked ? 1.05 : 0.95),
      minPx: RAMP.h2 * c.u * 0.8,
      maxLines: 3,
      maxHeight: stacked ? c.H * 0.32 : c.H * 0.5,
      lineHeight: 0.98,
      top: 0,
      left: c.L,
      width: headW,
    });
    const supH = s.support ? RAMP.support * c.u * 1.4 * 2 + GAP_MD * c.u : 0;
    let headTop;
    let panelTop;
    if (stacked) {
      headTop = c.T + c.H * 0.14;
      panelTop = Math.max(headTop + head.height + supH + GAP_LG * c.u, ch.footTop - panelH - GAP_LG * c.u);
      panelTop = Math.min(panelTop, ch.footTop - panelH - GAP_MD * c.u);
    } else {
      const bloque = Math.max(head.height + supH, panelH);
      const top = c.T + (c.H - bloque) / 2;
      headTop = top + (bloque - head.height - supH) / 2;
      panelTop = top + (bloque - panelH) / 2;
    }
    const headCss = head.css.replace(/top:0px/, `top:${r(headTop)}px`);
    let css =
      ch.css +
      headCss +
      `
    .${c.id}-panel { position:absolute; left:${r(panelLeft)}px; top:${r(panelTop)}px; width:${r(panelW)}px; height:${r(panelH)}px; background:${c.tone.surface}; border:1px solid ${c.tone.line}; border-radius:${r(0.3 * c.u)}px; }
    .${c.id}-row { position:absolute; left:${panelPad}px; right:${panelPad}px; height:${rowH}px; border-top:1px solid ${c.tone.line}; }
    .${c.id}-row.first { border-top:none; }
    .${c.id}-rlabel { position:absolute; left:0; top:${r(GAP_MD * c.u * 0.9)}px; font-family:"${c.mono}",monospace; font-size:${labelPx}px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:${c.tone.muted}; white-space:nowrap; }
    .${c.id}-rvalue { position:absolute; left:0; right:0; top:${r(GAP_MD * c.u * 0.9 + labelPx + GAP_SM * c.u * 0.8)}px; font-family:"${c.display}",sans-serif; font-size:${valuePx}px; font-weight:600; line-height:1.15; color:${c.tone.ink}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }`;
    const rowsHtml = rows
      .map((row, i) => {
        const vfit = ajustarTexto(String(row.value ?? ""), { maxWidth: panelW - panelPad * 2, maxPx: valuePx, minPx: valuePx * 0.6, maxLines: 1, weight: 600 });
        return `<div id="${c.id}-row${i + 1}" class="${c.id}-row${i === 0 ? " first" : ""}" style="top:${panelPad + i * rowH}px"><div class="${c.id}-rlabel">${esc(row.label)}</div><div class="${c.id}-rvalue" style="font-size:${vfit.px}px">${esc(vfit.lines.join(" "))}</div></div>`;
      })
      .join("");
    let html = `${ch.html}\n      ${head.html}\n      <div id="${c.id}-panel" class="${c.id}-panel">${rowsHtml}</div>`;
    const tl = tiempos(c.hold, rows.length, c.duration - c.hold);
    const pasos = [
      ...(s.kicker ? [{ tipo: "up", sel: `#${c.id}-kicker`, at: t.kicker, y: 14, dur: 0.5 }] : []),
      { tipo: "up", sel: head.selectorLineas, at: t.display, dur: 0.7, stagger: 0.09, y: 28 },
      { tipo: "fade", sel: `#${c.id}-panel`, at: 0.45, dur: 0.5 },
      ...rows.map((_, i) => ({ tipo: "up", sel: `#${c.id}-row${i + 1}`, at: Math.max(0.7, tl.lista[i]), y: 12, dur: 0.5 })),
    ];
    if (s.support) {
      const sup = apoyo(c, {
        cls: `${c.id}-support`,
        text: s.support,
        accent: s.accent_word,
        maxWidth: headW * 0.92,
        px: RAMP.support * c.u,
        maxLines: 2,
        top: headTop + head.height + GAP_MD * c.u,
        left: c.L,
        width: headW * 0.92,
      });
      css += sup.css;
      html += `\n      ${sup.html}`;
      pasos.push({ tipo: "up", sel: `#${c.id}-support`, at: t.support, dur: 0.6, y: 16 });
    }
    pasos.push({ tipo: "grow", sel: `#${c.id}-rule`, at: t.ruleAt, dur: t.ruleDur, ease: "power1.inOut" }, { tipo: "fade", sel: `#${c.id}-foot`, at: t.foot });
    return documento(c, { css, html, pasos });
  },
};

/**
 * cues — titular arriba y 2-4 lineas que aparecen una por una, cada una con su
 * marca de acento. Es la escena narrada de un video; en un still, una lista.
 */
LAYOUTS.cues = {
  id: "cues",
  when: "the scene is narrated in 2-4 beats that appear one after another (steps of a flow, a sequence of claims). Headline on top, cues below with an accent tick.",
  slots: "kicker?, display, accent_word?, cues[2-4] (<= 60 chars each)",
  render(c, s) {
    const ch = chrome(c, { kicker: s.kicker });
    const cues = (Array.isArray(s.cues) ? s.cues : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 4);
    const t = tiempos(c.hold, cues.length, c.duration - c.hold);
    const headTop = c.T + c.H * 0.14;
    const head = titular(c, {
      cls: `${c.id}-display`,
      text: s.display,
      accent: s.accent_word,
      maxWidth: c.W * 0.96,
      maxPx: RAMP.h1 * c.u * (c.landscape ? 0.9 : 1),
      minPx: RAMP.h2 * c.u * 0.8,
      maxLines: 2,
      maxHeight: c.H * 0.34,
      lineHeight: 0.98,
      top: headTop,
      left: c.L,
      width: c.W,
    });
    const cuePx = r(RAMP.h3 * c.u * (c.landscape ? 1.1 : 1.25));
    const tick = r(0.9 * c.u);
    const textLeft = c.L + tick + r(GAP_MD * c.u);
    const textW = c.W - tick - r(GAP_MD * c.u);
    let y = headTop + head.height + GAP_LG * c.u * 1.2;
    // Las cues se reparten en el alto que queda hasta el pie, con un tope para
    // que no queden a kilometros: llenar el lienzo sin desarmar la lista.
    const fits = cues.map((cue) => ajustarTexto(cue, { maxWidth: textW, maxPx: cuePx, minPx: cuePx * 0.7, maxLines: 2, lineHeight: 1.3, weight: 500 }));
    const alto = fits.reduce((a, f) => a + f.lines.length * f.px * 1.3, 0);
    const libre = ch.footTop - GAP_MD * c.u - y - alto;
    const cueGap = r(Math.min(GAP_LG * c.u * 2.4, Math.max(GAP_LG * c.u * 0.7, libre / Math.max(1, cues.length))));
    let css =
      ch.css +
      head.css +
      `
    .${c.id}-cue { position:absolute; left:${c.L}px; width:${c.W}px; }
    .${c.id}-tick { position:absolute; left:0; top:${r(cuePx * 0.28)}px; width:${tick}px; height:${tick}px; background:${c.tone.accent}; }
    .${c.id}-ctext { position:absolute; left:${textLeft - c.L}px; top:0; width:${r(textW)}px; font-family:"${c.display}",sans-serif; font-size:${cuePx}px; font-weight:500; line-height:1.3; color:${c.tone.ink}; }
    .${c.id}-ctext .line { display:block; white-space:nowrap; }`;
    const cuesHtml = [];
    for (let i = 0; i < cues.length; i++) {
      const fit = fits[i];
      const h = r(fit.lines.length * fit.px * 1.3);
      cuesHtml.push(`<div id="${c.id}-cue${i + 1}" class="${c.id}-cue" style="top:${r(y)}px;height:${h}px"><div class="${c.id}-tick"></div><div class="${c.id}-ctext" style="font-size:${fit.px}px">${fit.lines.map((l) => `<span class="line">${esc(l)}</span>`).join("")}</div></div>`);
      y += h + cueGap;
    }
    const html = `${ch.html}\n      ${head.html}\n      ${cuesHtml.join("\n      ")}`;
    const pasos = [
      ...(s.kicker ? [{ tipo: "up", sel: `#${c.id}-kicker`, at: t.kicker, y: 14, dur: 0.5 }] : []),
      { tipo: "up", sel: head.selectorLineas, at: t.display, dur: 0.7, stagger: 0.09, y: 28 },
      ...cues.map((_, i) => ({ tipo: "up", sel: `#${c.id}-cue${i + 1}`, at: Math.max(0.85, t.lista[i]), y: 18, dur: 0.6 })),
      { tipo: "grow", sel: `#${c.id}-rule`, at: t.ruleAt, dur: t.ruleDur, ease: "power1.inOut" },
      { tipo: "fade", sel: `#${c.id}-foot`, at: t.foot },
    ];
    return documento(c, { css, html, pasos });
  },
};

/**
 * steps — 2-4 pasos numerados en columnas (en vertical, en filas): numero en
 * mono con acento, titulo, una linea de texto.
 */
LAYOUTS.steps = {
  id: "steps",
  when: "a process: 2-4 numbered steps side by side (how it works, what happens next). Each step has a short title and one line.",
  slots: "kicker?, display, accent_word?, steps[2-4] of { title (<= 26 chars), text (<= 90 chars) }",
  render(c, s) {
    const ch = chrome(c, { kicker: s.kicker });
    const steps = (Array.isArray(s.steps) ? s.steps : []).slice(0, 4);
    const t = tiempos(c.hold, steps.length, c.duration - c.hold);
    const headTop = c.T + c.H * 0.14;
    const head = titular(c, {
      cls: `${c.id}-display`,
      text: s.display,
      accent: s.accent_word,
      maxWidth: c.W * 0.96,
      maxPx: RAMP.h2 * c.u * (c.landscape ? 1.25 : 1.35),
      minPx: RAMP.h3 * c.u,
      maxLines: 2,
      maxHeight: c.H * 0.26,
      lineHeight: 1.02,
      top: headTop,
      left: c.L,
      width: c.W,
    });
    const stacked = !c.landscape || steps.length > 3;
    const numPx = r(RAMP.h2 * c.u * (stacked ? 0.9 : 1));
    const titlePx = r(RAMP.h3 * c.u * (c.landscape ? 0.95 : 1));
    const textPx = r(RAMP.body * c.u * (c.landscape ? 1.15 : 1.15));
    const gridTop = headTop + head.height + GAP_LG * c.u * 1.3;
    const gridBottom = ch.footTop - GAP_MD * c.u;
    let css =
      ch.css +
      head.css +
      `
    .${c.id}-step { position:absolute; border-top:1px solid ${c.tone.line}; }
    .${c.id}-num { position:absolute; left:0; top:${r(GAP_MD * c.u)}px; font-family:"${c.mono}",monospace; font-size:${numPx}px; font-weight:600; letter-spacing:-0.02em; color:${c.tone.accentText}; white-space:nowrap; }
    .${c.id}-stitle { position:absolute; left:0; font-family:"${c.display}",sans-serif; font-size:${titlePx}px; font-weight:700; line-height:1.15; color:${c.tone.ink}; }
    .${c.id}-stitle .line, .${c.id}-stext .line { display:block; white-space:nowrap; }
    .${c.id}-stext { position:absolute; left:0; font-family:"${c.display}",sans-serif; font-size:${textPx}px; font-weight:400; line-height:1.45; color:${c.tone.muted}; }`;
    const parts = [];
    if (stacked) {
      const rowH = r((gridBottom - gridTop) / steps.length);
      const numW = r(numPx * 1.9);
      steps.forEach((st, i) => {
        const top = gridTop + i * rowH;
        const textLeft = numW + GAP_MD * c.u;
        const textW = c.W - textLeft;
        const tf = ajustarTexto(String(st.title ?? ""), { maxWidth: textW, maxPx: titlePx, minPx: titlePx * 0.7, maxLines: 1, weight: 700 });
        const xf = ajustarTexto(String(st.text ?? ""), { maxWidth: textW, maxPx: textPx, minPx: textPx * 0.75, maxLines: 2, lineHeight: 1.45, weight: 400 });
        parts.push(
          `<div id="${c.id}-step${i + 1}" class="${c.id}-step" style="left:${c.L}px;top:${r(top)}px;width:${c.W}px;height:${rowH}px"><div class="${c.id}-num">${String(i + 1).padStart(2, "0")}</div><div class="${c.id}-stitle" style="left:${r(textLeft)}px;top:${r(GAP_MD * c.u)}px;width:${r(textW)}px;font-size:${tf.px}px">${tf.lines.map((l) => `<span class="line">${esc(l)}</span>`).join("")}</div><div class="${c.id}-stext" style="left:${r(textLeft)}px;top:${r(GAP_MD * c.u + tf.px * 1.15 + GAP_SM * c.u)}px;width:${r(textW)}px;font-size:${xf.px}px">${xf.lines.map((l) => `<span class="line">${esc(l)}</span>`).join("")}</div></div>`,
        );
      });
    } else {
      const gap = r(GAP_LG * c.u);
      const colW = r((c.W - gap * (steps.length - 1)) / steps.length);
      steps.forEach((st, i) => {
        const left = c.L + i * (colW + gap);
        const tf = ajustarTexto(String(st.title ?? ""), { maxWidth: colW, maxPx: titlePx, minPx: titlePx * 0.7, maxLines: 2, lineHeight: 1.15, weight: 700 });
        const xf = ajustarTexto(String(st.text ?? ""), { maxWidth: colW, maxPx: textPx, minPx: textPx * 0.75, maxLines: 3, lineHeight: 1.45, weight: 400 });
        const titleTop = GAP_MD * c.u + numPx * 1.1 + GAP_MD * c.u;
        parts.push(
          `<div id="${c.id}-step${i + 1}" class="${c.id}-step" style="left:${r(left)}px;top:${r(gridTop)}px;width:${colW}px;height:${r(gridBottom - gridTop)}px"><div class="${c.id}-num">${String(i + 1).padStart(2, "0")}</div><div class="${c.id}-stitle" style="top:${r(titleTop)}px;width:${colW}px;font-size:${tf.px}px">${tf.lines.map((l) => `<span class="line">${esc(l)}</span>`).join("")}</div><div class="${c.id}-stext" style="top:${r(titleTop + tf.lines.length * tf.px * 1.15 + GAP_SM * c.u)}px;width:${colW}px;font-size:${xf.px}px">${xf.lines.map((l) => `<span class="line">${esc(l)}</span>`).join("")}</div></div>`,
        );
      });
    }
    const html = `${ch.html}\n      ${head.html}\n      ${parts.join("\n      ")}`;
    const pasos = [
      ...(s.kicker ? [{ tipo: "up", sel: `#${c.id}-kicker`, at: t.kicker, y: 14, dur: 0.5 }] : []),
      { tipo: "up", sel: head.selectorLineas, at: t.display, dur: 0.7, stagger: 0.09, y: 26 },
      ...steps.map((_, i) => ({ tipo: "up", sel: `#${c.id}-step${i + 1}`, at: Math.max(0.8, t.lista[i]), y: 18, dur: 0.6 })),
      { tipo: "grow", sel: `#${c.id}-rule`, at: t.ruleAt, dur: t.ruleDur, ease: "power1.inOut" },
      { tipo: "fade", sel: `#${c.id}-foot`, at: t.foot },
    ];
    return documento(c, { css, html, pasos });
  },
};

/**
 * cta — el cierre: la linea final grande y, abajo, una barra de acento a todo
 * el ancho con la llamada a la accion y la URL en mono.
 */
LAYOUTS.cta = {
  id: "cta",
  when: "the closing scene or slide: the last line, then what to do (cta.line) and where (cta.url). Use for the final scene only.",
  slots: "kicker?, display, accent_word?, cta.line (<= 60 chars), cta.url? (<= 40 chars)",
  render(c, s) {
    const ch = chrome(c, { kicker: s.kicker, right: "" });
    const t = tiempos(c.hold, 0, c.duration - c.hold);
    const disp = titular(c, {
      cls: `${c.id}-display`,
      text: s.display,
      accent: s.accent_word,
      maxWidth: c.W * 0.96,
      maxPx: RAMP.display * c.u * 0.95,
      minPx: RAMP.h1 * c.u * 0.7,
      maxLines: c.landscape ? 2 : 3,
      maxHeight: c.H * 0.4,
      lineHeight: 0.92,
      top: 0,
      left: c.L,
      width: c.W,
    });
    const linePx = r(RAMP.h3 * c.u * (c.landscape ? 1.1 : 1.1));
    const urlPx = r(RAMP.label * c.u * 1.5);
    const barH = Math.max(4, r(0.45 * c.u));
    const blockH = barH + GAP_MD * c.u + linePx * 1.2 + (s.cta?.url ? GAP_SM * c.u + urlPx * 1.4 : 0);
    const blockTop = ch.footTop - blockH - GAP_LG * c.u;
    const top = Math.max(ch.kickerBottom + GAP_LG * c.u, ch.kickerBottom + (blockTop - GAP_LG * c.u - ch.kickerBottom - disp.height) / 2);
    const lineFit = ajustarTexto(String(s.cta?.line ?? ""), { maxWidth: c.W * 0.9, maxPx: linePx, minPx: linePx * 0.65, maxLines: 1, weight: 600 });
    const css =
      ch.css +
      disp.css.replace(/top:0px/, `top:${r(top)}px`) +
      `
    .${c.id}-bar { position:absolute; left:${c.L}px; top:${r(blockTop)}px; width:${c.W}px; height:${barH}px; background:${c.tone.accent}; transform-origin:left center; }
    .${c.id}-cline { position:absolute; left:${c.L}px; top:${r(blockTop + barH + GAP_MD * c.u)}px; width:${c.W}px; font-family:"${c.display}",sans-serif; font-size:${lineFit.px}px; font-weight:600; line-height:1.2; color:${c.tone.ink}; white-space:nowrap; }
    .${c.id}-curl { position:absolute; left:${c.L}px; top:${r(blockTop + barH + GAP_MD * c.u + linePx * 1.2 + GAP_SM * c.u)}px; font-family:"${c.mono}",monospace; font-size:${urlPx}px; font-weight:600; letter-spacing:.1em; color:${c.tone.accentText}; white-space:nowrap; }`;
    const html = [
      ch.html,
      disp.html,
      `<div id="${c.id}-bar" class="${c.id}-bar"></div>`,
      `<div id="${c.id}-cline" class="${c.id}-cline">${esc(lineFit.lines.join(" "))}</div>`,
      s.cta?.url ? `<div id="${c.id}-curl" class="${c.id}-curl">${esc(s.cta.url)}</div>` : "",
    ]
      .filter(Boolean)
      .join("\n      ");
    const pasos = [
      ...(s.kicker ? [{ tipo: "up", sel: `#${c.id}-kicker`, at: t.kicker, y: 14, dur: 0.5 }] : []),
      { tipo: "up", sel: disp.selectorLineas, at: t.display, dur: 0.72, stagger: t.displayStagger, y: 34 },
      { tipo: "grow", sel: `#${c.id}-bar`, at: Math.max(0.7, c.hold * 0.25), dur: Math.max(0.8, c.hold * 0.4), ease: "power2.out" },
      { tipo: "up", sel: `#${c.id}-cline`, at: Math.max(0.95, c.hold * 0.32), y: 16, dur: 0.6 },
      ...(s.cta?.url ? [{ tipo: "up", sel: `#${c.id}-curl`, at: Math.max(1.15, c.hold * 0.4), y: 12, dur: 0.5 }] : []),
      { tipo: "grow", sel: `#${c.id}-rule`, at: t.ruleAt, dur: t.ruleDur, ease: "power1.inOut" },
      { tipo: "fade", sel: `#${c.id}-foot`, at: t.foot },
    ];
    return documento(c, { css, html, pasos });
  },
};

export const LAYOUT_IDS = Object.keys(LAYOUTS);

/**
 * Un lienzo es "de pantalla completa" (historia, reel) cuando es 9:16 o mas
 * alto: ahi la app dibuja su interfaz arriba y abajo y hay que componer para la
 * franja del medio. Un 4:5 de feed es alto pero no lo tapa nadie.
 */
export function pantallaCompleta(width, height) {
  return height / width >= 1.6;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** El catalogo para el prompt del planificador: id, cuando usarlo, huecos. */
export function layoutCatalog() {
  return LAYOUT_IDS.map((id) => `- ${id}: ${LAYOUTS[id].when}\n    slots: ${LAYOUTS[id].slots}`).join("\n");
}

const LIM = { kicker: 28, display: 70, support: 120, cue: 60, rowLabel: 22, rowValue: 40, stepTitle: 26, stepText: 90, statValue: 8, statLabel: 28, ctaLine: 60, ctaUrl: 40 };

/**
 * Valida los huecos que el modelo devolvio para un layout. Devuelve la lista
 * de problemas (vacia si esta bien). Se es estricto con lo que rompe el
 * layout (falta el display, una lista vacia) y tolerante con lo que solo se
 * recorta (un kicker largo).
 */
export function validateSlots(id, s = {}) {
  const errs = [];
  if (!LAYOUTS[id]) return [`layout desconocido: ${id} (validos: ${LAYOUT_IDS.join(", ")})`];
  const str = (v) => (v == null ? "" : String(v).trim());
  if (!str(s.display)) errs.push("falta display");
  if (str(s.display).length > LIM.display) errs.push(`display demasiado largo (${str(s.display).length} > ${LIM.display})`);
  if (str(s.support).length > LIM.support) errs.push(`support demasiado largo (> ${LIM.support})`);
  if (s.register && !["dark", "light"].includes(s.register)) errs.push("register debe ser dark o light");
  const lista = (v, min, max, nombre) => {
    if (!Array.isArray(v) || v.length < min || v.length > max) errs.push(`${nombre} debe tener entre ${min} y ${max} entradas`);
  };
  if (id === "stat") {
    if (!str(s.stat?.value)) errs.push("stat.value vacio");
    if (str(s.stat?.value).length > LIM.statValue) errs.push(`stat.value demasiado largo (> ${LIM.statValue})`);
    if (!str(s.stat?.label)) errs.push("stat.label vacio");
  }
  if (id === "split") {
    lista(s.rows, 2, 4, "rows");
    for (const row of Array.isArray(s.rows) ? s.rows : []) if (!str(row?.label) || !str(row?.value)) errs.push("cada row necesita label y value");
  }
  if (id === "cues") {
    lista(s.cues, 2, 4, "cues");
    for (const cue of Array.isArray(s.cues) ? s.cues : []) if (!str(cue)) errs.push("cue vacio");
  }
  if (id === "steps") {
    lista(s.steps, 2, 4, "steps");
    for (const st of Array.isArray(s.steps) ? s.steps : []) if (!str(st?.title)) errs.push("cada step necesita title");
  }
  if (id === "cta" && !str(s.cta?.line)) errs.push("cta.line vacio");
  return errs;
}

/** Recorta lo que solo se recorta, para no fallar una escena por un kicker largo. */
function saneados(s = {}) {
  const cut = (v, n) => (v == null ? "" : String(v).trim().slice(0, n));
  return {
    ...s,
    kicker: cut(s.kicker, LIM.kicker),
    display: cut(s.display, LIM.display + 20),
    support: cut(s.support, LIM.support + 30),
    accent_word: cut(s.accent_word, 40),
    stat: s.stat ? { value: cut(s.stat.value, LIM.statValue + 4), label: cut(s.stat.label, LIM.statLabel) } : undefined,
    rows: Array.isArray(s.rows) ? s.rows.map((x) => ({ label: cut(x?.label, LIM.rowLabel), value: cut(x?.value, LIM.rowValue + 10) })) : undefined,
    cues: Array.isArray(s.cues) ? s.cues.map((x) => cut(x, LIM.cue + 20)) : undefined,
    steps: Array.isArray(s.steps) ? s.steps.map((x) => ({ title: cut(x?.title, LIM.stepTitle + 6), text: cut(x?.text, LIM.stepText + 20) })) : undefined,
    cta: s.cta ? { line: cut(s.cta.line, LIM.ctaLine + 10), url: cut(s.cta.url, LIM.ctaUrl) } : undefined,
  };
}

/**
 * Renderiza una escena. `scene` es la del plan; `slots` lo que eligio el
 * modelo (ya validado con validateSlots).
 */
export function renderLayout(id, { brand, width, height, scene, total, slots = {}, vertical = false }) {
  const layout = LAYOUTS[id];
  if (!layout) throw new Error(`layout desconocido: ${id}`);
  const s = saneados(slots);
  const c = contexto({ brand, width, height, scene, total, register: s.register ?? "dark", vertical });
  return layout.render(c, s);
}

/** Muestras de todos los layouts para una marca: para el catalogo y para validarlos. */
export function sampleSlots(id) {
  const base = { kicker: "WHAT YOU GET", display: "your agent ships the backend", accent_word: "backend", support: "Postgres, auth, storage, realtime and functions in one binary.", register: "dark" };
  switch (id) {
    case "stat":
      return { ...base, stat: { value: "5 min", label: "from sign-up to live URL" }, display: "from zero to a running backend" };
    case "split":
      return { ...base, rows: [{ label: "database", value: "Postgres + pgvector" }, { label: "auth", value: "email, OAuth, API keys" }, { label: "functions", value: "TypeScript, cron, workers" }] };
    case "cues":
      return { ...base, cues: ["Sign up with your email", "Get a live URL in seconds", "Point your agent at it"] };
    case "steps":
      return { ...base, steps: [{ title: "Sign up", text: "One email, no card." }, { title: "Get the URL", text: "A real Postgres behind it." }, { title: "Ship", text: "Auth, storage and functions ready." }] };
    case "cta":
      return { ...base, display: "start with a real backend", cta: { line: "Create your project today", url: "nubex.dev" } };
    case "statement":
      return { ...base, display: "the doc you needed was always the next one", support: "" };
    default:
      return base;
  }
}

export { contrast };
