// Conocimiento de producto: lee los repos y los destila en un digest citable.
//
// Por que existe: planificar y escribir contenido necesita saber que hace el
// producto HOY. Releer los repos en cada generacion seria carisimo, asi que el
// digest se cachea por commit: mientras el HEAD no se mueva, no se vuelve a
// llamar al modelo.
//
// Por que los `facts` llevan `source`: lo que sale de aca termina en anuncios
// publicos. Un numero inventado no es un bug de formato, es una promesa
// comercial falsa. Por eso cada hecho tiene que apuntar a un archivo del repo
// donde se comprobo, y los que no lo tienen se descartan sin piedad.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";

import { createHash } from "node:crypto";

import { runClaudeJSON } from "./claude.mjs";
import { readSite } from "./site.mjs";

const GIT_TIMEOUT_MS = 30_000;
const MAX_FACTS = 50;

// Cuanto codigo se manda por digest. Estas tapas evitan que un repo con un
// `docs/` enorme o miles de archivos baratos tumbe el contexto del wrapper.
// Si el digest sale flaco, hay que subir MAX_INLINE_FILES o MAX_INLINE_BYTES.
const MAX_INLINE_FILES = 60;
const MAX_INLINE_BYTES = 200 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", ".next", ".turbo", "target"]);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Sincroniza un repo: obtiene el HEAD y, si cambio, regenera el digest.
 *
 * @param {object} cfg          - config de loadConfig()
 * @param {import("./store.mjs").Store} store
 * @param {object} repoConfig   - entrada de cfg.repos: { id, path, what, remote, include }
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]  - unico canal de salida; sin esto no imprime nada
 * @param {boolean} [opts.force]              - regenera aunque el sha coincida
 * @returns {Promise<{repoId, headSha, skipped, digestChars, costUsd, factCount?, droppedFacts?}>}
 */
export async function syncRepo(cfg, store, repoConfig, opts = {}) {
  const { log, force = false } = opts;
  const say = typeof log === "function" ? log : () => {};

  const repoId = repoConfig?.id;
  if (!repoId) throw new Error("repoConfig.id es obligatorio");
  if (!repoConfig?.path) throw new Error(`repo ${repoId}: falta 'path' en la config`);

  // resolve() normaliza los separadores: la config usa "/" y Windows quiere "\".
  const repoPath = resolve(repoConfig.path);
  const headSha = await readHeadSha(repoId, repoPath);

  const brandId = opts.brandId ?? store.defaultBrand()?.id ?? null;
  const sourceId = opts.sourceId ?? (brandId ? `${brandId}:repo:${repoId}` : repoId);

  const prev = store.getKnowledge(sourceId);
  if (!force && prev && prev.fingerprint === headSha) {
    say(`[knowledge] ${repoId}: sin cambios en ${short(headSha)}, se reusa el digest`);
    return {
      repoId,
      headSha,
      skipped: true,
      digestChars: prev.digest?.length ?? 0,
      costUsd: 0,
    };
  }

  say(
    prev
      ? `[knowledge] ${repoId}: ${short(prev.head_sha)} -> ${short(headSha)}, releyendo el repo`
      : `[knowledge] ${repoId}: primer digest en ${short(headSha)}`,
  );

  const model = cfg?.models?.digest;
  const files = collectRepoFiles(repoPath, repoConfig.include);
  const res = await runClaudeJSON(buildPrompt(cfg, repoConfig, repoPath, headSha, files), {
    model,
    timeoutMs: cfg?.limits?.claudeTimeoutMs ?? 900_000,
    systemPrompt: SYSTEM_PROMPT,
    files,
  });

  const digest = typeof res.data?.digest === "string" ? res.data.digest.trim() : "";
  if (!digest) {
    throw new Error(`repo ${repoId}: el modelo no devolvio un 'digest' de texto`);
  }

  const { facts, dropped } = sanitizeFacts(res.data?.facts, repoPath);
  if (dropped.length) {
    say(`[knowledge] ${repoId}: ${dropped.length} hecho(s) descartado(s) por fuente invalida`);
    for (const d of dropped.slice(0, 10)) say(`[knowledge]   x ${d}`);
  }

  store.putKnowledge({
    sourceId,
    brandId,
    kind: "repo",
    ref: repoPath,
    label: repoId,
    fingerprint: headSha,
    digest,
    facts,
  });
  store.logRun({
    kind: "digest",
    model: res.model ?? model ?? null,
    costUsd: res.costUsd,
    ms: res.ms,
    ok: true,
    detail: `${repoId} ${short(headSha)} ${digest.length}ch ${facts.length}facts (${dropped.length} descartados)`,
  });

  say(`[knowledge] ${repoId}: digest de ${digest.length} chars, ${facts.length} hecho(s) citable(s)`);

  return {
    repoId,
    headSha,
    skipped: false,
    digestChars: digest.length,
    costUsd: res.costUsd ?? 0,
    factCount: facts.length,
    droppedFacts: dropped.length,
  };
}

