// Tipografia de marca: de un nombre de familia a un CSS con las fuentes dentro.
//
// El render corre sin red (el navegador del capture no sale a internet) y las
// composiciones no pueden traer <link> a Google Fonts: la regla 9 del prompt lo
// prohibe y `check` lo marca. Asi que la fuente viaja embebida en base64 dentro
// del CSS del proyecto, igual que hacia el proyecto de referencia a mano.
//
// Aca se automatiza eso: se le pide a Google Fonts el CSS de la familia, se
// bajan los .woff2 que referencia y se reescribe cada `src: url(...)` como un
// data URI. El resultado se cachea en disco por familia+pesos, porque una marca
// nueva no tiene por que volver a bajar lo mismo que ya bajo otra.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Google devuelve woff2 solo si el que pide parece un navegador moderno. Con el
// user-agent de node manda TTF, que pesa 3-4 veces mas.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Los subsets que sirven para es / en / pt. Traer cirilico y griego multiplica
// el peso del proyecto sin que ninguna pieza los use.
const SUBSETS = new Set(["latin", "latin-ext"]);

const DEFAULT_WEIGHTS = [400, 600, 700, 800];

export class FontError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "FontError";
    this.cause = cause ?? null;
  }
}

/**
 * CSS con `@font-face` embebidos para una o varias familias.
 *
 * @param {Array<{family: string, weights?: number[]}>} familias
 * @param {object} [opts]
 * @param {string} [opts.cacheDir]  donde guardar lo ya descargado
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ css: string, families: string[], bytes: number, cached: boolean }>}
 */
export async function buildFontCss(familias, opts = {}) {
  const lista = (Array.isArray(familias) ? familias : [familias]).filter(Boolean);
  if (!lista.length) throw new FontError("no se pidio ninguna familia");

  const clave = cacheKey(lista);
  const cacheFile = opts.cacheDir ? join(opts.cacheDir, `${clave}.css`) : null;
  if (cacheFile && existsSync(cacheFile)) {
    const css = readFileSync(cacheFile, "utf8");
    return { css, families: lista.map((f) => f.family), bytes: css.length, cached: true };
  }

  const partes = [];
  for (const f of lista) {
    partes.push(await familyCss(f, opts));
  }
  const css = partes.join("\n\n");

  if (cacheFile) {
    mkdirSync(opts.cacheDir, { recursive: true });
    writeFileSync(cacheFile, css);
  }
  return { css, families: lista.map((f) => f.family), bytes: css.length, cached: false };
}

/** ¿Existe esa familia en Google Fonts? Sirve para no aceptar un invento del modelo. */
export async function familyExists(family, opts = {}) {
  try {
    const res = await pedir(cssUrl(family, [400]), opts);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

async function familyCss({ family, weights }, opts) {
  const pesos = normalizarPesos(weights);
  const res = await pedir(cssUrl(family, pesos), opts);
  if (!res.ok) {
    throw new FontError(
      `Google Fonts no conoce "${family}" (${res.status}). Elegi una familia que exista o subi los archivos a mano.`,
    );
  }
  const cssRemoto = await res.text();
  const bloques = bloquesUtiles(cssRemoto);
  if (!bloques.length) {
    throw new FontError(`Google Fonts devolvio un CSS sin @font-face para "${family}"`);
  }

  // Las URLs se repiten entre bloques (mismo archivo para varios rangos): una
  // sola descarga por URL y el data URI se reusa.
  const urls = [...new Set(bloques.flatMap((b) => [...b.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1])))];
  const datos = new Map();
  for (const url of urls) {
    datos.set(url, await descargarComoDataUri(url, opts));
  }

  const salida = bloques
    .map((b) => b.replace(/url\((https:[^)]+)\)/g, (_, url) => `url(${datos.get(url) ?? url})`))
    .join("\n");
  opts.log?.(`fuente ${family}: ${bloques.length} cara(s), ${Math.round(salida.length / 1024)} KB`);
  return `/* ${family} — embebida por Brand Content AI, sin red en el render */\n${salida}`;
}

function cssUrl(family, pesos) {
  const fam = String(family).trim().replace(/\s+/g, "+");
  return `https://fonts.googleapis.com/css2?family=${fam}:wght@${pesos.join(";")}&display=swap`;
}

function normalizarPesos(weights) {
  const arr = (Array.isArray(weights) && weights.length ? weights : DEFAULT_WEIGHTS)
    .map((w) => Math.round(Number(w)))
    .filter((w) => Number.isFinite(w) && w >= 100 && w <= 900)
    .sort((a, b) => a - b);
  return [...new Set(arr)].length ? [...new Set(arr)] : DEFAULT_WEIGHTS;
}

/**
 * Parte el CSS de Google en bloques `@font-face` y se queda con los subsets que
 * usamos. El nombre del subset viene en un comentario justo antes del bloque.
 */
function bloquesUtiles(css) {
  const out = [];
  const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/gi;
  let m;
  while ((m = re.exec(css)) !== null) {
    if (SUBSETS.has(m[1].toLowerCase())) out.push(m[2]);
  }
  // Si Google no anota subsets (pasa con algunas familias), se toma todo.
  if (!out.length) {
    const todos = css.match(/@font-face\s*\{[^}]*\}/gi) ?? [];
    return todos;
  }
  return out;
}

async function descargarComoDataUri(url, opts) {
  const res = await pedir(url, opts);
  if (!res.ok) throw new FontError(`no se pudo bajar ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tipo = url.endsWith(".woff2") ? "font/woff2" : url.endsWith(".woff") ? "font/woff" : "font/ttf";
  return `data:${tipo};base64,${buf.toString("base64")}`;
}

async function pedir(url, { timeoutMs = 30_000, fetchImpl = globalThis.fetch } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers: { "user-agent": UA }, signal: ac.signal });
  } catch (err) {
    throw new FontError(`no se pudo llegar a ${url}: ${err?.message ?? err}`, { cause: err });
  } finally {
    clearTimeout(t);
  }
}

function cacheKey(lista) {
  const firma = lista
    .map((f) => `${String(f.family).toLowerCase()}:${normalizarPesos(f.weights).join(",")}`)
    .sort()
    .join("|");
  const slug = String(lista[0]?.family ?? "font")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${slug}-${createHash("sha256").update(firma).digest("hex").slice(0, 10)}`;
}
