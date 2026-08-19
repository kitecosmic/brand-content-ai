// Tests de generate.mjs.
//
// Nada de esto llama al modelo ni abre un Chrome: las dependencias caras
// (runClaude, runClaudeJSON, el CLI de hyperframes, ffmpeg) se inyectan.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openStore } from "../src/lib/store.mjs";
import {
  buildBriefPrompt,
  buildRepairPrompt,
  carouselSlidePaths,
  checkPassed,
  distributeDurations,
  extractCompositions,
  extractGsapTag,
  gatherContextFiles,
  generateItem,
  generatePending,
  generateWithRetry,
  RETRIABLE_PHASES,
  knowledgeBlock,
  mapLimit,
  parseAspect,
  parseBrief,
  planScenes,
  renderIndexHtml,
  renderPostMarkdown,
  rescueStuck,
  requireKnowledge,
  resolveFfmpeg,
  summarizeCheck,
  validateFormat,
  SCENE_OVERLAP,
} from "../src/lib/generate.mjs";

const REAL_CONFIG = JSON.parse(readFileSync(new URL("../brand-content-ai.config.json", import.meta.url), "utf8"));

const GSAP_TAG =
  '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js" integrity="sha384-xxx" crossorigin="anonymous"></script>';

const tmpRoots = [];
const openStores = [];

test.after(() => {
  // Windows no borra un .db con el handle abierto (y sqlite deja -wal/-shm).
  for (const s of openStores) {
    try {
      s.close();
    } catch {
      /* ya cerrado */
    }
  }
  for (const d of tmpRoots) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* la limpieza del tmpdir no es motivo para fallar la suite */
    }
  }
});

/** Entorno aislado: config real (formatos/limites de verdad) sobre un tmpdir. */
function makeEnv({ withKnowledge = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bca-gen-"));
  tmpRoots.push(root);

  const reference = join(root, "reference-project");
  mkdirSync(join(reference, "assets", "fonts"), { recursive: true });
  mkdirSync(join(reference, "compositions", "frames"), { recursive: true });
  writeFileSync(join(reference, "frame.md"), "---\ncolors:\n  ink-black: \"#0C0F08\"\n---\n# frame\n");
  writeFileSync(join(reference, "hyperframes.json"), JSON.stringify({ paths: { blocks: "compositions" } }));
  writeFileSync(join(reference, "assets", "fonts", "bricolage.css"), "@font-face{font-family:'Bricolage Grotesque';}");
  writeFileSync(join(reference, "index.html"), `<!doctype html><html><head>${GSAP_TAG}</head><body></body></html>`);
  writeFileSync(join(reference, "compositions", "frames", "02-name.html"), "<template></template>");

  const cfg = {
    ...REAL_CONFIG,
    paths: {
      root,
      db: join(root, "data", "brand-content-ai.db"),
      knowledge: join(root, "knowledge"),
      content: join(root, "content"),
      templates: join(root, "templates"),
    },
    hyperframes: {
      projectsDir: join(root, "videos"),
      referenceProject: reference,
      cliVersion: "0.7.109",
    },
  };

  const store = openStore(cfg.paths.db);
  openStores.push(store);

  // Toda pieza pertenece a una marca. La de prueba usa el proyecto de
  // referencia de este entorno como proyecto base.
  const brand = store.upsertBrand({
    id: "nubex",
    name: "Nubex",
    site: "https://nubex.dev",
    audience: "developers",
    voice: "tecnica y directa",
    never: ["revolucionario"],
    languages: ["en", "es"],
    languageMix: { en: 2, es: 3 },
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
    fonts: { display: { family: "Bricolage Grotesque" }, mono: { family: "JetBrains Mono" } },
    projectDir: reference,
    status: "ready",
    isDefault: 1,
  });
  store.setDefaultBrand("nubex");

  if (withKnowledge) {
    store.putKnowledge({
      sourceId: "nubex:repo",
      brandId: "nubex",
      kind: "repo",
      ref: "/repos/nubex",
      label: "nubex",
      fingerprint: "abc1234def",
      digest: "Nubex es un BaaS open source en Go.",
      facts: [
        { claim: "Postgres con pgvector incluido", source: "README.md" },
        { claim: "auth, storage, realtime, functions y MCP en un solo binario", source: "docs/overview.md" },
      ],
    });
  }
  return { root, cfg, store, reference, brand };
}

function addItem(store, patch = {}) {
  const item = store.upsertItem({
    id: patch.id ?? "2026-08-20-agent-ships-the-backend",
    scheduled_for: patch.scheduled_for ?? "2026-08-20",
    format: patch.format ?? "text",
    language: patch.language ?? "en",
    angle: patch.angle ?? "the agent ships the backend",
    message: patch.message ?? "Your agent can provision a real Postgres stack",
    status: "planned",
    brandId: patch.brandId ?? "nubex",
  });
  if (patch.feedback) store.setStatus(item.id, "planned", { feedback: patch.feedback });
  return store.getItem(item.id);
}

/** Espia los cambios de estado para poder afirmar que nada queda en `building`. */
function spyStatuses(store) {
  const seen = [];
  const original = store.setStatus.bind(store);
  store.setStatus = (id, status, patch) => {
    seen.push(status);
    return original(id, status, patch);
  };
  return seen;
}

const TEXT_BRIEF = {
  headline: "Your agent can ship the backend",
  body: "Your agent can ship the backend.\n\nNubex gives it Postgres with pgvector, auth, storage, realtime and functions in one binary.",
  hashtags: ["postgres", "agents"],
  facts_used: ["Postgres con pgvector incluido"],
};

const IMAGE_BRIEF = {
  concept: "one line on an ink-black field",
  register: "dark",
  kicker: "ONE BINARY",
  display_line: "your agent ships the backend",
  support_line: "postgres, auth, storage, realtime, functions",
  accent_word: "backend",
  caption: "One binary. Real Postgres.",
  facts_used: ["Postgres con pgvector incluido"],
};

function carouselBrief(n) {
  return {
    concept: "the arc",
    slides: Array.from({ length: n }, (_, i) => ({
      n: i + 1,
      role: `slide role ${i + 1}`,
      register: "dark",
      display_line: `line ${i + 1}`,
      support_line: `support ${i + 1}`,
      accent_word: "line",
    })),
    caption: "carousel caption",
    facts_used: ["Postgres con pgvector incluido"],
  };
}

function videoBrief(n = 6) {
  return {
    concept: "40 seconds",
    scenes: Array.from({ length: n }, (_, i) => ({
      id: `scene-${i + 1}`,
      title: `scene ${i + 1}`,
      duration: 6,
      register: "dark",
      on_screen: [`cue ${i + 1}`],
      focal: i === 2,
      note: "note",
    })),
    preview_at_seconds: 12,
    caption: "video caption",
    facts_used: ["Postgres con pgvector incluido"],
  };
}

/** Stub de runClaude que finge ser el modelo: emite los HTML en fences.
 *  El wrapper real espera ```html\n<relpath>\n<body>\n```, uno por archivo.
 */
function composerStub(calls) {
  return async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    const files = new Set();
    for (const m of prompt.matchAll(/file:\s*(compositions\/frames\/[\w.-]+\.html)/g)) {
      files.add(m[1]);
    }
    const body = [...files]
      .map((f) => ["```html", f, "<template></template>", "```"].join("\n"))
      .join("\n\n");
    return { text: body, costUsd: 0.02, ms: 10, model: "stub", sessionId: "s" };
  };
}