/**
 * Sincroniza una fuente que no es un repo: hoy, un sitio web o un texto pegado.
 *
 * El digest se rehace solo si el contenido cambio (el fingerprint es el hash de
 * lo leido): un sitio que no se toco no vuelve a costar una llamada al modelo.
 */
export async function syncSource(cfg, store, source, { log, force = false, deps = {} } = {}) {
  const say = typeof log === "function" ? log : () => {};
  const leerSitio = deps.readSite ?? readSite;
  const llamar = deps.runClaudeJSON ?? runClaudeJSON;
  const etiqueta = source.label ?? source.source_id;

  let texto = "";
  let paginas = [];
  if (source.kind === "url") {
    const sitio = await leerSitio(source.ref, { maxPages: 6, log: (m) => say(`[knowledge]   ${m}`) });
    texto = sitio.text ?? "";
    paginas = (sitio.pages ?? []).map((p) => p.url);
    if (!texto.trim()) throw new Error(`${source.ref}: no se pudo leer nada del sitio`);
  } else {
    texto = String(source.ref ?? "");
    if (!texto.trim()) throw new Error(`${etiqueta}: la fuente esta vacia`);
  }

  const fingerprint = createHash("sha256").update(texto).digest("hex").slice(0, 40);
  const prev = store.getKnowledge(source.source_id);
  if (!force && prev?.digest && prev.fingerprint === fingerprint) {
    say(`[knowledge] ${etiqueta}: sin cambios, se reusa el digest`);
    return { repoId: source.source_id, skipped: true, digestChars: prev.digest.length, costUsd: 0 };
  }

  const res = await llamar(buildSourcePrompt(cfg, store, source, texto), {
    model: cfg?.models?.digest,
    timeoutMs: cfg?.limits?.claudeTimeoutMs ?? 900_000,
    systemPrompt: SYSTEM_PROMPT_WEB,
  });

  const digest = typeof res.data?.digest === "string" ? res.data.digest.trim() : "";
  if (!digest) throw new Error(`${etiqueta}: el modelo no devolvio un 'digest' de texto`);

  // En un repo la fuente de un hecho es un archivo que se puede abrir; en un
  // sitio es la pagina. Se acepta cualquier URL que se haya leido de verdad.
  const permitidas = new Set([source.ref, ...paginas]);
  const facts = [];
  const dropped = [];
  for (const f of Array.isArray(res.data?.facts) ? res.data.facts : []) {
    const claim = String(f?.claim ?? "").trim();
    if (!claim) continue;
    const src = String(f?.source ?? "").trim();
    if (source.kind === "url" && src && !permitidas.has(src) && !paginas.some((p) => src.startsWith(p))) {
      facts.push({ claim, source: source.ref });
      continue;
    }
    facts.push({ claim, source: src || source.ref });
  }

  store.putKnowledge({
    sourceId: source.source_id,
    brandId: source.brand_id,
    kind: source.kind,
    ref: source.ref,
    label: etiqueta,
    fingerprint,
    digest,
    facts,
  });
  store.logRun({
    kind: "digest",
    model: res.model ?? cfg?.models?.digest ?? null,
    costUsd: res.costUsd,
    ms: res.ms,
    ok: true,
    detail: `${etiqueta} ${digest.length}ch ${facts.length}facts`,
  });
  say(`[knowledge] ${etiqueta}: digest de ${digest.length} chars, ${facts.length} hecho(s) citable(s)`);
  if (!facts.length) {
    say(`[knowledge] ${etiqueta}: aviso — sin hechos citables el contenido va a salir generico`);
  }
  return {
    repoId: source.source_id,
    skipped: false,
    digestChars: digest.length,
    costUsd: res.costUsd ?? 0,
    factCount: facts.length,
    droppedFacts: dropped.length,
  };
}

