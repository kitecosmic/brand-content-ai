// Tests de layouts.mjs: los layouts prefabricados sirven para CUALQUIER marca
// (paleta clara u oscura, cualquier tipografia) y en cualquier lienzo, y el
// HTML que sale cumple el contrato que el render y el linter exigen.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LAYOUT_IDS,
  ajustarTexto,
  anchoTexto,
  layoutCatalog,
  pantallaCompleta,
  renderLayout,
  sampleSlots,
  tonos,
  validateSlots,
} from "../src/lib/layouts.mjs";
import { contrast } from "../src/lib/color.mjs";

const OSCURA = {
  name: "Rapibase",
  palette: { bg: "#0C0F08", surface: "#121610", ink: "#E8EDDF", muted: "#97A188", hint: "#6F7369", line: "#272E1F", accent: "#C4EF3D", onAccent: "#000000" },
  fonts: { display: { family: "Bricolage Grotesque" }, mono: { family: "JetBrains Mono" } },
};
const CLARA = {
  name: "Keio",
  palette: { bg: "#FAF7F5", surface: "#FFFFFF", ink: "#1B1316", muted: "#6E6266", hint: "#A89BA0", line: "#EADFDB", accent: "#C2273F", onAccent: "#FFFFFF" },
  fonts: { display: { family: "Inter" }, mono: { family: "DM Mono" } },
};
const LIENZOS = [
  [1920, 1080],
  [1080, 1350],
  [1080, 1080],
  [1080, 1920],
];

test("tonos: en el registro invertido los intermedios se re-derivan con contraste garantizado", () => {
  for (const brand of [OSCURA, CLARA]) {
    for (const reg of ["dark", "light"]) {
      const t = tonos(brand.palette, reg);
      assert.ok(contrast(t.ink, t.ground) >= 4.5, `${brand.name}/${reg}: tinta sobre tierra`);
      assert.ok(contrast(t.muted, t.ground) >= 4.5, `${brand.name}/${reg}: muted sobre tierra`);
      assert.ok(contrast(t.accent, t.ground) >= 3, `${brand.name}/${reg}: acento (texto grande)`);
      assert.ok(contrast(t.accentText, t.ground) >= 4.5, `${brand.name}/${reg}: acento en texto chico`);
    }
  }
  // La paleta clara en registro dark usa la tinta como tierra; la oscura, su propio bg.
  assert.equal(tonos(CLARA.palette, "dark").ground, "#1B1316");
  assert.equal(tonos(OSCURA.palette, "dark").ground, "#0C0F08");
  assert.equal(tonos(OSCURA.palette, "light").ground, "#E8EDDF");
});

test("ajustarTexto nunca parte una palabra y respeta las lineas pedidas", () => {
  const texto = "otro proveedor, otra factura, otra documentacion";
  const fit = ajustarTexto(texto, { maxWidth: 900, maxPx: 120, minPx: 40, maxLines: 2, weight: 800, tracking: -0.03 });
  assert.ok(fit.lines.length <= 2);
  assert.equal(fit.lines.join(" "), texto, "todas las palabras, enteras, en orden");
  for (const l of fit.lines) assert.ok(anchoTexto(l, fit.px, { weight: 800, tracking: -0.03 }) <= 900, `linea demasiado ancha: ${l}`);
  // Una palabra larguisima obliga a bajar el cuerpo, no a romperla.
  const largo = ajustarTexto("supercalifragilisticoespialidoso", { maxWidth: 400, maxPx: 120, minPx: 12, maxLines: 1, weight: 800 });
  assert.equal(largo.lines.length, 1);
  assert.ok(largo.px < 60);
});