// ---------------------------------------------------------------------------
// Validacion de formatos
// ---------------------------------------------------------------------------

test("validateFormat acepta los formatos habilitados y rechaza el resto", () => {
  const cfg = { formats: REAL_CONFIG.formats };
  for (const f of ["text", "image", "story", "carousel", "video", "reel"]) {
    assert.equal(validateFormat(cfg, f), cfg.formats[f]);
  }
  assert.throws(() => validateFormat(cfg, "podcast"), /formato desconocido/);
  assert.throws(() => validateFormat(cfg, ""), /formato desconocido/);
  assert.throws(() => validateFormat(cfg, undefined), /formato desconocido/);
  assert.throws(() => validateFormat(cfg, "VIDEO"), /formato desconocido/); // sin normalizacion silenciosa

  const off = { formats: { ...cfg.formats, video: { ...cfg.formats.video, enabled: false } } };
  assert.throws(() => validateFormat(off, "video"), /deshabilitado/);
});

test("parseAspect parsea AxB y rechaza basura", () => {
  assert.deepEqual(parseAspect("1080x1350"), { width: 1080, height: 1350 });
  assert.deepEqual(parseAspect(" 1920 X 1080 "), { width: 1920, height: 1080 });
  assert.throws(() => parseAspect("1080"), /aspect invalido/);
  assert.throws(() => parseAspect(undefined), /aspect invalido/);
});

test("generatePending descarta items con formato invalido sin tocarlos", async () => {
  const { cfg, store } = makeEnv();
  addItem(store, { id: "a-ok", format: "text" });
  // formato invalido inyectado a mano: el planificador podria haberlo escrito antes de un cambio de config
  addItem(store, { id: "b-bad", format: "text" });
  store.db.prepare("UPDATE items SET format = 'podcast' WHERE id = 'b-bad'").run();

  const res = await generatePending(cfg, store, {
    limit: 10,
    deps: { runClaudeJSON: async () => ({ data: TEXT_BRIEF, costUsd: 0.1, ms: 1, model: "stub" }) },
  });
  assert.deepEqual(res.map((r) => r.itemId), ["a-ok"]);
  assert.equal(store.getItem("b-bad").status, "planned");
});

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

test("el feedback de un rechazo entra en el prompt del brief y se exige atenderlo", () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { feedback: "El titular suena a folleto, quiero el numero de la latencia" });
  store.bumpRevision(item.id, "El titular suena a folleto, quiero el numero de la latencia");
  const withFb = store.getItem(item.id);

  const prompt = buildBriefPrompt({
    cfg,
    item: withFb,
    formatCfg: cfg.formats.text,
    knowledge: knowledgeBlock(store),
  });

  assert.match(prompt, /El titular suena a folleto, quiero el numero de la latencia/);
  assert.match(prompt, /REJECTION FEEDBACK/);
  assert.match(prompt, /feedback_addressed/);
  assert.match(prompt, /revision 1/);
});

test("sin feedback el prompt no inventa una seccion de rechazo", () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store);
  const prompt = buildBriefPrompt({
    cfg,
    item,
    formatCfg: cfg.formats.text,
    knowledge: knowledgeBlock(store),
  });
  assert.doesNotMatch(prompt, /REJECTION FEEDBACK/);
});

