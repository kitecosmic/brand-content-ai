// Los entregables, de los cuatro tipos: verlos, ampliarlos y descargarlos.
//
// Se prueba contra el panel de verdad porque lo que importa es lo que llega al
// navegador: que la tarjeta traiga con que ampliar y con que descargar, y que el
// server mande el archivo como adjunto cuando se lo piden. Durante un tiempo
// solo el video se podia mirar en grande o guardar —lo traia gratis el
// <video controls>— y el resto quedaba encerrado en una miniatura.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/lib/store.mjs";
import { startWeb } from "../src/lib/web.mjs";

// Un PNG de 1x1 de verdad: el panel mira la extension, pero un archivo que no
// es una imagen convertiria cualquier revision visual en una mentira.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let root;
let store;
let server;
let base;
let cookie;

const CFG = {
  formats: { text: { enabled: true, kind: "text" } },
  limits: {},
  web: { port: 0 },
  models: {},
};

const PIEZAS = [
  { id: "e-text", format: "text", archivo: "post.txt" },
  { id: "e-image", format: "image", archivo: "imagen.png" },
  { id: "e-carousel", format: "carousel", archivo: "slides" },
  { id: "e-video", format: "video", archivo: "video.mp4" },
];

before(async () => {
  root = mkdtempSync(join(tmpdir(), "bca-entregables-"));
  writeFileSync(join(root, "vacio.env"), "# vacio\n");
  process.env.BCA_ENV_FILE = join(root, "vacio.env");

  const assets = join(root, "assets");
  mkdirSync(join(assets, "slides"), { recursive: true });
  writeFileSync(join(assets, "post.txt"), "Un post de prueba.\nCon dos lineas.\n");
  writeFileSync(join(assets, "imagen.png"), PNG_1X1);
  for (const n of [1, 2, 3]) writeFileSync(join(assets, "slides", `slide-${n}.png`), PNG_1X1);
  writeFileSync(join(assets, "video.mp4"), Buffer.alloc(64));

  store = openStore(join(root, "data", "brand-content-ai.db"));
  store.upsertBrand({ id: "marca", name: "Marca", palette: {}, languages: ["es"] });

  for (const p of PIEZAS) {
    store.upsertItem({
      id: p.id,
      brand_id: "marca",
      scheduled_for: "2026-08-19",
      format: p.format,
      language: "es",
      angle: `Pieza de ${p.format}`,
      message: "mensaje",
    });
    store.setStatus(p.id, "built", { asset_path: join(assets, p.archivo) });
  }

  server = await startWeb(CFG, store, {}, { port: 4384, log: () => {} });
  base = "http://127.0.0.1:4384";

  const alta = await fetch(`${base}/setup`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({
      name: "Joel",
      email: "joel@marca.com",
      password: "una frase larga y facil",
    }).toString(),
  });
  cookie = (alta.headers.get("set-cookie") ?? "").split(";")[0];
});

after(() => {
  try {
    server?.closeAllConnections?.();
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

/**
 * La tarjeta del entregable, sin el resto de la pagina.
 *
 * Acotarlo importa: el JS del panel nombra los mismos `data-*` que el markup, y
 * buscarlos en el documento entero da por bueno cualquier cosa.
 */
async function tarjeta(id) {
  const html = await (await fetch(`${base}/item/${id}`, { headers: { cookie } })).text();
  const desde = html.indexOf('<div class="grid dos">');
  const hasta = html.indexOf("Qué tiene que comunicar", desde);
  assert.ok(desde > 0 && hasta > desde, "no se encontro la tarjeta del entregable");
  return html.slice(desde, hasta);
}

test("los cuatro tipos se pueden ver en grande y descargar", async () => {
  for (const p of PIEZAS) {
    const media = await tarjeta(p.id);
    assert.match(media, /\?descargar=1/, `${p.format}: falta el enlace de descarga`);
    assert.match(
      media,
      /data-ampliar|data-pantalla-completa/,
      `${p.format}: no hay forma de verlo en grande`,
    );
  }
});

test("cada tipo se muestra como corresponde", async () => {
  assert.match(await tarjeta("e-image"), /<img[^>]+data-ampliar/, "la imagen se amplia tocandola");

  const video = await tarjeta("e-video");
  assert.match(video, /<video[^>]+controls/, "el video se reproduce en la pagina");
  assert.match(video, /data-pantalla-completa/, "y tiene su boton de pantalla completa");

  const texto = await tarjeta("e-text");
  assert.match(texto, /Un post de prueba/, "el texto se lee sin descargarlo");
  assert.match(texto, /data-copiar/, "y se puede copiar");

  const carrusel = await tarjeta("e-carousel");
  assert.match(carrusel, /data-galeria/, "los slides son una galeria: el visor los recorre");
  assert.equal(
    (carrusel.match(/href="[^"]+\?descargar=1"/g) ?? []).length,
    3,
    "cada slide tiene su propia descarga",
  );
});

test("descargar manda el archivo como adjunto, y con nombre", async () => {
  const casos = [
    ["e-text", "", /attachment; filename="pieza-de-text\.txt"/],
    ["e-image", "", /attachment; filename="pieza-de-image\.png"/],
    ["e-video", "", /attachment; filename="pieza-de-video\.mp4"/],
    ["e-carousel", "/slide-2.png", /attachment; filename="pieza-de-carousel-slide-2\.png"/],
  ];

  for (const [id, cola, esperado] of casos) {
    const r = await fetch(`${base}/asset/${id}${cola}?descargar=1`, { headers: { cookie } });
    assert.equal(r.status, 200, `${id}: no se pudo descargar`);
    assert.match(r.headers.get("content-disposition") ?? "", esperado, `${id}: mal el nombre`);

    // Sin el parametro tiene que seguir sirviendo inline: es la misma URL que
    // usan el <img> y el <video> de la pagina.
    const visto = await fetch(`${base}/asset/${id}${cola}`, { headers: { cookie } });
    assert.equal(visto.status, 200);
    assert.equal(visto.headers.get("content-disposition"), null, `${id}: no deberia forzar descarga`);
  }
});

test("el visor esta en la pagina, listo para cualquier entregable", async () => {
  const html = await (await fetch(`${base}/item/e-image`, { headers: { cookie } })).text();
  assert.match(html, /<dialog class="visor"/, "hay un visor");
  assert.match(html, /data-visor-pantalla/, "con pantalla completa");
  assert.match(html, /data-visor-siguiente/, "y con las flechas para recorrer una galeria");
});
