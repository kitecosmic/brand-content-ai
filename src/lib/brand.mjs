// Marcas: crearlas, iterarlas y dejarlas listas para producir contenido.
//
// El sistema nacio con UNA marca escrita a mano en brand-content-ai.config.json y un
// proyecto HyperFrames de referencia hecho a medida. Aca la marca pasa a ser un
// dato que se crea desde una URL (o desde unos colores) y se corrige hablando:
// "mas oscuro", "el acento en azul", "menos tecnico".
//
// Que es una marca, en concreto:
//   - identidad: nombre, publico, voz, frases prohibidas, idiomas
//   - paleta y tipografias
//   - frame.md: el sistema de diseno que lee el modelo al componer
//   - un proyecto base en disco (fuentes embebidas + composicion de referencia)
//
// El reparto de trabajo es a proposito: el MODELO decide los valores (que
// colores, que familia, que tono) y el CODIGO arma el frame.md y el proyecto.
// Dejar que el modelo escriba 300 lineas de YAML daba sistemas de diseno
// distintos entre si y rompia el pipeline cuando se olvidaba una clave.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runClaudeJSON } from "./claude.mjs";
import { buildFontCss, familyExists } from "./fonts.mjs";
import { readSite } from "./site.mjs";
import { META_DIR, slugify } from "./config.mjs";
import { contrast, forzarContraste, mezclar, toHex } from "./color.mjs";

// La matematica de color nacio aca y ahora vive en color.mjs, porque el panel
// tambien la necesita y no tiene por que importar el motor de marcas entero.
// Se reexporta para que quien ya la pedia a este modulo la siga encontrando.
export { contrast, forzarContraste, mezclar, toHex };

export class BrandError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "BrandError";
    this.cause = cause ?? null;
  }
}

// Familias seguras por si el modelo propone una que Google Fonts no tiene.
const FALLBACK_DISPLAY = "Inter";
const FALLBACK_MONO = "JetBrains Mono";

const PESOS_DISPLAY = [400, 600, 700, 800];
const PESOS_MONO = [400, 600];

// Claves que una paleta tiene que traer si o si. El resto se deriva.
const CLAVES_PALETA = ["bg", "surface", "ink", "muted", "line", "accent", "onAccent"];

export function defaultDeps() {
  return { runClaudeJSON, readSite, buildFontCss, familyExists };
}

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

/**
 * Crea una marca y la deja lista para generar contenido.
 *
 * @param {object} cfg
 * @param {import("./store.mjs").Store} store
 * @param {object} opts
 * @param {string} [opts.url]      sitio del que sacar identidad y colores
 * @param {string} [opts.name]     nombre, si no hay sitio o si se quiere forzar
 * @param {string[]} [opts.colors] colores que el usuario quiere imponer
 * @param {string} [opts.hints]    "mas serio", "publico no tecnico", lo que sea
 * @param {string} [opts.id]       slug; por defecto sale del nombre
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<{ brand: object, costUsd: number, warnings: string[] }>}
 */
export async function createBrand(cfg, store, opts = {}) {
  const deps = { ...defaultDeps(), ...(opts.deps ?? {}) };
  const log = opts.log ?? (() => {});
  const warnings = [];

  if (!opts.url && !opts.name) {
    throw new BrandError("hace falta al menos una URL o un nombre para crear una marca");
  }

  let site = null;
  if (opts.url) {
    log(`leyendo ${opts.url}...`);
    try {
      site = await deps.readSite(opts.url, { maxPages: 5, log: (m) => log(`  ${m}`) });
      if ((site.text ?? "").length < 400) {
        warnings.push(
          "el sitio casi no devolvio texto (suele pasar con apps de una sola pagina): " +
            "la identidad sale del titulo, la descripcion y los colores. Agregale notas para afinarla.",
        );
      }
    } catch (err) {
      warnings.push(`no se pudo leer el sitio: ${err?.message ?? err}`);
      log(`  ! ${err?.message ?? err}`);
    }
  }

  log("proponiendo identidad...");
  const { identity, costUsd } = await proposeIdentity(cfg, {
    site,
    hints: opts.hints,
    name: opts.name,
    colors: opts.colors,
    deps,
  });

  const id = slugify(opts.id || identity.id || identity.name || opts.name || site?.host || "marca");
  if (!id) throw new BrandError("no se pudo derivar un id de marca");
  if (store.getBrand(id) && !opts.overwrite) {
    throw new BrandError(`ya existe una marca con id "${id}" — elegi otro nombre o borrala primero`);
  }

  const brand = normalizeIdentity(identity, {
    id,
    site: site?.url ?? opts.url ?? null,
    notes: opts.hints ?? null,
    warnings,
  });

  store.upsertBrand({ ...brand, status: "draft" });
  await materializeBrand(cfg, store, id, { log, deps, warnings });

  // El sitio queda como fuente de conocimiento: de ahi salen los hechos que el
  // contenido puede afirmar. El sync la completa despues.
  if (site?.url) {
    store.addSource({
      brandId: id,
      sourceId: `${id}:site`,
      kind: "url",
      ref: site.url,
      label: site.host,
    });
  }

  const listo = store.upsertBrand({ id, status: "ready" });
  log(`marca lista: ${listo.name} (${id})`);
  return { brand: listo, costUsd, warnings };
}