test("generateItem manda el feedback al modelo, no solo lo guarda", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "text" });
  store.bumpRevision(item.id, "menos adjetivos, mas numeros verificables");

  const prompts = [];
  const res = await generateItem(cfg, store, item.id, {
    deps: {
      runClaudeJSON: async (prompt) => {
        prompts.push(prompt);
        return {
          data: { ...TEXT_BRIEF, feedback_addressed: "Saque los adjetivos y puse el hecho de pgvector citado del README." },
          costUsd: 0.12,
          ms: 5,
          model: "stub",
        };
      },
    },
  });

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /menos adjetivos, mas numeros verificables/);
  assert.equal(store.getItem(item.id).status, "built");
  assert.ok(existsSync(res.assetPath));
  assert.match(readFileSync(res.assetPath, "utf8"), /revision: 1/);
});

test("parseBrief exige feedback_addressed cuando hubo rechazo", () => {
  const item = { id: "x", format: "text", language: "en", feedback: "no me gusto", revision: 1 };
  const formatCfg = REAL_CONFIG.formats.text;
  assert.throws(() => parseBrief(TEXT_BRIEF, { item, formatCfg }), /feedback_addressed/);
  assert.throws(
    () => parseBrief({ ...TEXT_BRIEF, feedback_addressed: "listo" }, { item, formatCfg }),
    /feedback_addressed/,
  );
  const ok = parseBrief(
    { ...TEXT_BRIEF, feedback_addressed: "Reescribi el titular con el numero de pgvector en vez del adjetivo." },
    { item, formatCfg },
  );
  assert.ok(ok.feedback_addressed.length > 20);
});

// ---------------------------------------------------------------------------
// Validacion del brief
// ---------------------------------------------------------------------------

test("parseBrief valida por formato", () => {
  const base = { id: "x", language: "en", revision: 0 };

  // text: el cap de caracteres es duro
  assert.throws(
    () =>
      parseBrief(
        { ...TEXT_BRIEF, body: "x".repeat(REAL_CONFIG.formats.text.maxChars + 1) },
        { item: { ...base, format: "text" }, formatCfg: REAL_CONFIG.formats.text },
      ),
    /maximo es 600/,
  );

  // todo hecho tiene que salir del knowledge
  assert.throws(
    () =>
      parseBrief({ ...TEXT_BRIEF, facts_used: [] }, { item: { ...base, format: "text" }, formatCfg: REAL_CONFIG.formats.text }),
    /facts_used/,
  );

  // carousel: exactamente N slides
  assert.throws(
    () => parseBrief(carouselBrief(4), { item: { ...base, format: "carousel" }, formatCfg: REAL_CONFIG.formats.carousel }),
    /exactamente 6 slides/,
  );
  const car = parseBrief(carouselBrief(6), {
    item: { ...base, format: "carousel" },
    formatCfg: REAL_CONFIG.formats.carousel,
  });
  assert.equal(car.slides.length, 6);

  // video: escenas mudas no sirven, los cues son el reloj
  const mute = videoBrief(5);
  mute.scenes[1].on_screen = [];
  assert.throws(
    () => parseBrief(mute, { item: { ...base, format: "video" }, formatCfg: REAL_CONFIG.formats.video }),
    /on_screen/,
  );

  // image: sin display_line no hay imagen
  assert.throws(
    () =>
      parseBrief({ ...IMAGE_BRIEF, display_line: "" }, { item: { ...base, format: "image" }, formatCfg: REAL_CONFIG.formats.image }),
    /display_line/,
  );

  assert.throws(() => parseBrief("no soy json", { item: { ...base, format: "text" }, formatCfg: {} }), /objeto JSON/);
});

test("requireKnowledge frena la generacion si no hay nada verificable que decir", () => {
  const { store } = makeEnv({ withKnowledge: false });
  assert.throws(() => requireKnowledge(store), /no hay conocimiento sincronizado/);
});

test("knowledgeBlock trae digest y hechos citables", () => {
  const { store } = makeEnv();
  const block = knowledgeBlock(store);
  assert.match(block, /nubex/);
  assert.match(block, /@abc1234/);
  assert.match(block, /pgvector/);
  assert.match(block, /\[README\.md\]/);
});

// ---------------------------------------------------------------------------
// Layout temporal
// ---------------------------------------------------------------------------

test("planScenes: carrusel secuencial, un slide por escena", () => {
  const plan = planScenes({
    format: "carousel",
    formatCfg: REAL_CONFIG.formats.carousel,
    brief: carouselBrief(6),
    itemId: "id",
  });
  assert.equal(plan.scenes.length, 6);
  assert.equal(plan.width, 1080);
  assert.equal(plan.height, 1350);
  assert.deepEqual(plan.scenes.map((s) => s.start), [0, 3, 6, 9, 12, 15]);
  assert.ok(plan.scenes.every((s) => s.trackIndex === 0)); // sin solapes, sin colision de tracks
  assert.ok(plan.scenes.every((s) => s.snapshotAt > s.start && s.snapshotAt < s.start + s.duration));
  assert.equal(new Set(plan.scenes.map((s) => s.compId)).size, 6); // ids unicos
});

test("planScenes: video suma exactamente lengthSeconds y alterna tracks por el solape", () => {
  const plan = planScenes({
    format: "video",
    formatCfg: REAL_CONFIG.formats.video,
    brief: videoBrief(6),
    itemId: "id",
  });
  assert.equal(plan.total, REAL_CONFIG.formats.video.lengthSeconds);
  const last = plan.scenes.at(-1);
  assert.equal(Number((last.start + last.hold).toFixed(3)), plan.total);
  assert.deepEqual(plan.scenes.map((s) => s.trackIndex), [0, 1, 0, 1, 0, 1]);
  // cada escena, salvo la ultima, dura su contenido + el cross-dissolve
  for (const s of plan.scenes.slice(0, -1)) {
    assert.equal(Number((s.duration - s.hold).toFixed(3)), SCENE_OVERLAP);
  }
  assert.equal(last.duration, last.hold);
});

