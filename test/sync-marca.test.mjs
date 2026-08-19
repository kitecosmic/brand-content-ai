// Sincronizar las fuentes de una marca, de punta a punta.
//
// Es el paso que separa "tengo una marca" de "puedo generar": sin hechos
// sincronizados, generar se niega — todo lo que se publica tiene que salir de
// una fuente. Como el flujo entero no estaba probado, un fallo ahi solo aparecia
// al apretar el boton, igual que paso con `proposeIdentity`.
//
// El sitio y el modelo entran por `deps`, asi que esto no toca la red.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/lib/store.mjs";
import { syncAll } from "../src/lib/knowledge.mjs";

let root;
let store;
let cfg;

const SITIO = {
  url: "https://keio.example/",
  host: "keio.example",
  title: "Keio",
  text: "Keio activa tu linea en cinco minutos. ".repeat(40),
  pages: [{ url: "https://keio.example/" }, { url: "https://keio.example/precios" }],
};

const RESPUESTA = {
  digest: "Keio vende eSIM: se activa en cinco minutos desde el celular, sin ir a un local.",
  // El prompt pide `claim`, no `text`: un hecho sin claim se descarta.
  facts: [
    { claim: "La linea queda activa en cinco minutos", source: "https://keio.example/" },
    { claim: "No hace falta ir a un local", source: "https://keio.example/precios" },
  ],
};

function depsFalsas({ llamadas = [], respuesta = RESPUESTA } = {}) {
  return {
    readSite: async () => SITIO,
    runModeloJSON: async (prompt, opts) => {
      llamadas.push({ prompt, opts });
      return { data: respuesta, costUsd: 0.004, ms: 700, model: opts?.model ?? "stub" };
    },
  };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "bca-sync-"));
  store = openStore(join(root, "data", "brand-content-ai.db"));
  cfg = { models: { digest: "modelo-digest" }, limits: { modelTimeoutMs: 1000 }, repos: [] };

  store.upsertBrand({ id: "keio", name: "Keio", palette: {}, languages: ["es"] });
  store.addSource({
    brandId: "keio",
    sourceId: "keio:site",
    kind: "url",
    ref: SITIO.url,
    label: SITIO.host,
  });
});

after(() => {
  try {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

test("sincronizar deja los hechos citables de la marca", async () => {
  const llamadas = [];
  const r = await syncAll(cfg, store, { brandId: "keio", deps: depsFalsas({ llamadas }) });

  assert.equal(r.length, 1, "se sincronizo la unica fuente de la marca");
  assert.ok(!r[0].error, `no tendria que fallar: ${r[0].error ?? ""}`);
  assert.equal(llamadas[0].opts.model, "modelo-digest", "el digest usa su propio modelo");

  const fuentes = store.allKnowledge("keio").filter((f) => f.digest);
  assert.equal(fuentes.length, 1, "la fuente quedo con digest: es lo que generate exige");
  assert.match(fuentes[0].digest, /eSIM/);
  assert.equal(fuentes[0].facts.length, 2, "y con sus hechos citables");
  assert.match(fuentes[0].facts[0].source, /keio\.example/, "cada hecho dice de donde salio");
  assert.match(fuentes[0].facts[0].claim, /cinco minutos/);
});

test("volver a sincronizar sin cambios no vuelve a pagarle al modelo", async () => {
  const llamadas = [];
  const r = await syncAll(cfg, store, { brandId: "keio", deps: depsFalsas({ llamadas }) });

  assert.equal(llamadas.length, 0, "el sitio no cambio: se reusa el digest");
  assert.equal(r[0].skipped, true);
});

test("una fuente que falla no deja la marca sin lo que ya tenia", async () => {
  const r = await syncAll(cfg, store, {
    brandId: "keio",
    force: true,
    deps: {
      readSite: async () => {
        throw new Error("el sitio no responde");
      },
    },
  });

  assert.match(r[0].error ?? "", /no responde/, "el motivo real vuelve para poder mostrarlo");
  const fuentes = store.allKnowledge("keio").filter((f) => f.digest);
  assert.equal(fuentes.length, 1, "lo sincronizado antes sigue estando");
});
