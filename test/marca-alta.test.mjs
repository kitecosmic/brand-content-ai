// Crear una marca, de punta a punta.
//
// Los tests de marca cubrian cada pieza por separado —normalizePalette,
// normalizeIdentity, renderFrameMd— y ninguno recorria `createBrand` entero. Por
// eso una funcion que no existia (`proposeIdentity`, que se llamaba en dos
// lugares y no estaba escrita en ninguno) llego al servidor: cada pieza andaba,
// y el flujo que las une no lo probaba nadie. Fallaba con "proposeIdentity is
// not defined" recien al apretar el boton.
//
// El modelo, el sitio y Google Fonts entran por `deps`, asi que esto no toca la
// red: lo que se prueba es que el flujo llame lo que tiene que llamar y deje la
// marca lista.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/lib/store.mjs";
import { createBrand, reviseBrand, brandProjectDir } from "../src/lib/brand.mjs";

let root;
let store;
let cfg;

const IDENTIDAD = {
  name: "Faro",
  audience: "equipos de producto que despliegan seguido",
  voice: "directa, tecnica, sin adjetivos de folleto",
  nameUsage: "Faro, siempre con mayuscula inicial",
  never: ["experiencia sin fricciones", "revolucionario", "FARO", "faro"],
  languages: ["es"],
  languageMix: { es: 1 },
  palette: {
    bg: "#0B0D10",
    surface: "#141820",
    ink: "#EDF1F7",
    muted: "#93A0B4",
    line: "#232A35",
    accent: "#4ADE80",
    onAccent: "#05210F",
  },
  fonts: { display: { family: "Inter" }, mono: { family: "JetBrains Mono" } },
};

/** El modelo, el sitio y las fuentes, sin red. */
function depsFalsas({ identidad = IDENTIDAD, llamadas = [] } = {}) {
  return {
    runModeloJSON: async (prompt, opts) => {
      llamadas.push({ prompt, opts });
      return { data: identidad, costUsd: 0.012, ms: 900, model: opts?.model ?? "stub" };
    },
    readSite: async (url) => ({
      url,
      host: "faro.dev",
      title: "Faro",
      description: "Despliegues que se explican solos",
      text: "Faro ".repeat(200),
      colors: ["#4ADE80"],
    }),
    buildFontCss: async () => ({ css: "/* fuentes */", families: ["Inter"], bytes: 12, cached: true }),
    familyExists: async () => true,
  };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "bca-marca-"));
  store = openStore(join(root, "data", "brand-content-ai.db"));
  cfg = {
    models: { brief: "modelo-de-brief" },
    limits: { modelTimeoutMs: 1000 },
    hyperframes: { projectsDir: join(root, "projects") },
    paths: { root },
  };
});

after(() => {
  try {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

test("createBrand deja la marca lista para generar", async () => {
  const llamadas = [];
  const r = await createBrand(cfg, store, {
    url: "https://faro.dev",
    hints: "tecnica y directa",
    deps: depsFalsas({ llamadas }),
  });

  assert.equal(r.brand.id, "faro");
  assert.equal(r.brand.name, "Faro");
  assert.equal(r.brand.status, "ready", "una marca a medio hacer no sirve para generar");
  assert.equal(r.costUsd, 0.012, "el costo de la llamada vuelve para poder cobrarlo");

  // Le pidio la identidad al modelo, una sola vez y con el modelo configurado.
  assert.equal(llamadas.length, 1, "la identidad es UNA llamada");
  assert.equal(llamadas[0].opts.model, "modelo-de-brief");
  assert.match(llamadas[0].prompt, /faro\.dev|Faro/, "el prompt lleva lo que se leyo del sitio");

  // Y quedo en la base, con su proyecto en disco.
  const guardada = store.getBrand("faro");
  assert.equal(guardada.palette.accent.toLowerCase(), "#4ade80");
  const dir = brandProjectDir(cfg, "faro");
  assert.ok(existsSync(join(dir, "frame.md")), "sin frame.md el modelo no sabe componer");
  assert.match(readFileSync(join(dir, "frame.md"), "utf8"), /Faro/);

  // El costo quedo anotado como una corrida mas.
  assert.ok(
    store.costSummary(30).some((f) => f.kind === "marca"),
    "el costo de armar la marca tiene que aparecer en costos",
  );
});

test("el sitio queda como fuente de conocimiento de la marca", () => {
  const fuentes = store.allKnowledge("faro");
  assert.ok(
    fuentes.some((f) => (f.ref ?? "").includes("faro.dev")),
    "de ahi salen los hechos que el contenido puede afirmar",
  );
});

test("reviseBrand aplica el pedido y guarda la version anterior", async () => {
  const llamadas = [];
  const r = await reviseBrand(cfg, store, "faro", "el acento en violeta", {
    deps: depsFalsas({
      llamadas,
      identidad: { ...IDENTIDAD, palette: { ...IDENTIDAD.palette, accent: "#A78BFA" } },
    }),
  });

  assert.equal(r.brand.palette.accent.toLowerCase(), "#a78bfa");
  assert.ok(r.revision >= 1, "la vuelta anterior queda archivada");
  assert.match(llamadas[0].prompt, /violeta/, "el pedido entra en el prompt");
  assert.match(llamadas[0].prompt, /La marca hoy/, "y el modelo ve lo que hay que cambiar");

  assert.ok(store.brandRevisions("faro").length >= 1, "se puede volver atras");
});

test("una marca sin URL ni nombre no se crea", async () => {
  await assert.rejects(
    () => createBrand(cfg, store, { deps: depsFalsas() }),
    /URL o un nombre/,
    "pedir una marca de la nada es un error del que pide, y hay que decirlo",
  );
});

test("si el modelo no devuelve un objeto, se dice que fue el modelo", async () => {
  await assert.rejects(
    () =>
      createBrand(cfg, store, {
        name: "Otra",
        deps: { ...depsFalsas(), runModeloJSON: async () => ({ data: "una frase suelta", costUsd: 0 }) },
      }),
    /no devolvio una identidad/,
    "un error claro evita buscar el problema en el lugar equivocado",
  );
});