test("cada layout rinde, en cada lienzo y en las dos marcas, un HTML con el contrato del render", () => {
  for (const id of LAYOUT_IDS) {
    for (const [width, height] of LIENZOS) {
      for (const brand of [OSCURA, CLARA]) {
        for (const register of ["dark", "light"]) {
          const html = renderLayout(id, {
            brand,
            width,
            height,
            scene: { compId: `03-${id}`, index: 2, hold: 5, duration: 5.4 },
            total: 6,
            slots: { ...sampleSlots(id), register },
            vertical: pantallaCompleta(width, height),
          });
          const ctx = `${id} ${width}x${height} ${brand.name}/${register}`;
          assert.match(html, /^<!doctype html>\n<template>/, ctx);
          assert.match(html, /<style>\n\s+\/\* @@BCA_FONTS@@ \*\//, `${ctx}: el marcador de fuentes es la primera linea del style`);
          assert.match(html, new RegExp(`data-composition-id="03-${id}" data-start="0" data-duration="5.4"`), ctx);
          assert.match(html, new RegExp(`data-width="${width}" data-height="${height}"`), ctx);
          assert.match(html, /class="clip s03-[\w-]+-ground" data-start="0" data-duration="5.4" data-track-index="0"/, `${ctx}: la tierra va en una capa clip`);
          assert.match(html, /gsap\.timeline\(\{ paused: true \}\)/, ctx);
          assert.match(html, new RegExp(`window\\.__timelines\\["03-${id}"\\] = tl;`), ctx);
          assert.doesNotMatch(html, /repeat:|yoyo:|Math\.random|Date\.now|@keyframes|letterSpacing|fontSize/, `${ctx}: nada que desincronice el capture`);
          assert.match(html, /gsap\.set\(/, `${ctx}: estados iniciales con set inmediato`);
          assert.match(html, /tl\.fromTo\(/, ctx);
          // El elemento vivo durante el hold: la regla del pie crece.
          assert.match(html, /-rule", \{ scaleX: 0 \}, \{ scaleX: 1/, `${ctx}: algo cambia de geometria durante todo el hold`);
          // Los ids no empiezan con digito (un selector #03-... no es CSS valido).
          for (const m of html.matchAll(/(?<![\w-])id="([^"]+)"/g)) assert.doesNotMatch(m[1], /^\d/, `${ctx}: id ${m[1]}`);
          // Colores: solo los de la marca (o derivados de ellos), ninguno propio del layout.
          const ajenos = brand === CLARA ? /#C4EF3D|#0C0F08/i : /#C2273F|#FAF7F5/i;
          assert.doesNotMatch(html, ajenos, `${ctx}: colores de la otra marca`);
          assert.match(html, new RegExp(brand.fonts.display.family), ctx);
          assert.match(html, new RegExp(brand.fonts.mono.family), ctx);
        }
      }
    }
  }
});

test("el display sale en lineas explicitas, cada palabra entera, y el acento envuelve la palabra pedida", () => {
  const html = renderLayout("hero", {
    brand: OSCURA,
    width: 1080,
    height: 1350,
    scene: { compId: "01-hero", index: 0, hold: 3, duration: 3 },
    total: 6,
    slots: { display: "otro proveedor, otra factura, otra doc", accent_word: "factura", register: "dark" },
  });
  const bloque = /<div id="s01-hero-display"[^>]*>(.*?)<\/div>/s.exec(html)[1];
  const lineas = bloque
    .split(/<span id="s01-hero-display-l\d" class="line" data-layout-allow-overlap>/)
    .slice(1)
    .map((x) => x.replace(/<\/span>$/, ""));
  assert.ok(lineas.length >= 2 && lineas.length <= 3);
  assert.equal(lineas.join(" ").replace(/<[^>]+>/g, ""), "otro proveedor, otra factura, otra doc");
  assert.ok(lineas.some((l) => l.includes('<span class="hot">factura</span>')), "el acento envuelve la palabra");
  // El acento no distingue mayusculas y solo toma palabras enteras.
  const html2 = renderLayout("hero", {
    brand: OSCURA,
    width: 1080,
    height: 1080,
    scene: { compId: "01-x", index: 0, hold: 4, duration: 4 },
    total: 1,
    slots: { display: "Sin tarjeta, sin factura", accent_word: "sin tarjeta" },
  });
  assert.match(html2, /<span class="hot">Sin tarjeta<\/span>/);
});

test("pantalla completa: la caja util respeta el safe area de la app solo en 9:16", () => {
  assert.equal(pantallaCompleta(1080, 1920), true);
  assert.equal(pantallaCompleta(1080, 1350), false, "un 4:5 de feed no lo tapa ninguna app");
  assert.equal(pantallaCompleta(1920, 1080), false);
  const story = renderLayout("hero", {
    brand: CLARA,
    width: 1080,
    height: 1920,
    scene: { compId: "01-s", index: 0, hold: 4, duration: 4 },
    total: 1,
    slots: sampleSlots("hero"),
    vertical: true,
  });
  const kickerTop = Number(/-kicker \{ position:absolute; left:\d+px; top:(\d+)px/.exec(story)[1]);
  assert.ok(kickerTop >= 1920 * 0.14, `el kicker arranca debajo del 14% (${kickerTop})`);
  const footTop = Number(/-foot \{ position:absolute; left:\d+px; right:\d+px; top:(\d+)px/.exec(story)[1]);
  assert.ok(footTop <= 1920 * 0.8, `el pie termina antes del 80% (${footTop})`);
});

test("validateSlots exige lo que rompe el layout y tolera lo que solo se recorta", () => {
  assert.deepEqual(validateSlots("hero", { display: "hola" }), []);
  assert.match(validateSlots("hero", {}).join(), /falta display/);
  assert.match(validateSlots("stat", { display: "x" }).join(), /stat\.value vacio/);
  assert.match(validateSlots("split", { display: "x", rows: [{ label: "a", value: "b" }] }).join(), /rows debe tener entre 2 y 4/);
  assert.match(validateSlots("cues", { display: "x", cues: ["a", "b", "c", "d", "e"] }).join(), /cues debe tener entre 2 y 4/);
  assert.match(validateSlots("cta", { display: "x" }).join(), /cta\.line vacio/);
  assert.match(validateSlots("nada", { display: "x" }).join(), /layout desconocido/);
  assert.match(validateSlots("hero", { display: "x", register: "azul" }).join(), /register/);
  // un kicker largo no es motivo de rechazo: se recorta al renderizar
  assert.deepEqual(validateSlots("hero", { display: "x", kicker: "K".repeat(60) }), []);
});

test("el catalogo lista todos los layouts con cuando usarlos y sus huecos", () => {
  const cat = layoutCatalog();
  for (const id of LAYOUT_IDS) assert.match(cat, new RegExp(`^- ${id}: `, "m"));
  assert.match(cat, /slots: kicker\?, display, accent_word\?, support\?/);
});
