// Lectura de un sitio web, sin dependencias.
//
// Es la materia prima de dos cosas distintas:
//   - la MARCA: colores que ya usa, tipografias, como se presenta, que promete
//   - el CONOCIMIENTO: los hechos citables que el contenido puede afirmar
//
// No pretende ser un crawler: baja la home y un punado de paginas que suelen
// concentrar la sustancia (producto, precios, docs, about), extrae texto plano
// y mira el CSS para sacar la paleta. Con eso alcanza para arrancar una marca;
// lo que falte lo corrige el usuario iterando.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Rutas que casi siempre valen la pena cuando existen.
const INTERESANTES =
  /\b(pricing|precios|planes|plans|product|producto|features|caracteristicas|docs|documentation|about|nosotros|quienes|how-it-works|como-funciona|solutions|platform)\b/i;

const MAX_HTML_BYTES = 2_000_000;

export class SiteError extends Error {
  constructor(message, { cause, status } = {}) {
    super(message);
    this.name = "SiteError";
    this.cause = cause ?? null;
    this.status = status ?? null;
  }
}

/**
 * Lee un sitio y devuelve lo que se puede saber de el.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxPages=5]
 * @param {number} [opts.timeoutMs=20000]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<{ url, host, title, description, pages, text, headings, colors, fonts, links }>}
 */
