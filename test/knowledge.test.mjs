// Tests de knowledge.mjs — todo lo que se puede probar sin gastar en el modelo:
// el recorte de contexto, el filtro de hechos, los repos rotos y el skip por sha.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Antes de importar el modulo: si algun test llamara al modelo por error, que
// falle al instante en vez de gastar plata. modelo.mjs valida la api key al
// armar la peticion, asi que un valor sentinel la hace reventar sin gastar.
process.env.BCA_MINIMAX_API_KEY = "bca-test-sin-llamadas";

const { syncRepo, syncAll, knowledgeContext, sanitizeFacts, collectRepoFiles, matchesGlob } = await import(
  "../src/lib/knowledge.mjs"
);
const { openStore } = await import("../src/lib/store.mjs");

let tmp;
let stores = [];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "bca-knowledge-"));
});

after(() => {
  for (const s of stores) {
    try {
      s.close();
    } catch {
      /* ya cerrado */
    }
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

function newStore(name) {
  const s = openStore(join(tmp, name, "brand-content-ai.db"));
  stores.push(s);
  return s;
}

/** Repo git de verdad, con un commit, para poder leerle el HEAD. */
function makeGitRepo(name, files = { "README.md": "# temp\n" }) {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  const git = (args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["init", "-q"]);
  git(["config", "user.email", "test@bca.local"]);
  git(["config", "user.name", "bca test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return { dir, sha: git(["rev-parse", "HEAD"]).trim() };
}

// ---------------------------------------------------------------------------
/** Alta de conocimiento ya digerido, para no depender del modelo en los tests. */
function put(store, id, digest, facts = [], { fingerprint = "a".repeat(40), brandId = "marca" } = {}) {
  return store.putKnowledge({
    sourceId: id,
    brandId,
    kind: "repo",
    ref: `/repos/${id}`,
    label: id,
    fingerprint,
    digest,
    facts,
  });
}

// knowledgeContext
// ---------------------------------------------------------------------------

test("knowledgeContext: sin conocimiento devuelve string vacio", () => {
  const store = newStore("ctx-vacio");
  assert.equal(knowledgeContext(store), "");
});

test("knowledgeContext: trae el digest y los hechos con su fuente", () => {
  const store = newStore("ctx-basico");
  put(store, "nubex", "## What it is\nBaaS en Go.", [
    { claim: "Corre sobre Postgres 16", source: "docker-compose.yml" },
  ]);

  const ctx = knowledgeContext(store);
  assert.match(ctx, /# nubex/);
  assert.match(ctx, /BaaS en Go/);
  assert.match(ctx, /Corre sobre Postgres 16/);
  assert.match(ctx, /docker-compose\.yml/);
});

test("knowledgeContext: respeta maxChars y no deja a un repo sin lugar", () => {
  const store = newStore("ctx-recorte");
  put(store, "repo-gordo", "GORDO\n" + "x".repeat(20_000));
  put(store, "repo-flaco", "FLACO\n" + "y".repeat(20_000));

  const max = 1200;
  const ctx = knowledgeContext(store, { maxChars: max });

  assert.ok(ctx.length <= max, `contexto de ${ctx.length} chars, maximo ${max}`);
  // Ningun repo se come el presupuesto entero.
  assert.match(ctx, /# repo-gordo/);
  assert.match(ctx, /# repo-flaco/);
  assert.match(ctx, /recortado/);
});

test("knowledgeContext: si entra completo no recorta nada", () => {
  const store = newStore("ctx-entero");
  put(store, "chico", "digest corto");
  const ctx = knowledgeContext(store, { maxChars: 5000 });
  assert.doesNotMatch(ctx, /recortado/);
  assert.match(ctx, /digest corto/);
});

// ---------------------------------------------------------------------------
// sanitizeFacts — la regla critica: sin fuente comprobable, no hay hecho
// ---------------------------------------------------------------------------

test("sanitizeFacts: solo sobrevive lo que apunta a un archivo real del repo", () => {
  const { dir } = makeGitRepo("repo-facts", {
    "README.md": "# repo\n",
    "docs/api.md": "# api\n",
  });

  const { facts, dropped } = sanitizeFacts(
    [
      { claim: "Expone 12 endpoints REST", source: "docs/api.md:3" },
      { claim: "Se instala con un binario", source: "README.md" },
      { claim: "Escala a 10 millones de usuarios" }, // sin source -> fuera
      { claim: "Soporta gRPC", source: "" }, // source vacio -> fuera
      { claim: "Tiene 99.99% de uptime", source: "docs/inventado.md" }, // no existe -> fuera
      { claim: "Algo", source: "../../../etc/passwd" }, // fuera del repo -> fuera
      { claim: "Comodines no valen", source: "docs/*.md" }, // glob -> fuera
      { claim: "expone 12 ENDPOINTS rest", source: "README.md" }, // duplicado -> fuera
      { source: "README.md" }, // sin claim -> fuera
    ],
    dir,
  );

  assert.deepEqual(
    facts.map((f) => f.claim),
    ["Expone 12 endpoints REST", "Se instala con un binario"],
  );
  assert.equal(dropped.length, 6);
});

test("sanitizeFacts: acepta rutas absolutas del repo y las vuelve relativas", () => {
  const { dir } = makeGitRepo("repo-abs", { "README.md": "# repo\n" });
  const { facts } = sanitizeFacts(
    [{ claim: "Hay un README", source: join(dir, "README.md") }],
    dir,
  );
  assert.equal(facts.length, 1);
  assert.equal(facts[0].source, "README.md");
});

test("sanitizeFacts: tolera que el modelo no devuelva facts", () => {
  assert.deepEqual(sanitizeFacts(undefined, tmp), { facts: [], dropped: [] });
  assert.deepEqual(sanitizeFacts(null, tmp), { facts: [], dropped: [] });
});

// ---------------------------------------------------------------------------
// syncRepo / syncAll
// ---------------------------------------------------------------------------

test("syncRepo: lanza si la ruta no existe en disco", async () => {
  const store = newStore("sync-inexistente");
  await assert.rejects(
    syncRepo({}, store, { id: "fantasma", path: join(tmp, "no-existe-jamas") }),
    /no existe en disco/,
  );
});

test("syncRepo: lanza si la ruta existe pero no es un repo git", async () => {
  const store = newStore("sync-nogit");
  const dir = join(tmp, "carpeta-suelta");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hola.txt"), "hola");

  await assert.rejects(
    syncRepo({}, store, { id: "suelto", path: dir }),
    /no es un repositorio git/,
  );
});

test("syncRepo: lanza si falta el id o el path", async () => {
  const store = newStore("sync-config-rota");
  await assert.rejects(syncRepo({}, store, { path: tmp }), /id es obligatorio/);
  await assert.rejects(syncRepo({}, store, { id: "x" }), /falta 'path'/);
});

test("syncRepo: saltea sin llamar al modelo cuando el sha guardado coincide", async () => {
  const store = newStore("sync-skip");
  const { dir, sha } = makeGitRepo("repo-skip");
  const digest = "## What it is\nUn repo de prueba.";
  put(store, "skippy", digest, [{ claim: "x", source: "README.md" }], { fingerprint: sha });

  const logs = [];
  const res = await syncRepo({}, store, { id: "skippy", path: dir }, { log: (m) => logs.push(m) });

  assert.equal(res.repoId, "skippy");
  assert.equal(res.headSha, sha);
  assert.equal(res.skipped, true);
  assert.equal(res.digestChars, digest.length);
  assert.equal(res.costUsd, 0);
  assert.ok(logs.some((l) => /sin cambios/.test(l)));
  // El digest guardado sigue intacto.
  assert.equal(store.getKnowledge("skippy").digest, digest);
});

test("syncRepo: sin log no imprime ni explota", async () => {
  const store = newStore("sync-sin-log");
  const { dir, sha } = makeGitRepo("repo-sin-log");
  put(store, "mudo", "digest", [], { fingerprint: sha });
  const res = await syncRepo({}, store, { id: "mudo", path: dir });
  assert.equal(res.skipped, true);
});

test("syncRepo: con el sha cambiado deja de saltear e intenta el modelo", async () => {
  const store = newStore("sync-sha-viejo");
  const { dir, sha } = makeGitRepo("repo-sha-viejo");
  put(store, "viejo", "digest anterior", [], { fingerprint: "0".repeat(40) });

  // El modelo esta apuntado a un binario inexistente: que rechace prueba que
  // NO se salteo. Y el digest anterior no se pisa ante el fallo.
  await assert.rejects(syncRepo({}, store, { id: "viejo", path: dir }));
  const saved = store.getKnowledge("viejo");
  assert.equal(saved.digest, "digest anterior");
  assert.notEqual(saved.head_sha, sha);
});

test("syncRepo: force ignora el sha coincidente", async () => {
  const store = newStore("sync-force");
  const { dir, sha } = makeGitRepo("repo-force");
  put(store, "forzado", "digest cacheado", [], { fingerprint: sha });

  await assert.rejects(syncRepo({}, store, { id: "forzado", path: dir }, { force: true }));
});

test("syncAll: un repo roto no tumba el sync de los demas", async () => {
  const store = newStore("syncall");
  const bueno = makeGitRepo("repo-bueno");
  put(store, "bueno", "digest vigente", [], { fingerprint: bueno.sha });

  const cfg = {
    repos: [
      { id: "roto", path: join(tmp, "ni-existe") },
      { id: "bueno", path: bueno.dir },
    ],
  };

  const logs = [];
  const res = await syncAll(cfg, store, { log: (m) => logs.push(m) });

  assert.equal(res.length, 2);

  const roto = res.find((r) => r.repoId === "roto");
  assert.match(roto.error, /no existe en disco/);
  assert.equal(roto.headSha, null);
  assert.equal(roto.skipped, false);
  assert.equal(roto.costUsd, 0);

  const ok = res.find((r) => r.repoId === "bueno");
  assert.equal(ok.skipped, true);
  assert.equal(ok.error, undefined);
  assert.equal(ok.headSha, bueno.sha);

  assert.ok(logs.some((l) => /FALLO/.test(l)));
  // El fallo quedo en la bitacora.
  const fallos = store.db
    .prepare(`SELECT * FROM runs WHERE kind = 'digest' AND ok = 0`)
    .all();
  assert.equal(fallos.length, 1);
  assert.match(fallos[0].detail, /roto/);
});

test("syncAll: lanza si la marca no tiene de donde sacar hechos", async () => {
  const store = newStore("syncall-vacio");
  await assert.rejects(syncAll({ repos: [] }, store), /no tiene fuentes/);
  await assert.rejects(syncAll({}, store), /no tiene fuentes/);
});

// ---------------------------------------------------------------------------
// Recoleccion de archivos para inlinear en el prompt del digest
// ---------------------------------------------------------------------------

test("matchesGlob cubre *, **, ? y match por nombre de archivo", () => {
  assert.equal(matchesGlob("README.md", "README.md"), true);
  assert.equal(matchesGlob("README.md", "*.md"), true);
  assert.equal(matchesGlob("docs/api.md", "*.md"), true);
  assert.equal(matchesGlob("docs/api.md", "**/*.md"), true);
  assert.equal(matchesGlob("a/b/c.md", "**/*.md"), true);
  assert.equal(matchesGlob("a/b/c.txt", "**/*.md"), false);
  assert.equal(matchesGlob("a/b/c.md", "a/?.md"), false); // ? no cruza separador
  assert.equal(matchesGlob("a/x.md", "a/?.md"), true);
});

test("collectRepoFiles respeta globs, salta binarios y aplica tapas", () => {
  const root = mkdtempSync(join(tmpdir(), "bca-collect-"));
  try {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# readme\n");
    writeFileSync(join(root, "docs", "a.md"), "doc a");
    writeFileSync(join(root, "docs", "b.md"), "doc b");
    writeFileSync(join(root, "main.go"), "package main");
    mkdirSync(join(root, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(root, "node_modules", "foo", "skip.md"), "no");
    writeFileSync(join(root, "binary.md"), "x\u0000y"); // binario disfrazado

    const out = collectRepoFiles(root, ["README.md", "docs/**/*.md"]);
    assert.ok(out["README.md"]);
    assert.ok(out["docs/a.md"]);
    assert.ok(out["docs/b.md"]);
    assert.equal(out["main.go"], undefined);
    assert.equal(out["node_modules/foo/skip.md"], undefined);
    assert.equal(out["binary.md"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