test("planScenes: imagen es una sola escena", () => {
  const plan = planScenes({
    format: "image",
    formatCfg: REAL_CONFIG.formats.image,
    brief: IMAGE_BRIEF,
    itemId: "id",
  });
  assert.equal(plan.scenes.length, 1);
  assert.equal(plan.width, 1080);
  assert.equal(plan.height, 1080);
});

test("distributeDurations reparte sin perder ni ganar segundos", () => {
  const d = distributeDurations([3, 9, 6], 40);
  assert.equal(d.length, 3);
  assert.equal(Number(d.reduce((a, b) => a + b, 0).toFixed(3)), 40);
  assert.deepEqual(distributeDurations([], 40), []);
  const equal = distributeDurations([NaN, NaN], 10);
  assert.equal(Number(equal.reduce((a, b) => a + b, 0).toFixed(3)), 10);
});

test("renderIndexHtml respeta el contrato del renderer", () => {
  const plan = planScenes({
    format: "video",
    formatCfg: REAL_CONFIG.formats.video,
    brief: videoBrief(5),
    itemId: "id",
  });
  const html = renderIndexHtml({ id: "main", plan, gsapTag: GSAP_TAG });

  assert.match(html, /data-composition-id="main"/);
  assert.match(html, /data-start="0"/);
  assert.match(html, /data-duration="40"/);
  assert.match(html, /data-width="1920"/);
  assert.match(html, /data-height="1080"/);
  assert.match(html, /window\.__timelines\["main"\] = gsap\.timeline\(\{ paused: true \}\)/);
  assert.ok(html.includes(GSAP_TAG));

  // el fondo full-bleed nunca va en #root
  const rootRule = /#root \{[^}]*\}/.exec(html)[0];
  assert.doesNotMatch(rootRule, /background/);

  // nada de lo que rompe el seek frame a frame
  for (const forbidden of ["Math.random", "Date.now", "@keyframes", "yoyo", "repeat:", "transition:"]) {
    assert.ok(!html.includes(forbidden), `index.html no puede contener ${forbidden}`);
  }

  for (const s of plan.scenes) {
    assert.ok(html.includes(`data-composition-src="${s.file}"`));
    assert.ok(html.includes(`id="el-${s.compId}"`));
  }
});

test("extractGsapTag toma el tag del proyecto de referencia", () => {
  assert.equal(extractGsapTag(`<head>${GSAP_TAG}</head>`), GSAP_TAG);
  assert.match(extractGsapTag("<head></head>"), /gsap/); // fallback
});

// ---------------------------------------------------------------------------
// Nunca colgado en `building`
// ---------------------------------------------------------------------------

test("si falla el brief el item vuelve a planned con error y nunca pasa por building", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "text" });
  const seen = spyStatuses(store);

  await assert.rejects(
    generateItem(cfg, store, item.id, {
      deps: {
        runClaudeJSON: async () => {
          throw new Error("el modelo se cayo");
        },
      },
    }),
    /el modelo se cayo/,
  );

  const after = store.getItem(item.id);
  assert.equal(after.status, "planned");
  assert.match(after.error, /el modelo se cayo/);
  assert.equal(after.asset_path, null);
  assert.ok(!seen.includes("building"));
  assert.equal(seen.at(-1), "planned");
});

test("si el brief no valida dos veces, el item vuelve a planned con el motivo", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "carousel" });

  let calls = 0;
  await assert.rejects(
    generateItem(cfg, store, item.id, {
      deps: {
        runClaudeJSON: async () => {
          calls++;
          return { data: carouselBrief(3), costUsd: 0.1, ms: 1, model: "stub" };
        },
      },
    }),
    /no paso validacion/,
  );
  assert.equal(calls, 2); // se le da una segunda oportunidad con la queja concreta
  const after = store.getItem(item.id);
  assert.equal(after.status, "planned");
  assert.match(after.error, /exactamente 6 slides/);
});

test("si falla el render el item vuelve a planned aunque haya pasado por building", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "image" });
  const seen = spyStatuses(store);
  const composeCalls = [];
  const cliCalls = [];

  await assert.rejects(
    generateItem(cfg, store, item.id, {
      deps: {
        runClaudeJSON: async () => ({ data: IMAGE_BRIEF, costUsd: 0.1, ms: 1, model: "stub" }),
        runClaude: composerStub(composeCalls),
        hyperframes: async (_cfg, _dir, args) => {
          cliCalls.push(args[0]);
          return { code: 1, stdout: '{"ok":false,"contrast":[{"code":"contrast_fail","message":"1.9:1"}]}', stderr: "" };
        },
      },
    }),
    /devuelve los mismos errores/,
  );

  const after = store.getItem(item.id);
  assert.equal(after.status, "planned");
  assert.match(after.error, /contrast_fail/);
  assert.equal(after.asset_path, null);
  assert.ok(seen.includes("building"), "tiene que haber pasado por building");
  assert.equal(seen.at(-1), "planned", "pero no puede quedarse ahi");

  // El linter devuelve SIEMPRE lo mismo, asi que la reparacion no esta
  // sirviendo: se corta en el segundo check en vez de gastar el tercero.
  // NUNCA se llega a renderizar.
  assert.deepEqual(cliCalls, ["check", "check"]);
  assert.equal(composeCalls.length, 2); // composicion + 1 parche
  assert.match(composeCalls[1].prompt, /contrast_fail/);
  assert.match(composeCalls[1].prompt, /repair attempt 1 of 2/);
});