export async function readSite(url, opts = {}) {
  const { maxPages = 5, log } = opts;
  const inicio = normalizeUrl(url);
  const home = await getPage(inicio, opts);
  log?.(`sitio: ${inicio} (${home.title || "sin titulo"})`);

  const host = new URL(inicio).host;
  let internos = home.links.filter((l) => sameHost(l, host));
  // Una SPA muchas veces no tiene <a href> en el HTML inicial: el sitemap si.
  if (internos.length < 3) {
    const delSitemap = await leerSitemap(inicio, opts);
    internos = internos.concat(delSitemap.filter((l) => sameHost(l, host)));
    if (delSitemap.length) log?.(`  sitemap: ${delSitemap.length} url(s)`);
  }
  const candidatas = [...new Set(internos)]
    .filter((l) => INTERESANTES.test(new URL(l).pathname))
    .slice(0, Math.max(0, maxPages - 1));

  const paginas = [home];
  for (const l of candidatas) {
    try {
      const p = await getPage(l, opts);
      paginas.push(p);
      log?.(`  + ${new URL(l).pathname}`);
    } catch (err) {
      log?.(`  ! ${l}: ${err?.message ?? err}`);
    }
  }

  // Una SPA pura (un <div id="root"> y todo el copy dentro del bundle) no deja
  // nada que leer en el HTML. El texto igual esta: son strings literales dentro
  // del JS. Se baja el bundle y se pescan las frases. Es feo, pero es la
  // diferencia entre poder crear una marca desde una URL y no poder.
  let extra = "";
  const textoHome = home.text ?? "";
  if (textoHome.length < 800 && (home.scripts ?? []).length) {
    extra = await textoDeBundles(home.scripts.filter((l) => sameHost(l, host)), opts);
    if (extra) log?.(`  bundle: ${Math.round(extra.length / 1024)} KB de texto recuperado`);
  }

  // El CSS se mira solo en la home: es donde estan los tokens de marca, y bajar
  // hojas de todas las paginas multiplica el tiempo sin cambiar el resultado.
  const css = await readStylesheets(home, opts);
  const colores = rankColors([...extractColors(home.rawStyles), ...extractColors(css)]);
  const fuentes = rankFonts([...extractFonts(home.rawStyles), ...extractFonts(css)]);

  return {
    url: inicio,
    host,
    title: home.title,
    description: home.description,
    pages: paginas.map((p) => ({ url: p.url, title: p.title, text: p.text })),
    text: [
      ...paginas.map((p) => `## ${p.title || p.url}\n${p.text}`),
      extra ? `## texto recuperado del bundle\n${extra}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    headings: paginas.flatMap((p) => p.headings).slice(0, 60),
    colors: colores,
    fonts: fuentes,
    links: home.links.slice(0, 40),
  };
}

/** Una sola pagina, ya reducida a lo que sirve. */
export async function getPage(url, opts = {}) {
  const res = await pedir(url, opts);
  if (!res.ok) throw new SiteError(`${url} respondio ${res.status}`, { status: res.status });
  const tipo = res.headers.get("content-type") ?? "";
  if (tipo && !/text\/html|application\/xhtml/i.test(tipo)) {
    throw new SiteError(`${url} no es HTML (${tipo})`);
  }
  const html = (await res.text()).slice(0, MAX_HTML_BYTES);
  return {
    url,
    title: pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description:
      pickAttr(html, /<meta[^>]+name=["']description["'][^>]*>/i, "content") ??
      pickAttr(html, /<meta[^>]+property=["']og:description["'][^>]*>/i, "content") ??
      "",
    headings: [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)]
      .map((m) => limpiar(m[2]))
      .filter(Boolean)
      .slice(0, 40),
    // Una SPA sirve un HTML casi vacio y pinta el texto con JS. En esos casos el
    // contenido igual viaja en la pagina, dentro del payload que hidrata la app
    // (__NEXT_DATA__, self.__next_f.push, etc.): de ahi se saca.
    text: mejorTexto(html).slice(0, 12_000),
    links: [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)]
      .map((m) => absolutizar(m[1], url))
      .filter(Boolean),
    rawStyles: [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n"),
    scripts: [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => absolutizar(m[1], url))
      .filter(Boolean),
    stylesheets: [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)]
      .map((m) => pickAttr(m[0], /.*/, "href"))
      .filter(Boolean)
      .map((h) => absolutizar(h, url))
      .filter(Boolean),
    html,
  };
}

/** Colores hex del CSS, de mas usado a menos. Ignora blancos y negros puros. */
export function extractColors(css) {
  const out = [];
  for (const m of String(css ?? "").matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    out.push(expandirHex(`#${m[1]}`));
  }
  for (const m of String(css ?? "").matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/gi)) {
    out.push(rgbAHex(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  return out;
}

export function extractFonts(css) {
  const out = [];
  for (const m of String(css ?? "").matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const parte of m[1].split(",")) {
      const f = parte.trim().replace(/^["']|["']$/g, "");
      if (!f || /^(inherit|initial|unset|var\()/i.test(f)) continue;
      if (/^(sans-serif|serif|monospace|system-ui|ui-\w+|-apple-system|BlinkMacSystemFont|Segoe UI|Helvetica|Arial|Roboto)$/i.test(f)) continue;
      out.push(f);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/**
 * Frases sueltas dentro de los bundles JS de una SPA.
 *
 * Se queda con lo que parece copy de la pagina y descarta el ruido del
 * framework. No es exacto — no puede serlo — pero un titular y tres bullets
 * alcanzan para que el modelo entienda de que va la marca.
 */
// Lo que sale de un bundle es mitad copy y mitad mensajes del framework. Esto
// tira lo segundo: son frases que hablan de programar, no de la marca.
const RUIDO_DE_FRAMEWORK = new RegExp(
  [
    "\\b(react|props?|render|rendered|rendering|component|components|hook|hooks|fiber|dom)\\b",
    "\\b(warning|deprecated|argument|parameter|callback|unmount|boolean|undefined|null|element|elements)\\b",
    "\\b(function|return|typeof|instanceof|async|await|const|var)\\b",
    "\\b(must be|cannot|expected|invalid|failed to|is not a)\\b",
    "\\b(npm|webpack|vite|polyfill|babel|eslint|typescript)\\b",
    "https?://",
  ].join("|"),
  "i",
);

async function textoDeBundles(urls, opts) {
  const frases = [];
  const vistos = new Set();
  for (const url of urls.slice(0, 3)) {
    try {
      const res = await pedir(url, opts);
      if (!res.ok) continue;
      const js = (await res.text()).slice(0, 3_000_000);
      for (const m of js.matchAll(/["'`]([^"'`\\]{24,300})["'`]/g)) {
        const t = m[1].trim();
        if (!pareceProsa(t)) continue;
        if (t.split(/\s+/).length < 4) continue; // al menos 4 palabras
        if (RUIDO_DE_FRAMEWORK.test(t)) continue;
        // El copy de una landing arranca como una oracion, no como un log.
        if (!/^[A-Z\u00C0-\u00DC0-9]/.test(t)) continue;
        const k = t.toLowerCase();
        if (vistos.has(k)) continue;
        vistos.add(k);
        frases.push(t);
        if (frases.length >= 300) return frases.join("\n");
      }
    } catch {
      /* un bundle que no baja no rompe la lectura */
    }
  }
  return frases.join("\n");
}

/** URLs del sitemap.xml, si hay. Nunca hace fallar la lectura del sitio. */
async function leerSitemap(base, opts) {
  try {
    const u = new URL("/sitemap.xml", base).toString();
    const res = await pedir(u, opts);
    if (!res.ok) return [];
    const xml = (await res.text()).slice(0, 500_000);
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]).slice(0, 60);
  } catch {
    return [];
  }
}

async function readStylesheets(page, opts) {
  const hojas = (page.stylesheets ?? []).slice(0, 3);
  const partes = [];
  for (const href of hojas) {
    try {
      const res = await pedir(href, opts);
      if (res.ok) partes.push((await res.text()).slice(0, 400_000));
    } catch {
      /* una hoja que no baja no es motivo para abortar la lectura del sitio */
    }
  }
  return partes.join("\n");
}

function rankColors(lista) {
  const cuenta = new Map();
  for (const c of lista) {
    if (!c) continue;
    const k = c.toLowerCase();
    cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
  }
  return [...cuenta.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex, n]) => ({ hex, n }))
    .slice(0, 24);
}

function rankFonts(lista) {
  const cuenta = new Map();
  for (const f of lista) {
    const k = f.trim();
    if (!k) continue;
    cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
  }
  return [...cuenta.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([family, n]) => ({ family, n }))
    .slice(0, 8);
}

/** El texto visible; si el HTML esta vacio porque es una SPA, el del payload. */
function mejorTexto(html) {
  const visible = textoPlano(html);
  if (visible.length >= 800) return visible;
  const embebido = textoDeScripts(html);
  if (!embebido) return visible;
  return visible ? `${visible}

${embebido}` : embebido;
}

/**
 * Texto humano escondido en los scripts de hidratacion.
 *
 * No intenta entender el formato (cambia con cada framework): busca cadenas
 * JSON largas que parezcan prosa y descarta lo que huele a codigo — rutas,
 * clases de Tailwind, hashes, nombres de modulo.
 */
export function textoDeScripts(html) {
  const scripts = [...String(html).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((s) => /__NEXT_DATA__|__next_f|__NUXT|__remixContext|window\.__/.test(s) || s.length > 2000)
    .join("\n");
  if (!scripts) return "";

  // El payload viene escapado dos veces: primero se desescapa para que las
  // frases queden legibles, y recien despues se buscan cadenas.
  const crudo = scripts
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"');

  const vistos = new Set();
  const frases = [];
  for (const m of crudo.matchAll(/"([^"\\]{16,400})"/g)) {
    const t = m[1].trim();
    if (!pareceProsa(t)) continue;
    // El payload de hidratacion tambien arrastra mensajes del framework: son
    // texto humano, pero hablan de programar, no de la marca.
    if (RUIDO_DE_FRAMEWORK.test(t)) continue;
    const k = t.toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    frases.push(t);
    if (frases.length >= 400) break;
  }
  return frases.join("\n");
}

/** Heuristica barata: la prosa tiene espacios, letras y poca sintaxis. */
function pareceProsa(t) {
  if (!/\s/.test(t)) return false;
  if (/^[\/.#]|[{}<>;=]|\.(js|css|png|jpg|svg|webp|woff2?)\b/i.test(t)) return false;
  // clases utilitarias tipo "flex items-center gap-2"
  if (/^[a-z-]+(\s+[a-z0-9:-]+){2,}$/.test(t) && !/[.,!?]/.test(t)) return false;
  const letras = (t.match(/[a-zA-Z\u00C0-\u024F]/g) ?? []).length;
  return letras / t.length > 0.6;
}

function textoPlano(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function limpiar(s) {
  return textoPlano(s).replace(/\s+/g, " ").trim().slice(0, 200);
}

function pick(html, re) {
  const m = String(html).match(re);
  return m ? limpiar(m[1]) : "";
}

function pickAttr(tag, re, attr) {
  const m = String(tag).match(re);
  if (!m) return null;
  const a = m[0].match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i"));
  return a ? a[1].trim() : null;
}

function absolutizar(href, base) {
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function sameHost(url, host) {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

export function normalizeUrl(url) {
  const s = String(url ?? "").trim();
  if (!s) throw new SiteError("hace falta una URL");
  const conEsquema = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(conEsquema).toString();
  } catch {
    throw new SiteError(`URL invalida: ${url}`);
  }
}

function expandirHex(hex) {
  const h = hex.toLowerCase();
  if (h.length === 4) return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  return h;
}

function rgbAHex(r, g, b) {
  const c = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

async function pedir(url, { timeoutMs = 20_000, fetchImpl = globalThis.fetch } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/css,*/*" },
      signal: ac.signal,
      redirect: "follow",
    });
  } catch (err) {
    throw new SiteError(`no se pudo leer ${url}: ${err?.message ?? err}`, { cause: err });
  } finally {
    clearTimeout(t);
  }
}
