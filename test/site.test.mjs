// Lectura de sitios. Todo con un fetch de mentira: los tests no salen a
// internet, que ademas los volveria intermitentes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractColors, extractFonts, getPage, normalizeUrl, readSite, textoDeScripts } from "../src/lib/site.mjs";

/** fetch de mentira: mapa de url -> { body, type, status }. */
function fakeFetch(paginas) {
  return async (url) => {
    const p = paginas[String(url)];
    if (!p) return { ok: false, status: 404, headers: new Map(), text: async () => "" };
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? (p.type ?? "text/html") : null) },
      text: async () => p.body,
      arrayBuffer: async () => Buffer.from(p.body),
    };
  };
}

test("normalizeUrl completa el esquema y rechaza basura", () => {
  assert.equal(normalizeUrl("ejemplo.com"), "https://ejemplo.com/");
  assert.equal(normalizeUrl("https://ejemplo.com/x"), "https://ejemplo.com/x");
  assert.throws(() => normalizeUrl(""), /URL/);
});

test("extractColors saca hex y rgb, y cuenta repeticiones", () => {
  const colores = extractColors("a{color:#0C0F08}b{background:#0c0f08}c{color:rgb(255, 0, 0)}d{color:#abc}");
  assert.ok(colores.includes("#0c0f08"));
  assert.ok(colores.includes("#ff0000"));
  assert.ok(colores.includes("#aabbcc"), "expande el hex corto");
});

test("extractFonts ignora los fallbacks del sistema", () => {
  const fuentes = extractFonts(`h1{font-family:"Space Grotesk", Helvetica, sans-serif}
    code{font-family:'IBM Plex Mono', monospace}
    p{font-family:system-ui}`);
  assert.deepEqual(fuentes, ["Space Grotesk", "IBM Plex Mono"]);
});

test("textoDeScripts rescata el copy de una SPA y descarta el ruido del framework", () => {
  const html = `<html><body><div id="root"></div>
  <script src="/app.js"></script>
  <script>self.__next_f.push([1,"{\\"children\\":\\"Deploy tu backend en un minuto, sin tocar Docker.\\"}"]);
  self.__next_f.push([1,"{\\"msg\\":\\"Warning: each child in a list should have a unique key prop\\"}"]);</script>
  </body></html>`;
  const texto = textoDeScripts(html);
  assert.match(texto, /Deploy tu backend en un minuto/);
  assert.doesNotMatch(texto, /unique key prop/, "los mensajes de React no son copy de la marca");
});

test("getPage saca titulo, descripcion, headings y texto", async () => {
  const html = `<html><head><title>Mi Producto — el backend</title>
    <meta name="description" content="Un backend que se despliega solo">
    <link rel="stylesheet" href="/estilo.css"></head>
    <body><h1>El backend que se arma solo</h1><h2>Sin Docker</h2>
    <p>${"texto util ".repeat(100)}</p>
    <script>var x = 1;</script></body></html>`;
  const p = await getPage("https://ejemplo.com/", { fetchImpl: fakeFetch({ "https://ejemplo.com/": { body: html } }) });

  assert.equal(p.title, "Mi Producto — el backend");
  assert.equal(p.description, "Un backend que se despliega solo");
  assert.deepEqual(p.headings, ["El backend que se arma solo", "Sin Docker"]);
  assert.match(p.text, /texto util/);
  assert.doesNotMatch(p.text, /var x = 1/, "el JS no es contenido");
  assert.deepEqual(p.stylesheets, ["https://ejemplo.com/estilo.css"]);
});

test("readSite sigue los links interesantes del mismo host y junta la paleta", async () => {
  const home = `<html><head><title>Marca</title>
    <style>:root{--bg:#0C0F08}.x{color:#C4EF3D;font-family:"Space Grotesk",sans-serif}</style></head>
    <body><h1>Titular</h1><p>${"contenido real ".repeat(80)}</p>
    <a href="/pricing">Precios</a><a href="/blog/algo">Blog</a>
    <a href="https://otrositio.com/pricing">Afuera</a></body></html>`;
  const pricing = `<html><head><title>Precios</title></head><body><p>${"desde 9 dolares ".repeat(60)}</p></body></html>`;

  const sitio = await readSite("https://marca.com", {
    maxPages: 3,
    fetchImpl: fakeFetch({
      "https://marca.com/": { body: home },
      "https://marca.com/pricing": { body: pricing },
    }),
  });

  assert.equal(sitio.host, "marca.com");
  assert.equal(sitio.title, "Marca");
  assert.deepEqual(sitio.pages.map((p) => p.url), ["https://marca.com/", "https://marca.com/pricing"]);
  assert.match(sitio.text, /desde 9 dolares/, "el contenido de las paginas internas entra");
  assert.ok(sitio.colors.some((c) => c.hex === "#c4ef3d"));
  assert.ok(sitio.fonts.some((f) => f.family === "Space Grotesk"));
});

test("readSite no se cae si una pagina interna falla", async () => {
  const home = `<html><head><title>M</title></head><body><p>${"hola ".repeat(200)}</p>
    <a href="/docs">Docs</a></body></html>`;
  const sitio = await readSite("https://marca.com", {
    maxPages: 3,
    fetchImpl: fakeFetch({ "https://marca.com/": { body: home } }), // /docs devuelve 404
  });
  assert.equal(sitio.pages.length, 1);
  assert.match(sitio.text, /hola/);
});