test("check: si el linter cambia de queja, se usan las dos reparaciones", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "image" });
  const composeCalls = [];
  const cliCalls = [];
  let ronda = 0;

  await assert.rejects(
    generateItem(cfg, store, item.id, {
      deps: {
        runClaudeJSON: async () => ({ data: IMAGE_BRIEF, costUsd: 0.1, ms: 1, model: "stub" }),
        runClaude: composerStub(composeCalls),
        hyperframes: async (_cfg, _dir, args) => {
          cliCalls.push(args[0]);
          // Una queja distinta cada vez: la reparacion esta avanzando, aunque
          // todavia no llegue. Eso si merece agotar los intentos.
          ronda++;
          return {
            code: 1,
            stdout: `{"ok":false,"contrast":[{"code":"contrast_fail","message":"ronda ${ronda}"}]}`,
            stderr: "",
          };
        },
      },
    }),
    /check sigue fallando/,
  );

  assert.deepEqual(cliCalls, ["check", "check", "check"]);
  assert.equal(composeCalls.length, 3); // composicion + 2 parches
  // El segundo parche sabe que hizo el primero y que quedo sin resolver.
  assert.match(composeCalls[2].prompt, /previous attempt already did/);
  assert.match(composeCalls[2].prompt, /repair attempt 2 of 2/);
});

test("check: el parche que repite se corta sin gastar el intento que queda", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "image" });
  const composeCalls = [];

  const err = await generateItem(cfg, store, item.id, {
    deps: {
      runClaudeJSON: async () => ({ data: IMAGE_BRIEF, costUsd: 0.1, ms: 1, model: "stub" }),
      runClaude: composerStub(composeCalls),
      hyperframes: async () => ({
        code: 1,
        stdout: '{"ok":false,"contrast":[{"code":"contrast_fail","message":"1.9:1"}]}',
        stderr: "",
      }),
    },
  }).catch((e) => e);

  // La fase la marca como no reintentable: repetir el item entero costaria un
  // brief y un compose completos para llegar al mismo error.
  assert.equal(err.phase, "check-estancado");
  assert.ok(!RETRIABLE_PHASES.has(err.phase), "no se reintenta un check estancado");
});

test("rescueStuck reencola lo que quedo en building de una corrida muerta", () => {
  const { store } = makeEnv();
  const item = addItem(store);
  store.setStatus(item.id, "building");
  const ids = rescueStuck(store);
  assert.deepEqual(ids, [item.id]);
  const after = store.getItem(item.id);
  assert.equal(after.status, "planned");
  assert.match(after.error, /building/);
});

test("generateWithRetry reintenta un fallo de compose y no uno de brief", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "image" });
  const composeCalls = [];
  let intentos = 0;

  const res = await generateWithRetry(cfg, store, item.id, {
    deps: {
      runClaudeJSON: async () => ({ data: IMAGE_BRIEF, costUsd: 0.1, ms: 1, model: "stub" }),
      // El primer compose no devuelve nada parseable: falla en fase compose y
      // el segundo intento tiene que salir solo.
      runClaude: async (prompt, opts) => {
        intentos += 1;
        if (intentos === 1) return { text: "perdon, no puedo", costUsd: 0.01, ms: 1, model: "stub" };
        return composerStub(composeCalls)(prompt, opts);
      },
      hyperframes: async (_cfg, projectDir, args) => {
        if (args[0] === "check") return { code: 0, stdout: '{"ok":true}', stderr: "" };
        const outDir = join(projectDir, args[args.indexOf("-o") + 1]);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "frame-00-at-3s.png"), "png");
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });

  assert.equal(intentos, 2, "el fallo de compose se reintenta una vez");
  assert.equal(store.getItem(item.id).status, "built");
  assert.ok(existsSync(res.assetPath));

  // Un fallo de brief no se reintenta: volveria a fallar igual.
  const otro = addItem(store, { id: "otro", format: "text" });
  let briefs = 0;
  await assert.rejects(
    generateWithRetry(cfg, store, otro.id, {
      deps: {
        runClaudeJSON: async () => {
          briefs += 1;
          throw new Error("boom en el brief");
        },
      },
    }),
  );
  assert.equal(briefs, 1);
});

test("generatePending rescata lo colgado antes de empezar y un fallo no aborta el lote", async () => {
  const { cfg, store } = makeEnv();
  addItem(store, { id: "a", format: "text" });
  addItem(store, { id: "b", format: "text" });
  addItem(store, { id: "c", format: "text" });
  store.setStatus("c", "building"); // simula un proceso muerto

  const res = await generatePending(cfg, store, {
    limit: 10,
    deps: {
      runClaudeJSON: async (prompt) => {
        if (prompt.includes("id: b")) throw new Error("boom en b");
        return { data: TEXT_BRIEF, costUsd: 0.1, ms: 1, model: "stub" };
      },
    },
  });

  assert.equal(res.length, 3);
  assert.deepEqual(
    res.map((r) => [r.itemId, r.ok]),
    [["a", true], ["b", false], ["c", true]],
  );
  assert.equal(store.getItem("a").status, "built");
  assert.equal(store.getItem("b").status, "planned");
  assert.equal(store.getItem("c").status, "built");
});

