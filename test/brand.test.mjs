// Marcas: lo que se puede probar sin llamar al modelo ni salir a internet.
//
// Lo que importa aca es que una marca mal propuesta no llegue nunca al render:
// contraste que el linter va a rechazar, paleta incompleta, familias vacias.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/lib/store.mjs";
import {
  contrast,
  ensureDefaultBrand,
  materializeBrand,
  fontsFromFrameMd,
  forzarContraste,
  mezclar,
  normalizeIdentity,
  normalizePalette,
  paletteFromFrameMd,
  renderFrameMd,
  renderReferenceComposition,
  toHex,
} from "../src/lib/brand.mjs";

const tmpRaices = [];
const stores = [];
process.on("exit", () => {
  for (const s of stores) {
    try {
      s.close();
    } catch {}
  }
  for (const r of tmpRaices) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {}
  }
});

function nuevoStore(nombre) {
  const root = mkdtempSync(join(tmpdir(), `bca-brand-${nombre}-`));
  tmpRaices.push(root);
  const s = openStore(join(root, "data", "brand-content-ai.db"));
  stores.push(s);
  return { store: s, root };
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

test("toHex normaliza lo que escriba el modelo", () => {
  assert.equal(toHex("#abc"), "#AABBCC");
  assert.equal(toHex("0C0F08"), "#0C0F08");
  assert.equal(toHex("#0c0f08"), "#0C0F08");
  assert.equal(toHex("rojo"), null);
  assert.equal(toHex(""), null);
});

test("contrast coincide con los numeros de WCAG", () => {
  assert.equal(Math.round(contrast("#FFFFFF", "#000000")), 21);
  assert.equal(Math.round(contrast("#777777", "#777777")), 1);
});

test("forzarContraste mueve el color hasta que se lee, sin cambiar de familia", () => {
  const arreglado = forzarContraste("#333333", "#111111", 4.5);
  assert.ok(contrast(arreglado, "#111111") >= 4.5, `quedo en ${contrast(arreglado, "#111111")}`);
});

test("normalizePalette rellena lo que falta y arregla el contraste", () => {
  const avisos = [];
  const p = normalizePalette({ bg: "#101014", ink: "#2A2A2A", accent: "#1B1B40" }, avisos);

  // Las siete claves existen: una composicion con "undefined" en el CSS es una
  // pieza perdida a los diez minutos de render.
  for (const k of ["bg", "surface", "ink", "muted", "hint", "line", "accent", "onAccent"]) {
    assert.match(p[k] ?? "", /^#[0-9A-F]{6}$/, `falta ${k}`);
  }
  assert.ok(contrast(p.ink, p.bg) >= 4.5, "el texto tiene que leerse sobre el fondo");
  assert.ok(contrast(p.accent, p.bg) >= 3, "el acento tiene que verse");
  assert.ok(contrast(p.onAccent, p.accent) >= 4.5, "lo que va arriba del acento tiene que leerse");
  assert.equal(avisos.length, 2, "avisa lo que toco");
});

test("mezclar interpola entre dos colores", () => {
  assert.equal(mezclar("#000000", "#FFFFFF", 0), "#000000");
  assert.equal(mezclar("#000000", "#FFFFFF", 1), "#FFFFFF");
  assert.equal(mezclar("#000000", "#FFFFFF", 0.5), "#808080");
});

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

test("normalizeIdentity sobrevive a una respuesta pobre del modelo", () => {
  const b = normalizeIdentity({ name: "Mi Marca" }, { id: "mi-marca" });
  assert.equal(b.id, "mi-marca");
  assert.equal(b.name, "Mi Marca");
  assert.deepEqual(b.languages, ["en"]);
  assert.deepEqual(b.languageMix, { en: 1 });
  assert.ok(b.fonts.display.family, "siempre hay una familia de display");
  assert.ok(b.fonts.mono.family, "siempre hay una mono");
  assert.match(b.palette.bg, /^#[0-9A-F]{6}$/);
});

test("normalizeIdentity conserva lo anterior cuando la revision solo toca una cosa", () => {
  const antes = normalizeIdentity(
    {
      name: "Marca",
      audience: "gente de infra",
      voice: "seca",
      never: ["revolucionario"],
      languages: ["es", "en"],
      palette: { bg: "#0A0A0A", ink: "#EDEDED", accent: "#FF5C00" },
      fonts: { display: { family: "Space Grotesk" }, mono: { family: "IBM Plex Mono" } },
    },
    { id: "marca" },
  );
  const despues = normalizeIdentity({ palette: { ...antes.palette, accent: "#3AC0FF" } }, { id: "marca", previous: antes });

  assert.equal(despues.audience, "gente de infra", "no se pierde lo que no se toco");
  assert.equal(despues.fonts.display.family, "Space Grotesk");
  assert.equal(despues.palette.accent, "#3AC0FF", "y si se aplica lo que cambio");
});

test("normalizeIdentity limpia el languageMix de idiomas que no estan", () => {
  const b = normalizeIdentity(
    { name: "x", languages: ["es"], languageMix: { es: 3, en: 2, pt: 1 } },
    { id: "x" },
  );
  assert.deepEqual(b.languageMix, { es: 3 });
});

// ---------------------------------------------------------------------------
// Lo que lee el modelo al componer
// ---------------------------------------------------------------------------

test("renderFrameMd escribe un sistema de diseno con la paleta de la marca", () => {
  const b = normalizeIdentity(
    {
      name: "Caddy",
      voice: "tecnica",
      never: ["revolucionario"],
      palette: { bg: "#090A11", ink: "#F5F6F7", accent: "#36CEFF" },
      fonts: { display: { family: "Inter" }, mono: { family: "JetBrains Mono" } },
    },
    { id: "caddy" },
  );
  const md = renderFrameMd(b);

  assert.match(md, /^---/, "tiene frontmatter, que es lo que el prompt declara normativo");
  assert.match(md, /colors:/);
  assert.match(md, /#090A11/);
  assert.match(md, /#36CEFF/);
  assert.match(md, /display-family: "Inter"/);
  assert.match(md, /mono-family: "JetBrains Mono"/);
  assert.match(md, /typography:/);
  assert.match(md, /revolucionario/, "las frases prohibidas viajan con el sistema de diseno");
});

test("renderReferenceComposition devuelve una composicion con la forma que espera el render", () => {
  const b = normalizeIdentity(
    { name: "Caddy", palette: { bg: "#090A11", ink: "#F5F6F7", accent: "#36CEFF" } },
    { id: "caddy" },
  );
  const html = renderReferenceComposition(b);

  assert.match(html, /<template>/);
  assert.match(html, /data-composition-id="ref"/);
  assert.match(html, /data-width="1080"/);
  assert.match(html, /class="clip/, "el fondo va en una capa clip, nunca en #root");
  assert.match(html, /window\.__timelines\["ref"\]/, "la timeline queda registrada");
  assert.match(html, /gsap\.timeline\(\{ paused: true \}\)/, "y pausada: el render busca por frame");
  assert.match(html, /@@BCA_FONTS@@/, "el marcador de fuentes, no base64");
  assert.doesNotMatch(html, /repeat:|yoyo:|Math\.random/, "nada de lo que desincroniza el capture");
});

// ---------------------------------------------------------------------------
// Importar una marca que vivia en la config
// ---------------------------------------------------------------------------

test("paletteFromFrameMd deduce la paleta de un frame.md escrito a mano", () => {
  const md = `---
colors:
  ink-black: "#0C0F08"
  ink-black-alt: "#121610"
  fire-orange: "#C4EF3D"
  cream: "#E8EDDF"
  border-dark: "#272E1F"
typography:
  body: { fontFamily: "Bricolage Grotesque" }
`;
  const p = paletteFromFrameMd(md);
  assert.equal(p.bg, "#0C0F08", "el mas oscuro es el fondo");
  assert.equal(p.ink, "#E8EDDF", "el mas claro es el texto");
  assert.equal(p.accent, "#C4EF3D", "el mas saturado es el acento");
});

test("fontsFromFrameMd separa display de mono", () => {
  const md = `
  body:  { fontFamily: "Bricolage Grotesque" }
  h1:    { fontFamily: "Bricolage Grotesque" }
  label: { fontFamily: "JetBrains Mono" }
`;
  const f = fontsFromFrameMd(md);
  assert.equal(f.display.family, "Bricolage Grotesque");
  assert.equal(f.mono.family, "JetBrains Mono");
});

test("una tipografia que Google Fonts no tiene se reemplaza, no se pierde", async () => {
  const { store, root } = nuevoStore("fuentes");
  store.upsertBrand({
    id: "m",
    name: "M",
    palette: { bg: "#101014", ink: "#F2F2F0", accent: "#C2273F" },
    // "Nohemi" es comercial: el modelo la propuso en una corrida real y la marca
    // quedaba sin ninguna tipografia embebida.
    fonts: { display: { family: "Nohemi" }, mono: { family: "DM Mono" } },
  });

  const pedidas = [];
  const avisos = [];
  const cfg = {
    paths: { root },
    hyperframes: { projectsDir: join(root, "videos") },
  };
  await materializeBrand(cfg, store, "m", {
    warnings: avisos,
    deps: {
      familyExists: async (f) => f !== "Nohemi",
      buildFontCss: async (familias) => {
        pedidas.push(...familias.map((f) => f.family));
        return { css: "/* fuentes */", cached: false };
      },
    },
  });

  const b = store.getBrand("m");
  assert.equal(b.fonts.display.family, "Inter", "cayo en el fallback");
  assert.equal(b.fonts.mono.family, "DM Mono", "la que existia se conserva");
  assert.deepEqual(pedidas, ["Inter", "DM Mono"], "no se intenta bajar la que no existe");
  assert.match(avisos.join(" "), /Nohemi/, "queda dicho que se cambio");
  // Y el frame.md que lee el modelo nombra la que se va a usar de verdad.
  assert.match(b.frameMd, /display-family: "Inter"/);
  assert.doesNotMatch(b.frameMd, /Nohemi/);
});

test("ensureDefaultBrand convierte la config vieja en una marca y adopta lo que ya existia", () => {
  const { store, root } = nuevoStore("bootstrap");
  const ref = join(root, "reference");
  mkdirSync(ref, { recursive: true });
  writeFileSync(join(ref, "frame.md"), `colors:\n  a: "#0C0F08"\n  b: "#E8EDDF"\n  c: "#C4EF3D"\n`);

  // Una pieza y una fuente de antes de que existieran las marcas.
  store.upsertItem({
    id: "2026-01-01-vieja",
    scheduled_for: "2026-01-01",
    format: "text",
    angle: "a",
    message: "m",
  });
  store.putKnowledge({ sourceId: "repo-viejo", brandId: "", kind: "repo", ref: "/x", digest: "d" });

  const cfg = {
    brand: { name: "Mi Marca", site: "https://x.com", never: ["revolucionario"], languages: ["es"] },
    hyperframes: { referenceProject: ref },
    repos: [{ id: "repo-viejo", path: "/x" }],
  };

  const b = ensureDefaultBrand(cfg, store, {});
  assert.equal(b.id, "mi-marca");
  assert.equal(b.isDefault, true);
  assert.equal(b.projectDir, ref, "apunta al proyecto que ya existia: nada se regenera");
  assert.equal(b.palette.bg, "#0C0F08", "la paleta sale del frame.md que ya estaba");
  assert.equal(store.listItems({ brandId: "mi-marca" }).length, 1, "adopta las piezas huerfanas");
  assert.equal(store.allKnowledge("mi-marca").length, 1, "y las fuentes");

  // Idempotente: correrlo de nuevo no crea una segunda marca.
  const otra = ensureDefaultBrand(cfg, store, {});
  assert.equal(otra.id, "mi-marca");
  assert.equal(store.listBrands().length, 1);
});

// ---------------------------------------------------------------------------
// Store de marcas
// ---------------------------------------------------------------------------

test("el store guarda y devuelve una marca con sus campos compuestos", () => {
  const { store } = nuevoStore("store");
  store.upsertBrand({
    id: "m",
    name: "M",
    never: ["a", "b"],
    languages: ["es", "en"],
    languageMix: { es: 2, en: 1 },
    palette: { bg: "#000000", accent: "#FF0000" },
    fonts: { display: { family: "Inter" } },
  });
  const b = store.getBrand("m");
  assert.deepEqual(b.never, ["a", "b"]);
  assert.deepEqual(b.languageMix, { es: 2, en: 1 });
  assert.equal(b.palette.accent, "#FF0000");
  assert.equal(b.fonts.display.family, "Inter");
});

test("una revision de marca guarda lo anterior y sube el numero", () => {
  const { store } = nuevoStore("rev");
  store.upsertBrand({ id: "m", name: "M", palette: { bg: "#000000" } });
  const r1 = store.saveBrandRevision("m", { feedback: "mas oscuro" });
  store.upsertBrand({ id: "m", palette: { bg: "#111111" } });

  assert.equal(r1, 1);
  assert.equal(store.getBrand("m").revision, 1);
  const historial = store.brandRevisions("m");
  assert.equal(historial.length, 1);
  assert.equal(historial[0].feedback, "mas oscuro");
  assert.match(historial[0].palette, /#000000/, "la revision guarda el estado ANTERIOR");
});

test("borrar una marca no borra el contenido que ya se genero", () => {
  const { store } = nuevoStore("borrar");
  store.upsertBrand({ id: "m", name: "M" });
  store.upsertItem({
    id: "i",
    scheduled_for: "2026-01-01",
    format: "text",
    angle: "a",
    message: "m",
    brandId: "m",
  });
  store.deleteBrand("m");

  assert.equal(store.getBrand("m"), null);
  assert.ok(store.getItem("i"), "la pieza sigue estando");
  assert.equal(store.getItem("i").brand_id, null, "solo se queda sin marca");
});

test("listItems filtra por marca: dos marcas no se ven el calendario", () => {
  const { store } = nuevoStore("aislado");
  store.upsertBrand({ id: "a", name: "A" });
  store.upsertBrand({ id: "b", name: "B" });
  for (const m of ["a", "b"]) {
    store.upsertItem({
      id: `pieza-${m}`,
      scheduled_for: "2026-01-01",
      format: "text",
      angle: "x",
      message: "y",
      brandId: m,
    });
  }
  assert.deepEqual(store.listItems({ brandId: "a" }).map((i) => i.id), ["pieza-a"]);
  assert.deepEqual(store.listItems({ brandId: "b" }).map((i) => i.id), ["pieza-b"]);
  assert.equal(store.listItems({}).length, 2, "sin marca se ven todas");
});