/** Prompt del digest para una fuente que no es un repo. */
function buildSourcePrompt(cfg, store, source, texto) {
  const brand = source.brand_id ? store.getBrand(source.brand_id) : null;
  return [
    source.kind === "url"
      ? `Leiste el sitio ${source.ref}. Escribi el digest de producto que va a usar el equipo de contenido.`
      : "Este es material que paso el usuario sobre la marca. Escribi el digest de producto.",
    "",
    brand?.name ? `Marca: ${brand.name}` : "",
    brand?.audience ? `Publico: ${brand.audience}` : "",
    "",
    "El texto puede venir con ruido (menus, pies de pagina, restos de codigo del sitio).",
    "Ignoralo y quedate con lo que describe el producto.",
    "",
    "# Material",
    texto.slice(0, 30_000),
    "",
    "# Que devolver",
    JSON.stringify(
      {
        digest: "markdown: que es, para quien, que resuelve, como funciona, en que se diferencia",
        facts: [{ claim: "un hecho concreto y citable", source: "la URL de donde salio" }],
      },
      null,
      2,
    ),
    "",
    "Reglas: nada de adjetivos de folleto; numeros y nombres propios solo si aparecen en el material;",
    "entre 8 y 20 hechos; cada hecho tiene que poder verificarse leyendo la fuente que declaras.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Sincroniza todos los repos de cfg.repos, uno por uno.
 *
 * Secuencial a proposito: cada llamada reenvia el repo entero (~30k tokens);
 * dos en paralelo no aceleran nada y ensucian el log.
 *
 * Un repo que no existe o que no es git NO tumba el sync: se devuelve su
 * resultado con `error` y se sigue con los demas.
 *
 * @returns {Promise<Array<object>>}
 */
export async function syncAll(cfg, store, { log, force = false, brandId = null } = {}) {
  const say = typeof log === "function" ? log : () => {};

  // Las fuentes de la marca mandan: son las que se dieron de alta al crearla
  // (su sitio) o a mano. Los repos de brand-content-ai.config.json siguen valiendo para la
  // instalacion original, que nacio antes de que las marcas existieran.
  const marca = brandId ?? store.defaultBrand()?.id ?? null;
  const fuentes = marca ? store.allKnowledge(marca) : [];
  const results = [];

  for (const fuente of fuentes.filter((f) => f.kind !== "repo")) {
    try {
      results.push(await syncSource(cfg, store, fuente, { log, force }));
    } catch (err) {
      const message = err?.message ?? String(err);
      say(`[knowledge] ${fuente.source_id}: FALLO — ${message}`);
      results.push({ repoId: fuente.source_id, skipped: false, costUsd: 0, error: message });
    }
  }

  // La config sigue siendo la que sabe QUE leer de cada repo (`include`), y en
  // una base migrada de la version anterior el `ref` guardado es el id del repo
  // y no su ruta: por eso, cuando el repo esta en la config, manda la config.
  const porId = new Map((Array.isArray(cfg?.repos) ? cfg.repos : []).map((r) => [r.id, r]));
  const deFuentes = fuentes
    .filter((f) => f.kind === "repo")
    .map((f) => {
      const id = f.label ?? f.source_id;
      const deLaConfig = porId.get(id);
      return {
        ...(deLaConfig ?? {}),
        id,
        path: deLaConfig?.path ?? f.ref,
        sourceId: f.source_id,
      };
    });
  // Los repos de brand-content-ai.config.json son de la marca original y de ninguna otra:
  // solo se usan cuando la marca no declaro NINGUNA fuente propia. Sin esto,
  // una marca nueva terminaba leyendo los repos de la primera.
  const deConfig = fuentes.length ? [] : Array.isArray(cfg?.repos) ? cfg.repos : [];
  const repos = deFuentes.length ? deFuentes : deConfig;
  if (!repos.length && !fuentes.length) {
    throw new Error(
      "esta marca no tiene fuentes de conocimiento: agregale su sitio o un repo antes de sincronizar",
    );
  }

  for (const repoConfig of repos) {
    const repoId = repoConfig?.id ?? null;
    try {
      results.push(
        await syncRepo(cfg, store, repoConfig, {
          log,
          force,
          brandId: marca,
          sourceId: repoConfig.sourceId,
        }),
      );
    } catch (err) {
      const message = err?.message ?? String(err);
      say(`[knowledge] ${repoId ?? "?"}: FALLO — ${message}`);
      store.logRun({
        kind: "digest",
        model: cfg?.models?.digest ?? null,
        ok: false,
        detail: `${repoId ?? "?"}: ${message}`.slice(0, 500),
      });
      results.push({
        repoId,
        headSha: null,
        skipped: false,
        digestChars: 0,
        costUsd: 0,
        error: message,
      });
    }
  }
  return results;
}

/**
 * Contexto de marca para inyectar en los prompts de planificacion y generacion.
 *
 * Reparte `maxChars` en partes iguales entre los repos: sin eso, un repo con un
 * digest gigante dejaria a los otros fuera del contexto.
 */
export function knowledgeContext(store, { maxChars = 12_000, brandId = null } = {}) {
  const rows = store.allKnowledge(brandId).filter((r) => r.digest);
  if (!rows.length) return "";

  const SEP = "\n\n---\n\n";
  const blocks = rows.map(renderBlock).filter(Boolean);
  if (!blocks.length) return "";

  const whole = blocks.join(SEP);
  if (whole.length <= maxChars) return whole;

  const sepCost = SEP.length * (blocks.length - 1);
  const budget = Math.max(200, Math.floor((maxChars - sepCost) / blocks.length));
  const clipped = blocks.map((b) => clip(b, budget)).join(SEP);
  return clipped.length <= maxChars ? clipped : clipped.slice(0, maxChars);
}

/**
 * Filtra los hechos que devolvio el modelo: sobreviven solo los que traen una
 * fuente que existe de verdad dentro del repo.
 *
 * Exportado para poder testear la regla critica sin llamar al modelo.
 *
 * @returns {{ facts: Array<{claim: string, source: string}>, dropped: string[] }}
 */
export function sanitizeFacts(raw, repoPath) {
  const facts = [];
  const dropped = [];
  if (!Array.isArray(raw)) return { facts, dropped };

  const root = resolve(repoPath ?? ".");
  const seen = new Set();

  for (const entry of raw) {
    const claim = typeof entry?.claim === "string" ? entry.claim.trim() : "";
    if (!claim) {
      dropped.push(`(sin claim) ${JSON.stringify(entry).slice(0, 120)}`);
      continue;
    }
    const source = normalizeSource(entry?.source, root);
    if (!source) {
      dropped.push(`${claim} — sin source`);
      continue;
    }
    if (!sourceExists(source, root)) {
      dropped.push(`${claim} — source inexistente: ${source}`);
      continue;
    }
    const key = claim.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ claim, source });
    if (facts.length >= MAX_FACTS) break;
  }

  return { facts, dropped };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Sos un analista de producto que documenta un repositorio de codigo real.
Lo que escribas alimenta un sistema que genera anuncios PUBLICOS de forma automatica.

REGLA INVIOLABLE: todo lo que afirmes tiene que estar comprobado en un archivo del
repo que estas leyendo. Un dato inventado no es un error de formato: sale publicado
como promesa comercial falsa. Ante la duda, se omite.

Consecuencias practicas:
- Prohibido estimar, redondear, extrapolar o completar con conocimiento general
  sobre tecnologias parecidas. Si el numero no esta escrito en un archivo, no existe.
- Prohibido tratar como hecho lo que el repo declara como plan, TODO, roadmap, idea,
  "coming soon", ejemplo de documentacion o valor placeholder. Solo cuenta lo que el
  codigo hace hoy.
- Cada hecho lleva "source": la ruta del archivo (relativa a la raiz del repo) donde
  lo comprobaste, opcionalmente con :linea. Sin source, el hecho se descarta.
- Un "facts" vacio es una respuesta correcta y aceptable. Una lista inventada es la
  peor falla posible de esta tarea.
- Nada de adjetivos de marketing en el digest: describi, no vendas. El texto de venta
  lo escribe otro proceso a partir de esto.`;

// El system prompt de arriba habla de archivos del repo: leido al pie de la
// letra por una fuente web, el modelo concluye que no puede citar nada y
// devuelve la lista de hechos vacia (paso exactamente eso la primera vez). La
// exigencia es la misma; lo que cambia es que aca se cita una URL.
const SYSTEM_PROMPT_WEB = `Sos un analista de producto que documenta un producto real a partir de su sitio.
Lo que escribas alimenta un sistema que genera anuncios PUBLICOS de forma automatica.

REGLA INVIOLABLE: todo lo que afirmes tiene que estar escrito en el material que te
pasaron. Un dato inventado no es un error de formato: sale publicado como promesa
comercial falsa. Ante la duda, se omite.

Consecuencias practicas:
- Prohibido estimar, redondear, extrapolar o completar con conocimiento general sobre
  productos parecidos. Si el numero no aparece en el material, no existe.
- Prohibido tratar como hecho lo que el sitio anuncia como proximo, beta, roadmap o
  ejemplo. Solo cuenta lo que el producto hace hoy.
- Cada hecho lleva "source": la URL de la pagina donde lo leiste.
- El material puede venir con ruido (menus, pies de pagina, mensajes de error del
  framework). Ignoralo, no lo cites.
- Nada de adjetivos de marketing en el digest: describi, no vendas. El texto de venta
  lo escribe otro proceso a partir de esto.`;

function buildPrompt(cfg, repoConfig, repoPath, headSha, files = {}) {
  const brand = cfg?.brand ?? {};
  const lang = brand.defaultLanguage ?? "en";
  const hints = Array.isArray(repoConfig.include) ? repoConfig.include : [];
  const inlined = Object.keys(files);
  const trimmed =
    inlined.length > MAX_INLINE_FILES
      ? `${inlined.slice(0, MAX_INLINE_FILES).join(", ")} ... (+${inlined.length - MAX_INLINE_FILES} mas)`
      : inlined.join(", ");

  return [
    `Analiza el repositorio "${repoConfig.id}" y produci un digest de conocimiento de producto.`,
    "",
    `- Raiz del repo: ${repoPath}`,
    `- Commit: ${headSha}`,
    repoConfig.remote ? `- Remoto: ${repoConfig.remote}` : null,
    repoConfig.what ? `- Que es, segun la config del proyecto: ${repoConfig.what}` : null,
    brand.name ? `- Marca a la que pertenece: ${brand.name}${brand.site ? ` (${brand.site})` : ""}` : null,
    brand.audience ? `- Publico al que se le va a hablar: ${brand.audience}` : null,
    "",
    "Como leerlo:",
    hints.length
      ? `1. Empezar por: ${hints.join(", ")}. Ahi suele estar la version declarada del producto.`
      : "1. Empezar por el README y la documentacion de la raiz.",
    "2. Despues verificar contra el codigo: rutas/endpoints, comandos de CLI, migraciones,",
    "   configuracion por defecto, tests. El codigo manda sobre el README cuando se contradicen.",
    "3. Si algo del README no aparece implementado, NO lo cuentes como capacidad.",
    "",
    inlined.length
      ? `Los archivos relevantes estan en este mismo prompt, etiquetados con su ruta. ` +
        `Leelos directamente: no hay herramientas de filesystem.\nArchivos disponibles (${inlined.length}): ${trimmed}`
      : "No se inlinaron archivos del repo (revisa los globs en cfg.repos.include). " +
        "Solo podes afirmar lo que este en archivos que existen en el repo, asi que responde con lo que sepas.",
    "",
    `Escribi el digest en ${lang}, en markdown, maximo ~3500 caracteres, con estas secciones:`,
    "",
    "## What it is — que es el proyecto, en un parrafo, en terminos concretos.",
    "## Problem — que problema resuelve y para quien; que hacia el usuario antes.",
    "## Capabilities — bullets de capacidades REALES ya implementadas, con el archivo o",
    "   directorio que lo prueba entre parentesis.",
    "## Numbers — cifras citables tal como aparecen en el repo (limites, defaults, versiones,",
    "   cantidad de comandos/endpoints/formatos soportados, tiempos configurados...).",
    "## Vocabulary — como nombra el proyecto a sus propias cosas, para que el copy use",
    "   sus palabras y no sinonimos inventados.",
    "## Not yet — que NO hace o que esta a medias, para no prometerlo en un anuncio.",
    "",
    "Y aparte, el array `facts`: los hechos sueltos que un anuncio podria citar textualmente.",
    "Cada uno con su ruta de comprobacion. Preferi numeros y capacidades verificables por",
    "sobre generalidades. Maximo 25.",
    "",
    "Formato exacto de la respuesta:",
    "{",
    '  "digest": "markdown con las secciones de arriba",',
    '  "facts": [',
    '    { "claim": "afirmacion corta, autocontenida y citable", "source": "ruta/relativa/al/archivo.go:120" }',
    "  ]",
    "}",
    "",
    "Recorda: si no lo pudiste comprobar leyendo un archivo, no va.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

async function readHeadSha(repoId, repoPath) {
  if (!existsSync(repoPath)) {
    throw new Error(`repo ${repoId}: la ruta no existe en disco: ${repoPath}`);
  }

  const head = await git(["-C", repoPath, "rev-parse", "HEAD"]);
  if (head.code === 0) {
    const sha = head.stdout.trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      throw new Error(`repo ${repoId}: git devolvio un HEAD inesperado: ${sha.slice(0, 80)}`);
    }
    return sha;
  }

  // Fallo: distinguir "no hay git" de "no es un repo" y de "repo sin commits".
  if (head.enoent) {
    throw new Error(`repo ${repoId}: no se encontro el ejecutable "git" en el PATH`);
  }
  const probe = await git(["-C", repoPath, "rev-parse", "--is-inside-work-tree"]);
  if (probe.code !== 0) {
    throw new Error(
      `repo ${repoId}: ${repoPath} no es un repositorio git (${firstLine(probe.stderr || head.stderr)})`,
    );
  }
  throw new Error(
    `repo ${repoId}: no se pudo leer el HEAD de ${repoPath} — ${firstLine(head.stderr)}`,
  );
}

function git(args) {
  return new Promise((res) => {
    execFile(
      "git",
      args,
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 << 20, encoding: "utf8" },
      (err, stdout, stderr) => {
        res({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          enoent: err?.code === "ENOENT",
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (err ? err.message : ""),
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function renderBlock(row) {
  if (!row?.digest) return "";
  const lines = [`# ${row.label ?? row.source_id}`, "", row.digest.trim()];
  if (Array.isArray(row.facts) && row.facts.length) {
    lines.push("", "**Hechos verificados (usar textual, no adornar):**");
    for (const f of row.facts) {
      if (!f?.claim) continue;
      lines.push(`- ${f.claim}${f.source ? ` — \`${f.source}\`` : ""}`);
    }
  }
  return lines.join("\n");
}

function clip(text, max) {
  if (text.length <= max) return text;
  const MARK = "\n… (recortado)";
  const room = Math.max(0, max - MARK.length);
  let cut = text.slice(0, room);
  const nl = cut.lastIndexOf("\n");
  if (nl > room * 0.5) cut = cut.slice(0, nl);
  return cut + MARK;
}

/**
 * Reduce la fuente que devolvio el modelo a UNA ruta relativa al repo, o null.
 *
 * El modelo cita como citaria un humano, y esas formas son legitimas:
 *   "internal/mcp/tools.go:85-511, rls_tools.go:13-88"   (varios archivos)
 *   "backend/internal/httpapi/skill.go (skillTemplate)"  (aclaracion al final)
 *   "backend/internal/httpapi/lang.go:59-66"             (guion largo unicode)
 *   "README.md:55 & backend/.../reaper.go"               (dos fuentes)
 * Antes se descartaban todas y perdiamos hechos verdaderos por formato — en el
 * primer sync real se cayeron 24 de 26 hechos ciertos. Nos quedamos con la
 * primera ruta citada y la verificamos; el resto de la cita es prosa.
 */
function normalizeSource(raw, root) {
  if (typeof raw !== "string") return null;

  let s = raw.trim().replace(/\\/g, "/");
  if (!s) return null;

  // Quedarse con la primera fuente cuando se citan varias.
  s = s.split(/\s*(?:,|;|&|\band\b|\by\b)\s+/i)[0];
  // Sacar aclaraciones entre parentesis o corchetes: "skill.go (skillTemplate)".
  s = s.replace(/\s*[([][^)\]]*[)\]]\s*$/, "");
  // Sacar ancla y numeros de linea, con guion ASCII o en/em dash unicode.
  s = s.split("#")[0];
  s = s.replace(/:L?\d+(?:\s*[-‐-―]\s*L?\d+)?\s*$/i, "");
  s = s.replace(/^["'`]|["'`]$/g, "").trim();

  const rootFwd = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (s.toLowerCase().startsWith(rootFwd.toLowerCase() + "/")) {
    s = s.slice(rootFwd.length + 1);
  }
  s = s.replace(/^\.\//, "").replace(/^\/+/, "").trim();
  return s || null;
}

/** La fuente vale solo si apunta a algo que existe dentro del repo. */
function sourceExists(source, root) {
  const clean = source.trim();
  if (!clean || clean.includes("*") || clean.includes("?")) return false;

  const abs = resolve(root, clean);
  const inside =
    abs.toLowerCase() === root.toLowerCase() ||
    abs.toLowerCase().startsWith(root.toLowerCase() + sep.toLowerCase());
  if (!inside) return false;
  return existsSync(abs);
}

function short(sha) {
  return typeof sha === "string" ? sha.slice(0, 7) : "?";
}

function firstLine(s) {
  return String(s ?? "").trim().split(/\r?\n/)[0] || "sin detalle";
}

// ---------------------------------------------------------------------------
// Recoleccion de archivos del repo para inlinear en el prompt del digest.
// ---------------------------------------------------------------------------

/**
 * Resuelve los globs de `cfg.repos[].include` contra el filesystem del repo.
 * Devuelve un mapa `{ "<ruta relativa al repo>": "<contenido>" }` listo para
 * pasar al wrapper como `opts.files`.
 *
 * Tapas: MAX_INLINE_FILES archivos y MAX_INLINE_BYTES bytes en total.
 * Orden: los `include` originales primero, despues el resto del arbol.
 *
 * @param {string} repoPath
 * @param {string[]} globs
 */
export function collectRepoFiles(repoPath, globs) {
  const root = resolve(repoPath ?? ".");
  if (!existsSync(root)) return {};

  const patterns = Array.isArray(globs) ? globs.filter(Boolean) : [];
  const out = {};
  let bytes = 0;
  const tryAdd = (rel, abs) => {
    if (Object.keys(out).length >= MAX_INLINE_FILES) return false;
    if (bytes >= MAX_INLINE_BYTES) return false;
    let st;
    try {
      st = statSync(abs);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    if (st.size > MAX_INLINE_BYTES) return false;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return false; // binario o ilegible: se salta
    }
    if (text.includes("\u0000")) return false; // binario disfrazado
    out[rel] = text;
    bytes += text.length;
    return true;
  };

  const seen = new Set();
  const walk = (rel) => {
    const abs = join(root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (rel && SKIP_DIRS.has(rel.split(sep).pop())) return;
      let entries;
      try {
        entries = readdirSync(abs);
      } catch {
        return;
      }
      entries.sort();
      for (const e of entries) walk(rel ? join(rel, e) : e);
      return;
    }
    // Las llaves del mapa van con forward-slash siempre: en Windows join() devuelve
    // backslashes y el wrapper igual las reescribe al generar los marcadores
    // <<<BCA_FILE path="...">>> que el modelo lee, asi que normalizamos aca.
    const key = rel.split(sep).join("/");
    if (!patterns.some((p) => matchesGlob(key, p))) return;
    seen.add(key);
    tryAdd(key, abs);
  };

  for (const p of patterns) walk("");

  // Despues de los include, si todavia queda cupoy hay patterns amplios
  // ("*.md", "**/*.md"), algunos matches pueden no haber entrado: ya estan.
  // Si no, los include eran puntuales y se completo lo que se pudo.
  return out;
}

/** Mini-match de globs: `*` (sin cruzar separador), `**` (cualquier profundidad, incluyendo cero), `?`. */
export function matchesGlob(rel, pattern) {
  const norm = String(rel).replace(/\\/g, "/");
  const pat = String(pattern).replace(/\\/g, "/");
  if (norm === pat) return true;
  const base = norm.split("/").pop();
  if (base === pat) return true;

  // Los comodines se reemplazan por sentinelas (caracteres de control que no
  // aparecen en rutas ni en globs) ANTES de escapar: asi no hay ambiguedad con
  // el `.` o `*` del propio patron.
  const STARSTAR = "\u0001";
  const STAR = "\u0002";
  const Q = "\u0003";
  const expanded = pat
    .replace(/\*\*/g, STARSTAR)
    .replace(/\*/g, STAR)
    .replace(/\?/g, Q)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(STARSTAR + "/", "(?:.*/)?") // **/ -> cero o mas segmentos
    .replace(new RegExp(STARSTAR, "g"), ".*") // ** suelto
    .replace(new RegExp(STAR, "g"), "[^/]*") // *
    .replace(new RegExp(Q, "g"), "[^/]"); // ?
  const re = new RegExp("^" + expanded + "$");
  if (re.test(norm)) return true;
  if (re.test(base)) return true;
  return false;
}