test("generatePending respeta limit y maxConcurrentGenerations", async () => {
  const { cfg, store } = makeEnv();
  for (let i = 0; i < 5; i++) addItem(store, { id: `it-${i}`, format: "text" });
  cfg.limits = { ...cfg.limits, maxConcurrentGenerations: 2 };

  let live = 0;
  let peak = 0;
  const res = await generatePending(cfg, store, {
    limit: 3,
    deps: {
      runClaudeJSON: async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 15));
        live--;
        return { data: TEXT_BRIEF, costUsd: 0.1, ms: 1, model: "stub" };
      },
    },
  });

  assert.equal(res.length, 3);
  assert.ok(peak <= 2, `concurrencia observada ${peak}, maximo 2`);
  assert.equal(store.listItems({ status: "planned" }).length, 2);
});

test("generatePending salta los items que superaron maxRegenerationsPerItem", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "text" });
  cfg.limits = { ...cfg.limits, maxRegenerationsPerItem: 2 };
  for (let i = 0; i < 3; i++) store.bumpRevision(item.id, "otra vez no");

  const res = await generatePending(cfg, store, {
    limit: 10,
    deps: {
      runClaudeJSON: async () => {
        throw new Error("no deberia llamarse");
      },
    },
  });
  assert.deepEqual(res, []);
});

// ---------------------------------------------------------------------------
// Entregables
// ---------------------------------------------------------------------------

test("text: el brief es el entregable y preview_path nunca queda vacio", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "text" });

  const res = await generateItem(cfg, store, item.id, {
    deps: { runClaudeJSON: async () => ({ data: TEXT_BRIEF, costUsd: 0.11, ms: 1, model: "stub" }) },
  });

  assert.ok(res.assetPath.endsWith("post.md"));
  assert.ok(existsSync(res.assetPath));
  assert.ok(res.previewPath, "preview_path tiene que existir para que Telegram muestre algo");
  assert.equal(res.costUsd, 0.11);

  const after = store.getItem(item.id);
  assert.equal(after.status, "built");
  assert.equal(after.asset_path, res.assetPath);
  assert.equal(after.preview_path, res.previewPath);
  assert.equal(after.error, null);
  assert.equal(JSON.parse(after.brief).body, TEXT_BRIEF.body);

  const md = readFileSync(res.assetPath, "utf8");
  assert.match(md, /#postgres #agents/);
  assert.match(md, /facts_used/);
});

test("carousel: un PNG por slide, preview en el primero", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "carousel" });
  const brief = carouselBrief(REAL_CONFIG.formats.carousel.slides);
  const composeCalls = [];
  const cliCalls = [];

  const res = await generateItem(cfg, store, item.id, {
    deps: {
      runClaudeJSON: async () => ({ data: brief, costUsd: 0.1, ms: 1, model: "stub" }),
      runClaude: composerStub(composeCalls),
      hyperframes: async (_cfg, projectDir, args) => {
        cliCalls.push(args[0]);
        if (args[0] === "check") return { code: 0, stdout: '{"ok":true}', stderr: "" };
        // snapshot: escribe un PNG por timestamp pedido, como hace el CLI real
        const outDir = join(projectDir, args[args.indexOf("-o") + 1]);
        mkdirSync(outDir, { recursive: true });
        const times = args[args.indexOf("--at") + 1].split(",");
        times.forEach((t, i) => writeFileSync(join(outDir, `frame-0${i}-at-${t}s.png`), `png-${i}`));
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });

  assert.deepEqual(cliCalls, ["check", "snapshot"]); // check SIEMPRE antes de renderizar
  const slides = carouselSlidePaths(res.assetPath, 6);
  assert.equal(slides.length, 6);
  for (const p of slides) assert.ok(existsSync(p), `falta ${p}`);
  assert.equal(res.previewPath, slides[0]);
  assert.equal(store.getItem(item.id).status, "built");

  // el proyecto HyperFrames se clono del de referencia, no se regenero
  const projectDir = join(cfg.hyperframes.projectsDir, item.id);
  assert.ok(existsSync(join(projectDir, "frame.md")));
  assert.ok(existsSync(join(projectDir, "assets", "fonts", "bricolage.css")));
  assert.ok(existsSync(join(projectDir, "hyperframes.json")));
  assert.match(readFileSync(join(projectDir, "index.html"), "utf8"), /data-composition-id="main"/);
  assert.ok(existsSync(join(cfg.paths.content, item.id, "caption.md")));
});

test("video: MP4 + frame de preview, y degrada con elegancia si no hay ffmpeg", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "video" });
  const composeCalls = [];
  const cliCalls = [];

  const res = await generateItem(cfg, store, item.id, {
    deps: {
      runClaudeJSON: async () => ({ data: videoBrief(6), costUsd: 0.1, ms: 1, model: "stub" }),
      runClaude: composerStub(composeCalls),
      ffmpeg: async () => false, // ffmpeg ausente
      hyperframes: async (_cfg, projectDir, args) => {
        cliCalls.push(args[0]);
        if (args[0] === "check") return { code: 0, stdout: '{"ok":true}', stderr: "" };
        if (args[0] === "render") {
          const out = join(projectDir, "renders", "video.mp4");
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, "mp4");
          return { code: 0, stdout: "", stderr: "" };
        }
        const outDir = join(projectDir, args[args.indexOf("-o") + 1]);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "frame-00-at-12s.png"), "png");
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  });

  assert.deepEqual(cliCalls, ["check", "render", "snapshot"]);
  assert.ok(res.assetPath.endsWith("video.mp4"));
  assert.ok(existsSync(res.assetPath));
  assert.ok(res.previewPath.endsWith("preview.png"));
  assert.ok(existsSync(res.previewPath));
  assert.equal(store.getItem(item.id).status, "built");
});