/**
 * Ajusta una marca existente segun lo que pidio el usuario y guarda la vuelta
 * anterior como revision. Es el "no me gusta, cambiale esto" del panel.
 */
export async function reviseBrand(cfg, store, id, feedback, opts = {}) {
  const deps = { ...defaultDeps(), ...(opts.deps ?? {}) };
  const log = opts.log ?? (() => {});
  const actual = store.getBrand(id);
  if (!actual) throw new BrandError(`no existe la marca ${id}`);
  const pedido = String(feedback ?? "").trim();
  if (!pedido) throw new BrandError("hace falta decir que cambiar");

  // La revision se guarda ANTES de pisar nada: si el cambio no gusta, lo
  // anterior sigue estando.
  const revision = store.saveBrandRevision(id, { feedback: pedido });

  log(`revisando ${actual.name} (revision ${revision})...`);
  const { identity, costUsd } = await proposeIdentity(cfg, {
    current: actual,
    hints: pedido,
    deps,
  });

  const warnings = [];
  const brand = normalizeIdentity(identity, {
    id,
    site: actual.site,
    notes: pedido,
    previous: actual,
    warnings,
  });
  store.upsertBrand(brand);
  await materializeBrand(cfg, store, id, { log, deps, warnings, force: true });

  log(`marca actualizada: ${brand.name} (revision ${revision})`);
  return { brand: store.getBrand(id), revision, costUsd, warnings };
}

/**
 * Garantiza que exista al menos una marca y la devuelve.
 *
 * La instalacion original tenia la marca escrita en brand-content-ai.config.json y un
 * proyecto de referencia hecho a mano. La primera vez que corre esto, esa marca
 * se convierte en una fila de la base apuntando a ese mismo proyecto: nada se
 * regenera, nada se pierde, y el panel pasa a tener algo que mostrar.
 */
export function ensureDefaultBrand(cfg, store, { log } = {}) {
  const existente = store.defaultBrand();
  if (existente) return existente;

  const dela = cfg.brand ?? {};
  // Una instalacion nueva no tiene marca semilla y no hay que inventarle una:
  // que el panel diga "crea tu primera marca" es mejor que arrancar con una
  // marca vacia llamada "mi marca" que nadie pidio.
  const nombre = String(dela.name ?? "").trim();
  if (!nombre) return null;
  const id = slugify(dela.id ?? nombre);
  const ref = cfg.hyperframes?.referenceProject ?? null;
  const frameMd = ref && existsSync(join(ref, "frame.md")) ? readFileSync(join(ref, "frame.md"), "utf8") : null;

  const brand = store.upsertBrand({
    id,
    name: nombre,
    site: dela.site ?? null,
    audience: dela.audience ?? null,
    voice: dela.voice ?? null,
    nameUsage: dela.nameUsage ?? null,
    never: dela.never ?? [],
    languages: dela.languages ?? ["en"],
    languageMix: dela.languageMix ?? null,
    palette: frameMd ? paletteFromFrameMd(frameMd) : {},
    fonts: frameMd ? fontsFromFrameMd(frameMd) : {},
    frameMd,
    projectDir: ref,
    sourceUrl: dela.site ?? null,
    notes: "importada de brand-content-ai.config.json",
    status: "ready",
    isDefault: 1,
  });
  store.setDefaultBrand(id);

  const adoptados = store.adoptOrphans(id);
  if (adoptados.items || adoptados.knowledge) {
    log?.(`marca ${nombre}: adopto ${adoptados.items} pieza(s) y ${adoptados.knowledge} fuente(s) que ya existian`);
  }

  // Los repos de la config pasan a ser fuentes de esta marca. Los que ya vinieron
  // adoptados de la base vieja son los mismos con otro id: en vez de duplicarlos
  // se les completa la ruta, que la tabla vieja no guardaba (tenia el id del
  // repo en su lugar) y sin la cual el proximo sync no sabria donde mirar.
  const existentes = store.allKnowledge(id);
  for (const repo of Array.isArray(cfg.repos) ? cfg.repos : []) {
    if (!repo?.id) continue;
    const ya = existentes.find(
      (f) => f.source_id === repo.id || f.label === repo.id || f.ref === repo.path,
    );
    if (ya) {
      if (ya.ref !== repo.path) {
        store.addSource({
          brandId: id,
          sourceId: ya.source_id,
          kind: "repo",
          ref: repo.path,
          label: repo.id,
        });
      }
      continue;
    }
    store.addSource({
      brandId: id,
      sourceId: `${id}:repo:${repo.id}`,
      kind: "repo",
      ref: repo.path,
      label: repo.id,
    });
  }
  log?.(`marca por defecto: ${nombre} (${id})`);
  return store.getBrand(id);
}

/**
 * Saca una paleta usable de un frame.md escrito a mano.
 *
 * Los nombres de color de un sistema de diseno son propios (ink-black,
 * fire-orange), asi que se mapea por luminancia y croma: el mas oscuro es el
 * fondo, el mas claro el texto, el mas saturado el acento.
 */
export function paletteFromFrameMd(md) {
  const bloque = String(md).match(/^colors:\s*$([\s\S]*?)^\w/m);
  const zona = bloque ? bloque[1] : String(md).slice(0, 4000);
  const hex = [];
  for (const m of zona.matchAll(/["']?(#[0-9a-fA-F]{6})["']?/g)) {
    const h = toHex(m[1]);
    if (h && !hex.includes(h)) hex.push(h);
  }
  if (!hex.length) return {};

  const porLuz = [...hex].sort((a, b) => luz(a) - luz(b));
  const bg = porLuz[0];
  const ink = porLuz[porLuz.length - 1];
  const accent =
    [...hex]
      .filter((h) => h !== bg && h !== ink)
      .sort((a, b) => croma(b) - croma(a))[0] ?? ink;
  const resto = porLuz.filter((h) => h !== bg && h !== ink && h !== accent);
  return normalizePalette({
    bg,
    ink,
    accent,
    surface: resto[0] ?? mezclar(bg, ink, 0.06),
    line: resto[1] ?? mezclar(bg, ink, 0.18),
    muted: resto[resto.length - 1] ?? mezclar(bg, ink, 0.6),
    hint: mezclar(bg, ink, 0.45),
    onAccent: luz(accent) > 0.45 ? "#000000" : "#FFFFFF",
  });
}

/** Las dos familias mas nombradas en el frame.md: display y mono. */
export function fontsFromFrameMd(md) {
  const cuenta = new Map();
  for (const m of String(md).matchAll(/fontFamily:\s*["']([^"']+)["']/g)) {
    const f = m[1].trim();
    cuenta.set(f, (cuenta.get(f) ?? 0) + 1);
  }
  const orden = [...cuenta.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const mono = orden.find((f) => /mono|code|courier/i.test(f)) ?? FALLBACK_MONO;
  const display = orden.find((f) => f !== mono) ?? FALLBACK_DISPLAY;
  return {
    display: { family: display, weights: PESOS_DISPLAY },
    mono: { family: mono, weights: PESOS_MONO },
  };
}

function luz(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt((toHex(hex) ?? "#000000").slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Distancia entre el canal mas alto y el mas bajo: cuanto "color" tiene. */
function croma(hex) {
  const c = [1, 3, 5].map((i) => parseInt((toHex(hex) ?? "#000000").slice(i, i + 2), 16));
  return (Math.max(...c) - Math.min(...c)) / 255;
}

// ---------------------------------------------------------------------------
// Materializar: de los datos de la marca a archivos que el pipeline entiende
// ---------------------------------------------------------------------------

/**
 * Escribe el proyecto base de la marca: frame.md, fuentes embebidas, la
 * composicion de referencia y el hyperframes.json. Es lo que `ensureProject`
 * clona para cada pieza.
 */
export async function materializeBrand(cfg, store, id, opts = {}) {
  const deps = { ...defaultDeps(), ...(opts.deps ?? {}) };
  const log = opts.log ?? (() => {});
  const warnings = opts.warnings ?? [];
  let brand = store.getBrand(id);
  if (!brand) throw new BrandError(`no existe la marca ${id}`);

  const dir = brandProjectDir(cfg, id);
  mkdirSync(join(dir, "assets", "fonts"), { recursive: true });
  mkdirSync(join(dir, "compositions", "frames"), { recursive: true });
  mkdirSync(join(dir, META_DIR), { recursive: true });

  // --- fuentes ---
  //
  // El modelo propone la familia que le parece y a veces nombra una comercial
  // (paso con "Nohemi"): Google Fonts no la tiene, la descarga falla y la marca
  // se queda sin tipografia — todas sus piezas saldrian con la del sistema. Se
  // comprueba antes y, si no existe, se cae a una que si, avisando.
  const display = await familiaUsable(
    brand.fonts?.display?.family ?? FALLBACK_DISPLAY,
    FALLBACK_DISPLAY,
    { deps, warnings, rol: "display" },
  );
  const mono = await familiaUsable(brand.fonts?.mono?.family ?? FALLBACK_MONO, FALLBACK_MONO, {
    deps,
    warnings,
    rol: "mono",
  });
  const fonts = {
    display: { family: display, weights: brand.fonts?.display?.weights ?? PESOS_DISPLAY },
    mono: { family: mono, weights: brand.fonts?.mono?.weights ?? PESOS_MONO },
  };
  // Se guarda la familia que REALMENTE se va a usar: si no, el frame.md y el
  // prompt seguirian nombrando una fuente que el render no tiene.
  if (display !== brand.fonts?.display?.family || mono !== brand.fonts?.mono?.family) {
    store.upsertBrand({ id, fonts });
    brand = store.getBrand(id);
  }

  const familias = [fonts.display, fonts.mono];
  const cssPath = join(dir, "assets", "fonts", "brand.css");
  if (opts.force || !existsSync(cssPath)) {
    try {
      const { css, cached } = await deps.buildFontCss(familias, {
        cacheDir: join(cfg.paths?.root ?? ".", "data", "font-cache"),
        log: (m) => log(`  ${m}`),
      });
      writeFileSync(cssPath, css);
      log(`fuentes: ${familias.map((f) => f.family).join(" + ")}${cached ? " (de cache)" : ""}`);
    } catch (err) {
      warnings.push(`no se pudieron bajar las fuentes (${err?.message ?? err}); la marca queda con la del sistema`);
      writeFileSync(cssPath, `/* sin fuentes embebidas: ${String(err?.message ?? err).slice(0, 200)} */\n`);
    }
  }

  // --- sistema de diseno ---
  const frameMd = renderFrameMd(brand);
  writeFileSync(join(dir, "frame.md"), frameMd);

  // --- composicion de referencia: la forma que el modelo copia ---
  const ref = renderReferenceComposition(brand);
  writeFileSync(join(dir, "compositions", "frames", "reference.html"), ref);
  writeFileSync(join(dir, META_DIR, "reference.html"), ref);

  // --- configuracion de HyperFrames ---
  writeFileSync(join(dir, "hyperframes.json"), `${JSON.stringify(hyperframesJson(cfg), null, 2)}\n`);

  // Los sfx del proyecto de referencia sirven para cualquier marca (son sonidos
  // de interfaz, no identidad). Si estan, se copian.
  copiarSfx(cfg, dir);

  store.upsertBrand({ id, frameMd, projectDir: dir });
  log(`proyecto base: ${dir}`);
  return dir;
}

/**
 * La familia que se va a poder usar de verdad.
 *
 * Si Google Fonts no la conoce, devuelve el fallback y deja constancia: es
 * mejor una marca con Inter que una marca sin tipografia.
 */
async function familiaUsable(pedida, fallback, { deps, warnings, rol }) {
  const nombre = String(pedida ?? "").trim();
  if (!nombre) return fallback;
  try {
    if (await deps.familyExists(nombre)) return nombre;
  } catch {
    // Si no se puede consultar (sin red), se intenta con la pedida: quizas
    // este en la cache de fuentes.
    return nombre;
  }
  warnings.push(
    `Google Fonts no tiene "${nombre}" (${rol}), asi que se uso ${fallback}. ` +
      `Si esa tipografia importa, subi los archivos a assets/fonts de la marca.`,
  );
  return fallback;
}

/** Donde vive el proyecto base de una marca. */
export function brandProjectDir(cfg, id) {
  const base = cfg.hyperframes?.brandsDir ?? join(cfg.hyperframes?.projectsDir ?? ".", "_marcas");
  return join(base, id);
}

// ---------------------------------------------------------------------------
// El sistema de diseno, generado
// ---------------------------------------------------------------------------

/**
 * frame.md a partir de la paleta y las tipografias.
 *
 * Es la fuente normativa que el prompt de compose declara: los hex y los roles
 * tipograficos salen de aca y el modelo no puede inventar otros.
 */
export function renderFrameMd(brand) {
  const p = { ...brand.palette };
  const display = brand.fonts?.display?.family ?? FALLBACK_DISPLAY;
  const mono = brand.fonts?.mono?.family ?? FALLBACK_MONO;
  const claro = brand.register === "light";

  return `---
version: 1
name: ${brand.name} — Frame
description: >
  Sistema de diseno de ${brand.name} para piezas de contenido. La unidad es el
  frame: 1920x1080 para video, 1080x1350 para carrusel, 1080x1080 para imagen.
  Los atomos (color, tipografia, aire) son sagrados; la composicion es libre.
unit: el frame
principle: los atomos son sagrados - la composicion es libre - los numeros salen del brief
register: ${claro ? "light" : "dark"}

colors:
  bg: "${p.bg}"
  surface: "${p.surface}"
  ink: "${p.ink}"
  muted: "${p.muted}"
  hint: "${p.hint}"
  line: "${p.line}"
  accent: "${p.accent}"
  on-accent: "${p.onAccent}"

typography:
  display-family: "${display}"
  mono-family: "${mono}"
  # cqw = % del ancho del lienzo. La columna px es para 1080 de ancho.
  body:      { fontFamily: "${display}", cqw: 1.2,  px1080: 13,  weight: 400, lineHeight: 1.6 }
  lead:      { fontFamily: "${display}", cqw: 1.7,  px1080: 18,  weight: 400, lineHeight: 1.5 }
  caption:   { fontFamily: "${display}", cqw: 0.95, px1080: 10,  weight: 400, lineHeight: 1.5 }
  label:     { fontFamily: "${mono}",    cqw: 0.75, px1080: 8,   weight: 600, tracking: "0.14em", upper: true }
  h3:        { fontFamily: "${display}", cqw: 2.8,  px1080: 30,  weight: 600, lineHeight: 1.2 }
  h2:        { fontFamily: "${display}", cqw: 4.5,  px1080: 49,  weight: 700, lineHeight: 1.1, tracking: "-0.02em" }
  stat:      { fontFamily: "${display}", cqw: 5.5,  px1080: 59,  weight: 800, lineHeight: 1.0, tracking: "-0.04em" }
  h1:        { fontFamily: "${display}", cqw: 7.5,  px1080: 81,  weight: 800, lineHeight: 0.95, tracking: "-0.03em" }
  display:   { fontFamily: "${display}", cqw: 11.0, px1080: 119, weight: 800, lineHeight: 0.9, tracking: "-0.04em" }

spacing:
  pad-x: "5.5cqw"
  pad-y: "5.5cqw"
  gap-lg: "3.5cqw"
  gap-md: "2cqw"
  gap-sm: "1cqw"

components:
  ground:
    description: "Fondo a sangre completa, siempre en una capa con class=clip, nunca en #root."
    fill: "{colors.bg}"
  chrome:
    description: "Barras de arriba y abajo con el kicker a la izquierda y el numero a la derecha."
    typography: "{typography.label}"
    color: "{colors.muted}"
    rule: "1px solid {colors.line}"
  kicker:
    typography: "{typography.label}"
    color: "{colors.accent}"
  display-line:
    typography: "{typography.display}"
    color: "{colors.ink}"
    accent-word: "una sola palabra en {colors.accent}, nunca la linea entera"
  support-line:
    typography: "{typography.lead}"
    color: "{colors.muted}"
  panel:
    description: "Bloque de apoyo (codigo, tabla, cita) sobre {colors.surface} con borde {colors.line}."
    radius: "2px"
  code:
    typography: "{typography.body} en {typography.mono-family}"
    color: "{colors.ink}"
    accent: "{colors.accent} para el token que importa"
---

# Como se compone

- **Un momento de display por pieza.** El titular manda; todo lo demas es 3-6
  veces mas chico y sirve para sostenerlo.
- **El acento se gana.** ${p.accent} aparece una vez por frame: una palabra, una
  regla, un dato. Dos acentos compiten y ninguno gana.
- **El aire es del sistema.** Margen de seguridad de 5% en los cuatro lados; el
  contenido ocupa el lienzo, no se amontona arriba a la izquierda.
- **La jerarquia es de tamano, no de color.** El texto secundario es ${p.muted},
  no ${p.ink} mas chico.
- **Sin degrades, sin sombras suaves, sin bordes redondeados grandes.** Plano,
  con reglas de 1px y bloques francos.

# Voz

${brand.voice ?? "Directa y concreta."}

Nunca: ${(brand.never ?? []).join(" / ") || "—"}
`;
}

/**
 * La composicion de referencia: el ejemplo de FORMA que el modelo copia.
 *
 * No es una pieza de contenido — es el molde: el <template>, el #root con sus
 * data-*, las dos capas clip, los ids estables y la timeline registrada. Que
 * cada marca tenga la suya (con sus colores y su tipografia) es lo que evita
 * que todas las marcas terminen pareciendose a la primera.
 */
export function renderReferenceComposition(brand) {
  const p = brand.palette ?? {};
  const display = brand.fonts?.display?.family ?? FALLBACK_DISPLAY;
  const mono = brand.fonts?.mono?.family ?? FALLBACK_MONO;
  return `<!doctype html>
<template>
  <style>
    /* @@BCA_FONTS@@ */
    #root {
      position: absolute; inset: 0;
      width: 1080px; height: 1080px;
      overflow: hidden; container-type: size;
      font-family: "${display}", sans-serif;
      color: ${p.ink};
      background: ${p.bg};
    }
    .ref-ground { position: absolute; inset: 0; background: ${p.bg}; }
    .ref-stage  { position: absolute; inset: 0; padding: 60px; }
    .ref-kicker {
      position: absolute; top: 60px; left: 60px;
      font-family: "${mono}", monospace; font-size: 15px; font-weight: 600;
      letter-spacing: 0.14em; text-transform: uppercase; color: ${p.accent};
    }
    .ref-display {
      position: absolute; left: 60px; right: 60px; top: 300px;
      font-size: 119px; font-weight: 800; line-height: 0.9;
      letter-spacing: -0.04em; color: ${p.ink};
    }
    .ref-display .hot { color: ${p.accent}; }
    .ref-support {
      position: absolute; left: 60px; right: 60px; top: 640px;
      font-size: 22px; line-height: 1.5; color: ${p.muted};
    }
    .ref-panel {
      position: absolute; left: 60px; right: 60px; top: 740px;
      border: 1px solid ${p.line}; background: ${p.surface}; padding: 28px;
      font-family: "${mono}", monospace; font-size: 18px; color: ${p.ink};
    }
    .ref-rule { position: absolute; left: 60px; bottom: 110px; width: 220px; height: 2px; background: ${p.accent}; }
    .ref-foot {
      position: absolute; left: 60px; right: 60px; bottom: 60px;
      display: flex; justify-content: space-between;
      font-family: "${mono}", monospace; font-size: 13px;
      letter-spacing: 0.14em; text-transform: uppercase; color: ${p.hint};
    }
  </style>

  <div id="root" data-composition-id="ref" data-start="0" data-duration="4"
       data-width="1080" data-height="1080">
    <div id="ref-ground" class="clip ref-ground" data-start="0" data-duration="4" data-track-index="0"></div>
    <div id="ref-stage" class="clip ref-stage" data-start="0" data-duration="4" data-track-index="1">
      <div id="ref-kicker" class="ref-kicker">${escapeHtml(brand.name)}</div>
      <div id="ref-display" class="ref-display">el titular manda<span class="hot">.</span></div>
      <div id="ref-support" class="ref-support">La linea de apoyo explica en una frase, sin repetir el titular.</div>
      <div id="ref-panel" class="ref-panel">un bloque de apoyo: codigo, dato o cita</div>
      <div id="ref-rule" class="ref-rule"></div>
      <div id="ref-foot" class="ref-foot"><span id="ref-foot-left">${escapeHtml(brand.name)}</span><span id="ref-foot-right">01</span></div>
    </div>
  </div>

  <script>
    window.__timelines = window.__timelines || {};
    (function () {
      var tl = gsap.timeline({ paused: true });
      gsap.set("#ref-kicker",  { opacity: 0, y: -12 });
      gsap.set("#ref-display", { opacity: 0, y: 34 });
      gsap.set("#ref-support", { opacity: 0, y: 18 });
      gsap.set("#ref-panel",   { opacity: 0, y: 22 });
      gsap.set("#ref-rule",    { opacity: 0, scaleX: 0, transformOrigin: "0% 50%" });
      gsap.set("#ref-foot",    { opacity: 0 });

      tl.to("#ref-kicker",  { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, 0.05);
      tl.to("#ref-display", { opacity: 1, y: 0, duration: 0.75, ease: "power3.out" }, 0.25);
      tl.to("#ref-support", { opacity: 1, y: 0, duration: 0.55, ease: "power3.out" }, 0.70);
      tl.to("#ref-panel",   { opacity: 1, y: 0, duration: 0.55, ease: "power3.out" }, 1.05);
      tl.to("#ref-rule",    { opacity: 1, scaleX: 1, duration: 0.50, ease: "power3.out" }, 1.45);
      tl.to("#ref-foot",    { opacity: 1, duration: 0.40, ease: "power2.out" }, 1.80);
      // Algo sigue vivo hasta el final: una composicion congelada falla el check.
      tl.to("#ref-rule",    { scaleX: 1.35, duration: 1.6, ease: "none" }, 2.2);

      window.__timelines["ref"] = tl;
    })();
  </script>
</template>
`;
}

// ---------------------------------------------------------------------------
// El modelo propone; el codigo valida
// ---------------------------------------------------------------------------

async function proposeIdentity(cfg, { site, current, hints, name, colors, deps }) {
  const prompt = buildIdentityPrompt({ site, current, hints, name, colors });
  const res = await deps.runClaudeJSON(prompt, {
    model: cfg.models?.brief ?? cfg.models?.plan,
    timeoutMs: cfg.limits?.claudeTimeoutMs,
  });
  const identity = res.data;
  if (!identity || typeof identity !== "object") {
    throw new BrandError("el modelo no devolvio una identidad de marca usable");
  }
  return { identity, costUsd: res.costUsd ?? 0 };
}

export function buildIdentityPrompt({ site, current, hints, name, colors } = {}) {
  const partes = [];
  partes.push(
    "Sos director de arte y estratega de marca. Tenes que definir la identidad con la que un",
    "sistema automatico va a producir posts, imagenes, carruseles y videos.",
    "",
  );

  if (current) {
    partes.push(
      "# La marca hoy",
      JSON.stringify(
        {
          name: current.name,
          audience: current.audience,
          voice: current.voice,
          nameUsage: current.nameUsage,
          never: current.never,
          languages: current.languages,
          languageMix: current.languageMix,
          register: current.register ?? (current.palette?.bg ? null : "dark"),
          palette: current.palette,
          fonts: current.fonts,
        },
        null,
        2,
      ),
      "",
      "# Lo que pidio el usuario",
      String(hints ?? "").trim() || "(sin pedido explicito)",
      "",
      "Cambia SOLO lo que el pedido implica y todo lo que dependa de eso. Lo demas se conserva",
      "tal cual: una revision no es una marca nueva.",
      "",
    );
  } else {
    if (site) {
      partes.push(
        "# El sitio de la marca",
        `URL: ${site.url}`,
        `Titulo: ${site.title || "—"}`,
        `Descripcion: ${site.description || "—"}`,
        "",
        "## Texto del sitio",
        "OJO: puede venir mezclado con ruido tecnico del framework (mensajes de error, nombres de",
        "modulos). Ignoralo y quedate con lo que habla del producto.",
        String(site.text ?? "").slice(0, 7000),
        "",
        "## Colores que ya usa el sitio (hex, con cuantas veces aparecen)",
        (site.colors ?? []).map((c) => `${c.hex} x${c.n}`).join("  ") || "—",
        "",
        "## Tipografias declaradas en su CSS",
        (site.fonts ?? []).map((f) => f.family).join(", ") || "—",
        "",
      );
    }
    if (name) partes.push(`# Nombre pedido por el usuario`, name, "");
    if (colors?.length) {
      partes.push(
        "# Colores que el usuario quiere usar",
        colors.join(", "),
        "Estos mandan sobre los del sitio: acomoda el resto de la paleta alrededor.",
        "",
      );
    }
    if (hints) partes.push("# Lo que pidio el usuario", String(hints), "");
  }

  partes.push(
    "# Que tenes que devolver",
    "Un JSON con exactamente esta forma:",
    "",
    JSON.stringify(
      {
        id: "slug-corto-sin-espacios",
        name: "Nombre de la marca",
        tagline: "una linea de que hace",
        audience: "a quien le habla, concreto",
        voice: "como suena: 3 o 4 rasgos, con ejemplos de registro",
        nameUsage: "como se escribe el nombre y como NO se escribe",
        never: ["frases prohibidas", "el registro que no queremos"],
        languages: ["es", "en"],
        languageMix: { es: 3, en: 2 },
        register: "dark",
        palette: {
          bg: "#0C0F08",
          surface: "#121610",
          ink: "#E8EDDF",
          muted: "#97A188",
          hint: "#7A8170",
          line: "#272E1F",
          accent: "#C4EF3D",
          onAccent: "#0C0F08",
        },
        fonts: {
          display: { family: "Space Grotesk", weights: [400, 600, 700, 800] },
          mono: { family: "IBM Plex Mono", weights: [400, 600] },
        },
        designNotes: "una linea sobre el aire visual de la marca",
        rationale: "por que estas decisiones y no otras",
      },
      null,
      2,
    ),
    "",
    "# Reglas",
    "- `register` es 'dark' o 'light' y tiene que ser coherente con `palette.bg`.",
    "- La paleta es de 7 colores y todos son hex de 6 digitos. `ink` sobre `bg` tiene que ser",
    "  legible (contraste WCAG >= 4.5:1) y `accent` sobre `bg` >= 3:1. `onAccent` es el color del",
    "  texto ARRIBA del acento: elegilo para que contraste con `accent`, no con el fondo.",
    "- `muted` y `hint` son el mismo tono que `ink` pero apagados; `line` es apenas visible sobre `bg`.",
    "- Las dos familias tienen que estar en GOOGLE FONTS y escribirse exactamente como ahi.",
    "  No sirve una tipografia comercial (Nohemi, Gilroy, Circular, Graphik, GT America...):",
    "  el render no la tiene y la pieza sale con la del sistema. Si dudas, elegi de esta lista:",
    "    display: Inter · Space Grotesk · Bricolage Grotesque · Manrope · Sora · Outfit · Figtree ·",
    "             Archivo · Chivo · Epilogue · Playfair Display · Fraunces · Instrument Serif ·",
    "             Bodoni Moda · DM Serif Display · Syne · Unbounded · Anton · Bebas Neue",
    "    mono:    JetBrains Mono · IBM Plex Mono · DM Mono · Space Mono · Roboto Mono ·",
    "             Source Code Pro · Fira Code · Geist Mono",
    "  La display carga el caracter de la marca; la mono es para etiquetas, codigo y datos.",
    "- `never` son frases que el contenido NO puede decir: el vocabulario de folleto que no queremos",
    "  ('experiencia sin fricciones', 'revolucionario', 'potencia tu...'), mas los errores de escritura",
    "  del nombre. Entre 4 y 8.",
    "- `languageMix` reparte el calendario: pesos relativos por idioma, solo de los idiomas listados.",
    "- Nada de prosa fuera del JSON.",
  );
  return partes.filter((x) => x !== undefined).join("\n");
}

/**
 * Convierte lo que devolvio el modelo en una marca guardable: rellena lo que
 * falte, arregla los hex, garantiza contraste y no acepta una familia que no
 * exista.
 */
export function normalizeIdentity(identity, { id, site, notes, previous, warnings = [] } = {}) {
  const prev = previous ?? {};
  const paletteCruda = { ...(prev.palette ?? {}), ...(identity.palette ?? {}) };
  const palette = normalizePalette(paletteCruda, warnings);

  const languages = uniqStrings(identity.languages ?? prev.languages ?? ["en"]).slice(0, 4);
  const mixCrudo = identity.languageMix ?? prev.languageMix ?? null;
  const languageMix = normalizeMix(mixCrudo, languages);

  return {
    id,
    name: String(identity.name ?? prev.name ?? id).trim(),
    site: identity.site ?? site ?? prev.site ?? null,
    audience: String(identity.audience ?? prev.audience ?? "").trim() || null,
    voice: String(identity.voice ?? prev.voice ?? "").trim() || null,
    nameUsage: String(identity.nameUsage ?? prev.nameUsage ?? "").trim() || null,
    never: uniqStrings(identity.never ?? prev.never ?? []).slice(0, 12),
    languages,
    languageMix,
    register: identity.register === "light" ? "light" : "dark",
    palette,
    fonts: {
      display: normalizeFont(identity.fonts?.display, prev.fonts?.display, FALLBACK_DISPLAY, PESOS_DISPLAY),
      mono: normalizeFont(identity.fonts?.mono, prev.fonts?.mono, FALLBACK_MONO, PESOS_MONO),
    },
    tagline: identity.tagline ?? prev.tagline ?? null,
    designNotes: identity.designNotes ?? prev.designNotes ?? null,
    notes: notes ?? prev.notes ?? null,
    sourceUrl: site ?? prev.sourceUrl ?? null,
  };
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

export function normalizePalette(p = {}, warnings = []) {
  const out = {};
  for (const k of CLAVES_PALETA) {
    out[k] = toHex(p[k]) ?? null;
  }
  // Defaults sobrios si el modelo se olvido de algo: mejor una marca fea que
  // una composicion con "undefined" en el CSS.
  out.bg = out.bg ?? "#0E0E10";
  out.ink = out.ink ?? "#F2F2F0";
  out.surface = out.surface ?? mezclar(out.bg, out.ink, 0.06);
  out.muted = out.muted ?? mezclar(out.bg, out.ink, 0.62);
  out.hint = toHex(p.hint) ?? mezclar(out.bg, out.ink, 0.42);
  out.line = out.line ?? mezclar(out.bg, out.ink, 0.18);
  out.accent = out.accent ?? "#7C5CFF";
  out.onAccent = out.onAccent ?? (contrast(out.accent, "#000000") >= contrast(out.accent, "#FFFFFF") ? "#000000" : "#FFFFFF");

  // El linter de HyperFrames falla las piezas por contraste; arreglarlo aca es
  // gratis y evita que cada pieza pelee con el mismo problema.
  if (contrast(out.ink, out.bg) < 4.5) {
    const arreglado = forzarContraste(out.ink, out.bg, 4.5);
    warnings.push(`el texto (${out.ink}) no contrastaba sobre el fondo: se ajusto a ${arreglado}`);
    out.ink = arreglado;
  }
  if (contrast(out.accent, out.bg) < 3) {
    const arreglado = forzarContraste(out.accent, out.bg, 3);
    warnings.push(`el acento (${out.accent}) no se veia sobre el fondo: se ajusto a ${arreglado}`);
    out.accent = arreglado;
  }
  if (contrast(out.onAccent, out.accent) < 4.5) {
    out.onAccent = contrast("#000000", out.accent) >= contrast("#FFFFFF", out.accent) ? "#000000" : "#FFFFFF";
  }
  if (contrast(out.muted, out.bg) < 3) {
    out.muted = forzarContraste(out.muted, out.bg, 3);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Varios
// ---------------------------------------------------------------------------

function normalizeFont(propuesta, anterior, fallback, pesosPorDefecto) {
  const family = String(propuesta?.family ?? anterior?.family ?? fallback).trim() || fallback;
  const weights = Array.isArray(propuesta?.weights) && propuesta.weights.length
    ? propuesta.weights
    : Array.isArray(anterior?.weights) && anterior.weights.length
      ? anterior.weights
      : pesosPorDefecto;
  return { family, weights };
}

function normalizeMix(mix, languages) {
  const out = {};
  if (mix && typeof mix === "object") {
    for (const l of languages) {
      const n = Number(mix[l]);
      if (Number.isFinite(n) && n > 0) out[l] = Math.round(n);
    }
  }
  if (!Object.keys(out).length) for (const l of languages) out[l] = 1;
  return out;
}

function uniqStrings(arr) {
  const out = [];
  const vistos = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(s);
  }
  return out;
}

function hyperframesJson(cfg) {
  const ref = cfg.hyperframes?.referenceProject;
  const propio = ref ? join(ref, "hyperframes.json") : null;
  if (propio && existsSync(propio)) {
    try {
      return JSON.parse(readFileSync(propio, "utf8"));
    } catch {
      /* si el de referencia esta roto, se usa el default de abajo */
    }
  }
  return {
    $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
    registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
    paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
    media: { autoProxy: true },
  };
}

function copiarSfx(cfg, dir) {
  const src = cfg.hyperframes?.referenceProject
    ? join(cfg.hyperframes.referenceProject, "assets", "sfx")
    : null;
  if (!src || !existsSync(src)) return;
  try {
    cpSync(src, join(dir, "assets", "sfx"), { recursive: true, force: false });
  } catch {
    /* los sfx son un lujo: sin ellos el video sale igual, mudo */
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