test("video: si no hay ni ffmpeg ni snapshot, preview_path cae en el propio MP4", async () => {
  const { cfg, store } = makeEnv();
  const item = addItem(store, { format: "video" });

  const res = await generateItem(cfg, store, item.id, {
    deps: {
      runClaudeJSON: async () => ({ data: videoBrief(5), costUsd: 0.1, ms: 1, model: "stub" }),
      runClaude: composerStub([]),
      ffmpeg: async () => false,
      hyperframes: async (_cfg, projectDir, args) => {
        if (args[0] === "check") return { code: 0, stdout: '{"ok":true}', stderr: "" };
        if (args[0] === "render") {
          const out = join(projectDir, "renders", "video.mp4");
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, "mp4");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "sin browser" };
      },
    },
  });

  assert.equal(res.previewPath, res.assetPath);
  assert.ok(res.previewPath, "preview_path nunca puede quedar vacio");
});

test("renderPostMarkdown incluye frontmatter y los hechos usados", () => {
  const item = { id: "x", scheduled_for: "2026-08-20", format: "text", language: "es", revision: 2, angle: "un angulo" };
  const md = renderPostMarkdown({ ...TEXT_BRIEF }, item);
  assert.match(md, /^---\nid: x\n/);
  assert.match(md, /revision: 2/);
  assert.match(md, /facts_used:\n- Postgres con pgvector incluido/);
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

test("checkPassed solo pasa con exit 0 y ok:true", () => {
  assert.equal(checkPassed({ code: 0, stdout: '{"ok":true}' }), true);
  assert.equal(checkPassed({ code: 0, stdout: '{"ok":false}' }), false);
  assert.equal(checkPassed({ code: 1, stdout: '{"ok":true}' }), false);
  assert.equal(checkPassed({ code: 0, stdout: "sin json" }), true);
  assert.equal(checkPassed({ code: 1, stdout: "" }), false);
});

test("summarizeCheck arma un reporte accionable para el modelo", () => {
  const stdout = JSON.stringify({
    ok: false,
    contrast: [
      { severity: "error", code: "contrast_fail", message: "1.9:1 < 4.5:1", selector: "#cta", file: "compositions/frames/01-a.html", time: 2.5, suggestion: "#E8EDDF" },
    ],
    layout: { errors: [{ severity: "error", code: "canvas_overflow", message: "text leaves the canvas", selector: "#h1" }] },
  });
  const out = summarizeCheck({ stdout });
  assert.match(out, /contrast_fail/);
  assert.match(out, /selector=#cta/);
  assert.match(out, /fix=#E8EDDF/);
  assert.match(out, /canvas_overflow/);
  assert.match(out, /file=compositions\/frames\/01-a\.html/);

  // los errores van primero: son los que gatean el exit code
  const mixed = summarizeCheck({
    stdout: JSON.stringify({
      ok: false,
      lint: [
        { severity: "warning", code: "studio_missing_editable_id", message: "sin id" },
        { severity: "info", code: "content_overlap", message: "solape transitorio" },
        { severity: "error", code: "canvas_overflow", message: "se sale del canvas", sourceFile: "a.html" },
      ],
    }),
  });
  assert.match(mixed.split("\n")[0], /\[error\] canvas_overflow/);

  const fallback = summarizeCheck({ stdout: "", stderr: "chrome no arranco" });
  assert.match(fallback, /chrome no arranco/);
});

test("buildRepairPrompt lista solo los archivos de composicion y prohibe tocar index.html", () => {
  const plan = planScenes({
    format: "carousel",
    formatCfg: REAL_CONFIG.formats.carousel,
    brief: carouselBrief(6),
    itemId: "id",
  });
  const p = buildRepairPrompt({ plan, report: "contrast_fail", attempt: 1 });
  assert.match(p, /index\.html is owned by the pipeline: do not touch it/);
  for (const s of plan.scenes) assert.ok(p.includes(s.file));
});

// ---------------------------------------------------------------------------
// Parser de bloques ```html
// ---------------------------------------------------------------------------

test("extractCompositions parsea los fences ```html con ruta en la primera linea", () => {
  const plan = planScenes({
    format: "carousel",
    formatCfg: REAL_CONFIG.formats.carousel,
    brief: carouselBrief(2),
    itemId: "id",
  });
  const answer = [
    "```html",
    plan.scenes[0].file,
    "<html><body>uno</body></html>",
    "```",
    "",
    "```html",
    plan.scenes[1].file,
    "<html><body>dos</body></html>",
    "```",
  ].join("\n");

  const { files, skipped, missing } = extractCompositions(answer, plan);
  assert.equal(missing.length, 0);
  assert.equal(skipped.length, 0);
  assert.equal(Object.keys(files).length, 2);
  assert.ok(files[plan.scenes[0].file].includes("uno"));
  assert.ok(files[plan.scenes[1].file].includes("dos"));
});

test("extractCompositions ignora bloques que no son del plan y avisa", () => {
  const plan = planScenes({
    format: "image",
    formatCfg: REAL_CONFIG.formats.image,
    brief: IMAGE_BRIEF,
    itemId: "id",
  });
  const answer = [
    "```html",
    plan.scenes[0].file,
    "<x>1</x>",
    "```",
    "",
    "```html",
    "compositions/frames/99-extra.html",
    "<x>2</x>",
    "```",
  ].join("\n");

  const { files, skipped, missing } = extractCompositions(answer, plan);
  assert.deepEqual(missing, []);
  assert.deepEqual(skipped, ["compositions/frames/99-extra.html"]);
  assert.equal(Object.keys(files).length, 1);
});

test("extractCompositions devuelve todas como faltantes si el modelo no entrego fences", () => {
  const plan = planScenes({
    format: "video",
    formatCfg: REAL_CONFIG.formats.video,
    brief: videoBrief(3),
    itemId: "id",
  });
  const { files, missing } = extractCompositions("nada que parsear", plan);
  assert.equal(Object.keys(files).length, 0);
  assert.equal(missing.length, plan.scenes.length);
});

test("extractCompositions acepta la ruta decorada con <> o pegada al fence", () => {
  const plan = planScenes({
    format: "carousel",
    formatCfg: REAL_CONFIG.formats.carousel,
    brief: carouselBrief(2),
    itemId: "id",
  });
  // Los dos envoltorios que el modelo uso en corridas reales: <ruta> en la
  // primera linea, y la ruta pegada al fence sin salto.
  const answer = [
    "```html",
    `<${plan.scenes[0].file}>`,
    "<html><body>uno</body></html>",
    "```",
    "",
    "```html " + plan.scenes[1].file,
    "<html><body>dos</body></html>",
    "```",
  ].join("\n");

  const { files, skipped, missing } = extractCompositions(answer, plan);
  assert.deepEqual(missing, []);
  assert.deepEqual(skipped, []);
  assert.ok(files[plan.scenes[0].file].includes("uno"));
  assert.ok(files[plan.scenes[1].file].includes("dos"));
});

test("extractCompositions saca la ruta de una linea con basura pegada", () => {
  const plan = planScenes({
    format: "carousel",
    formatCfg: REAL_CONFIG.formats.carousel,
    brief: carouselBrief(2),
    itemId: "id",
  });
  // Caso real: el modelo copio el placeholder del prompt pegado a la ruta.
  const answer = [
    "```html",
    `<relpath-from-cwd>${plan.scenes[0].file}`,
    "<html>uno</html>",
    "```",
    "```html",
    `File: ${plan.scenes[1].file}`,
    "<html>dos</html>",
    "```",
  ].join("\n");

  const { files, missing } = extractCompositions(answer, plan);
  assert.deepEqual(missing, []);
  assert.ok(files[plan.scenes[0].file].includes("uno"));
  assert.ok(files[plan.scenes[1].file].includes("dos"));
});

test("extractCompositions rescata una escena unica devuelta sin ruta", () => {
  const plan = planScenes({
    format: "image",
    formatCfg: REAL_CONFIG.formats.image,
    brief: IMAGE_BRIEF,
    itemId: "id",
  });
  const html = `<template><div id="root" data-composition-id="fr01">${"x".repeat(300)}</div></template>`;
  const { files, missing } = extractCompositions("aca va el archivo:\n\n" + html, plan);
  assert.deepEqual(missing, []);
  assert.ok(files[plan.scenes[0].file].includes("data-composition-id"));
});

test("extractCompositions NO rescata cuando el plan tiene varias escenas", () => {
  const plan = planScenes({
    format: "carousel",
    formatCfg: REAL_CONFIG.formats.carousel,
    brief: carouselBrief(2),
    itemId: "id",
  });
  const html = `<template><div id="root">${"x".repeat(300)}</div></template>`;
  const { files, missing } = extractCompositions(html, plan);
  assert.equal(Object.keys(files).length, 0);
  assert.equal(missing.length, 2);
});

test("gatherContextFiles expone frame.md y reference.html del proyecto", () => {
  const { cfg } = makeEnv();
  const projectDir = join(cfg.hyperframes.projectsDir, "dummy");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "frame.md"), "# frame\n");
  mkdirSync(join(projectDir, ".bca"), { recursive: true });
  writeFileSync(join(projectDir, ".bca", "reference.html"), "<!doctype html><html></html>");

  const plan = planScenes({
    format: "image",
    formatCfg: REAL_CONFIG.formats.image,
    brief: IMAGE_BRIEF,
    itemId: "id",
  });
  // La composicion ya existe en disco: includeExisting la tiene que inlinear.
  mkdirSync(join(projectDir, "compositions", "frames"), { recursive: true });
  writeFileSync(join(projectDir, plan.scenes[0].file), "<existing>");

  const files = gatherContextFiles(projectDir, plan, { includeExisting: false });
  assert.ok(files["frame.md"]);
  assert.ok(files[".bca/reference.html"]);
  assert.equal(files[plan.scenes[0].file], undefined);

  const withExisting = gatherContextFiles(projectDir, plan, { includeExisting: true });
  assert.ok(withExisting[plan.scenes[0].file]);
});

test("mapLimit preserva el orden y acota la concurrencia", async () => {
  let live = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2);
  assert.deepEqual(await mapLimit([], 3, async () => 1), []);
});

test("resolveFfmpeg prefiere el override de entorno y si no degrada al PATH", () => {
  const here = new URL(import.meta.url).pathname.replace(/^\//, "");
  assert.equal(resolveFfmpeg({ ADSAI_FFMPEG: here }), here);
  const resolved = resolveFfmpeg({ ADSAI_FFMPEG: "C:/no/existe/ffmpeg.exe" });
  assert.ok(resolved === "ffmpeg" || resolved.endsWith("ffmpeg.exe"));
});
