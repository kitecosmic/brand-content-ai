#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
//
// brand-content-ai — genera contenido con la identidad de tu marca.
// Copyright (C) 2026 Joel
//
// Este programa es software libre: podes redistribuirlo y/o modificarlo bajo
// los terminos de la GNU Affero General Public License, version 3 o posterior,
// publicada por la Free Software Foundation. Se distribuye con la esperanza de
// que sea util, pero SIN NINGUNA GARANTIA. Ver LICENSE, o
// <https://www.gnu.org/licenses/>.
//
// Brand Content AI — generador de contenido automatico.
//
//   node src/cli.mjs <comando> [opciones]
//
// El CLI es la unica capa que imprime a consola y que traduce errores a
// mensajes. Los modulos de src/lib lanzan; aca se formatean.

import { env, loadConfig, today, addDays } from "./lib/config.mjs";
import { openStore } from "./lib/store.mjs";

const COMMANDS = {
  doctor: "verifica que el entorno tenga todo lo necesario",
  sync: "lee los repos conectados y actualiza el conocimiento de producto",
  plan: "genera el calendario de contenido      [--days N] [--from YYYY-MM-DD]",
  generate: "genera las piezas pendientes            [<id>] [--limit N]",
  deliver: "envia a Telegram lo que este listo      [<id>]",
  marca: "crea, lista y ajusta marcas                nueva|listar|revisar|usar",
  bot: "corre el bot de Telegram (long polling) + el panel web  [--port N]",
  web: "corre solo el panel web                  [--port N] [--host H]",
  run: "ciclo completo: sync -> plan -> generate -> deliver",
  status: "que hay planificado y en que estado",
  costs: "cuanto se gasto                         [--days N]",
  help: "esta ayuda",
};

function parseArgs(argv) {
  const [cmd = "help", ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { cmd, flags, positional };
}

const log = (...a) => console.log(...a);

async function main() {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));

  if (cmd === "help" || flags.help) return help();

  let cfg = loadConfig();
  const store = openStore(cfg.paths.db);

  // Los ajustes guardados desde el panel se vuelcan al entorno antes que nada:
  // a partir de aca, el wrapper del modelo y Telegram leen lo que configuraste
  // en la interfaz sin saber que existe esa capa.
  const { aplicarAjustes } = await import("./lib/settings.mjs");
  aplicarAjustes(store);
  cfg = loadConfig();

  // La instalacion que nacio con la marca escrita en brand-content-ai.config.json se
  // convierte en una marca de la base la primera vez que corre esto. Es
  // idempotente y no toca nada si ya hay marcas.
  const { ensureDefaultBrand } = await import("./lib/brand.mjs");
  ensureDefaultBrand(cfg, store, { log: cmd === "doctor" ? log : undefined });

  try {
    switch (cmd) {
      case "doctor":
        return await doctor(cfg, store);
      case "sync": {
        const { syncAll } = await import("./lib/knowledge.mjs");
        const res = await syncAll(cfg, store, {
          log,
          force: !!flags.force,
          brandId: flags.brand && flags.brand !== true ? String(flags.brand) : null,
        });
        const done = res.filter((r) => !r.skipped && !r.error).length;
        const skipped = res.filter((r) => r.skipped).length;
        const failed = res.filter((r) => r.error);
        log(`\nsync: ${done} actualizado(s), ${skipped} sin cambios, ${failed.length} con error`);
        for (const f of failed) log(`  ! ${f.repoId}: ${f.error}`);
        return;
      }
      case "plan": {
        const { planCalendar } = await import("./lib/calendar.mjs");
        const days = Number(flags.days ?? 14);
        const from = flags.from ?? today();
        const { created, costUsd } = await planCalendar(cfg, store, {
          days,
          from,
          log,
          brandId: flags.brand && flags.brand !== true ? String(flags.brand) : null,
        });
        log(`\nplan: ${created.length} pieza(s) entre ${from} y ${addDays(from, days)}`);
        for (const it of created) {
          log(`  ${it.scheduled_for}  ${it.format.padEnd(9)} ${it.angle}`);
        }
        if (costUsd) log(`costo: $${costUsd.toFixed(4)}`);
        return;
      }
      case "generate": {
        const { generateWithRetry, generatePending } = await import("./lib/generate.mjs");
        if (positional[0]) {
          const r = await generateWithRetry(cfg, store, positional[0], { log });
          log(`\nlisto: ${r.assetPath}`);
          return;
        }
        const limit = Number(flags.limit ?? 3);
        const res = await generatePending(cfg, store, { limit, log });
        const ok = res.filter((r) => !r.error);
        log(`\ngenerate: ${ok.length}/${res.length} pieza(s) construida(s)`);
        for (const r of res.filter((r) => r.error)) log(`  ! ${r.itemId}: ${r.error}`);
        return;
      }
      case "deliver": {
        const { deliverItem } = await import("./lib/telegram.mjs");
        const ids = positional.length
          ? positional
          : store.listItems({ status: "built" }).map((i) => i.id);
        if (!ids.length) return log("no hay nada construido para enviar");
        for (const id of ids) {
          await deliverItem(cfg, store, id);
          log(`enviado: ${id}`);
        }
        return;
      }
      case "marca":
        return await marca(cfg, store, flags, positional);
      case "bot":
        return await bot(cfg, store, flags);
      case "web":
        return await web(cfg, store, flags);
      case "run":
        return await runCycle(cfg, store, flags);
      case "status":
        return status(store);
      case "costs": {
        const rows = store.costSummary(Number(flags.days ?? 30));
        if (!rows.length) return log("sin gasto registrado");
        let total = 0;
        for (const r of rows) {
          total += r.usd ?? 0;
          log(`  ${String(r.kind).padEnd(10)} ${String(r.n).padStart(4)} llamada(s)  $${(r.usd ?? 0).toFixed(4)}`);
        }
        log(`  ${"TOTAL".padEnd(10)} ${" ".repeat(4)}              $${total.toFixed(4)}`);
        return;
      }
      default:
        log(`comando desconocido: ${cmd}\n`);
        return help();
    }
  } finally {
    store.close();
  }
}

function help() {
  log("Brand Content AI — generador de contenido automatico\n");
  log("uso: node src/cli.mjs <comando> [opciones]\n");
  for (const [name, desc] of Object.entries(COMMANDS)) {
    log(`  ${name.padEnd(10)} ${desc}`);
  }
  log("\nprimeros pasos:");
  log("  1. cp .env.example .env   y completa ADSAI_MINIMAX_API_KEY (+ Telegram si lo queres)");
  log("  2. node src/cli.mjs doctor");
  log("  3. node src/cli.mjs marca nueva --url https://tumarca.com");
  log("  4. node src/cli.mjs sync");
  log("  5. npm run web        (panel en http://127.0.0.1:4317 -> tab Crear)");
}

function status(store) {
  const items = store.listItems({ limit: 200 });
  if (!items.length) return log("no hay nada planificado todavia — corre: plan");
  const byStatus = {};
  for (const i of items) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  log("por estado: " + Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join("  "));
  log("");
  for (const i of items.slice(0, 40)) {
    const rev = i.revision ? ` r${i.revision}` : "";
    const err = i.error ? "  ! " + String(i.error).slice(0, 60) : "";
    log(`  ${i.scheduled_for}  ${i.status.padEnd(9)} ${i.format.padEnd(9)}${rev.padEnd(4)} ${i.angle}${err}`);
  }
  if (items.length > 40) log(`  ... y ${items.length - 40} mas`);
}

async function doctor(cfg, store) {
  const checks = [];
  // `opcional` marca lo que informa pero no reprueba: Telegram no hace falta
  // para generar, y un corte de red no tiene por que dar el entorno por roto.
  const add = (name, ok, detail, opcional = false) => checks.push({ name, ok, detail, opcional });

  const [maj, min] = process.versions.node.split(".").map(Number);
  add("node >= 22.5", maj > 22 || (maj === 22 && min >= 5), `v${process.versions.node}`);

  try {
    const { runModelo } = await import("./lib/modelo.mjs");
    const r = await runModelo("Respond with exactly one word: OK", {
      model: cfg.models.digest,
      timeoutMs: 120_000,
    });
    add("backend MiniMax", r.text.toUpperCase().includes("OK"), `${r.model ?? "?"} · ${r.ms}ms · in=${r.inputTokens ?? 0} out=${r.outputTokens ?? 0}`);
  } catch (e) {
    add("backend MiniMax", false, e.message);
  }

  // Telegram es opcional: sin el, el contenido se ve en el panel. Se informa,
  // no se reprueba.
  const tg = !!cfg.secrets.telegramToken && !!cfg.secrets.telegramChatId;
  add("Telegram (opcional)", true, tg ? "configurado" : "sin configurar — el contenido queda en el panel");

  if (cfg.secrets.telegramToken) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${cfg.secrets.telegramToken}/getMe`);
      const j = await res.json();
      // Un token invalido si es un problema tuyo; que Telegram no conteste, no.
      add("bot alcanzable", !!j.ok, j.ok ? `@${j.result.username}` : j.description, true);
    } catch (e) {
      const causa = e?.cause?.code ?? "";
      add(
        "bot alcanzable",
        false,
        `no se pudo llegar a api.telegram.org (${causa || e.message}) — problema de red, no de configuracion`,
        true,
      );
    }
  }

  const { existsSync } = await import("node:fs");
  for (const r of cfg.repos) {
    add(`repo ${r.id}`, existsSync(r.path), r.path);
  }

  // El proyecto de referencia solo existe en instalaciones que vienen de la
  // version anterior: una marca creada desde el panel genera el suyo.
  if (cfg.hyperframes?.referenceProject) {
    add(
      "proyecto HyperFrames de referencia",
      existsSync(cfg.hyperframes.referenceProject),
      cfg.hyperframes.referenceProject,
    );
  }

  // Primera corrida: sin cuenta no se entra al panel.
  const cuentas = store.countUsers();
  add(
    "cuenta del panel",
    cuentas > 0 || !!env("PANEL_PASSWORD"),
    cuentas > 0
      ? `${cuentas} usuario(s)`
      : env("PANEL_PASSWORD")
        ? "modo clave unica (BCA_PANEL_PASSWORD)"
        : "todavia ninguna — abri el panel y creala: npm run web",
  );

  const marcas = store.listBrands();
  add(
    "marca",
    marcas.length > 0,
    marcas.length
      ? `${marcas.length}: ${marcas.map((m) => m.name).join(", ")}`
      : "todavia ninguna — crea la primera: npm run web -> Marcas",
  );

  if (marcas.length) {
    const activa = store.defaultBrand();
    const k = store.allKnowledge(activa?.id).filter((f) => f.digest);
    add(
      "conocimiento de la marca activa",
      k.length > 0,
      k.length ? `${k.length} fuente(s) con hechos citables` : `corre: npm run sync`,
    );
  }

  log("");
  for (const c of checks) {
    const marca = c.ok ? "OK  " : c.opcional ? "aviso" : "FALTA";
    log(`  ${marca}  ${c.name.padEnd(34)} ${c.detail ?? ""}`);
  }
  const bad = checks.filter((c) => !c.ok && !c.opcional);
  log(bad.length ? `\n${bad.length} cosa(s) por resolver` : "\ntodo listo");
  if (bad.length) process.exitCode = 1;
}

/**
 * Marcas desde la terminal. El panel hace lo mismo con botones, pero tener el
 * comando permite armar una marca en un servidor sin abrir el navegador.
 */
async function marca(cfg, store, flags, positional) {
  const { createBrand, reviseBrand } = await import("./lib/brand.mjs");
  const sub = positional[0] ?? "listar";

  if (sub === "listar") {
    // Primera corrida: sin cuenta no se entra al panel.
  const cuentas = store.countUsers();
  add(
    "cuenta del panel",
    cuentas > 0 || !!env("PANEL_PASSWORD"),
    cuentas > 0
      ? `${cuentas} usuario(s)`
      : env("PANEL_PASSWORD")
        ? "modo clave unica (BCA_PANEL_PASSWORD)"
        : "todavia ninguna — abri el panel y creala: npm run web",
  );

  const marcas = store.listBrands();
    if (!marcas.length) return log("todavia no hay marcas — crea una: npm run bca marca nueva -- --url https://tumarca.com");
    for (const m of marcas) {
      const p = m.palette ?? {};
      log(
        `  ${m.isDefault ? "*" : " "} ${m.id.padEnd(22)} ${String(m.name).padEnd(20)} ` +
          `${(m.site ?? "").padEnd(28)} rev${m.revision ?? 0}  ${p.bg ?? ""} ${p.accent ?? ""}`,
      );
    }
    log("\n* = la que se usa por defecto");
    return;
  }

  if (sub === "nueva") {
    const colores = String(flags.colores ?? "")
      .split(/[\s,]+/)
      .filter(Boolean);
    const { brand, costUsd, warnings } = await createBrand(cfg, store, {
      url: flags.url && flags.url !== true ? String(flags.url) : null,
      name: flags.nombre && flags.nombre !== true ? String(flags.nombre) : null,
      colors: colores,
      hints: flags.notas && flags.notas !== true ? String(flags.notas) : "",
      log,
    });
    for (const w of warnings) log(`  aviso: ${w}`);
    log(`\nmarca creada: ${brand.name} (${brand.id})  costo $${(costUsd ?? 0).toFixed(4)}`);
    log(`  paleta: ${Object.entries(brand.palette ?? {}).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    log(`  fuentes: ${brand.fonts?.display?.family} + ${brand.fonts?.mono?.family}`);
    if (!store.defaultBrand() || store.listBrands().length === 1) store.setDefaultBrand(brand.id);
    return;
  }

  if (sub === "revisar") {
    const id = positional[1];
    const feedback = positional.slice(2).join(" ") || String(flags.feedback ?? "");
    if (!id || !feedback) return log('uso: npm run bca marca revisar <id> "mas oscuro, acento violeta"');
    const r = await reviseBrand(cfg, store, id, feedback, { log });
    for (const w of r.warnings) log(`  aviso: ${w}`);
    log(`\nrevision ${r.revision} aplicada a ${r.brand.name}  costo $${(r.costUsd ?? 0).toFixed(4)}`);
    return;
  }

  if (sub === "usar") {
    const id = positional[1];
    if (!store.getBrand(id)) return log(`no existe la marca ${id}`);
    store.setDefaultBrand(id);
    return log(`ahora se trabaja sobre ${id}`);
  }

  log(`subcomando desconocido: ${sub}`);
  log("uso: npm run bca marca [listar|nueva|revisar|usar]");
}

async function web(cfg, store, flags = {}) {
  const { startWeb } = await import("./lib/web.mjs");
  const handlers = await buildHandlers(cfg, store);
  const server = await startWeb(cfg, store, handlers, { port: flags.port, host: flags.host, log });
  log("Ctrl+C para salir");
  // El server sostiene el proceso; salimos cuando la senal lo cierra.
  await new Promise((resolve) => {
    onShutdown(async () => {
      log("\ncerrando…");
      await closeServer(server);
      resolve();
    });
  });
}

async function bot(cfg, store, flags = {}) {
  if (!cfg.secrets.telegramToken || !cfg.secrets.telegramChatId) {
    throw new Error(
      "el bot necesita Telegram configurado: cargalo en el panel (npm run web -> Ajustes) o en .env." +
        "\n  el resto de Brand Content AI funciona sin Telegram: npm run web",
    );
  }
  const { runBot } = await import("./lib/telegram.mjs");
  const { startWeb } = await import("./lib/web.mjs");
  const handlers = await buildHandlers(cfg, store);
  // El panel sube junto al bot: son dos vistas del mismo estado y no tiene
  // sentido tener que acordarse de arrancar dos procesos.
  const server = await startWeb(cfg, store, handlers, { port: flags.port, host: flags.host, log });
  const ac = new AbortController();
  const disarm = onShutdown(() => {
    log("\ncerrando…");
    ac.abort();
  });
  log("bot escuchando (Ctrl+C para salir)");
  try {
    await runBot(cfg, store, handlers, { log, signal: ac.signal });
  } finally {
    disarm();
    // Sin esto el panel se queda escuchando cuando el bot ya corto: el proceso
    // sobrevive al Ctrl+C, se lleva el puerto y el `npm run bot` siguiente
    // muere con EADDRINUSE contra una instancia que ya nadie ve.
    await closeServer(server);
  }
}

/**
 * Instala el apagado por senal y devuelve la funcion para desarmarlo.
 *
 * Registrar SIGINT saca el comportamiento default de node (morirse), asi que
 * a partir de aca cerrar es responsabilidad nuestra. Dos redes de contencion:
 * un segundo Ctrl+C sale ya, y si en 20s el cierre no termino salimos igual —
 * cortar una tarea a medias es mejor que dejar un proceso invisible con el
 * puerto tomado.
 */
function onShutdown(stop) {
  let stopping = false;
  const handler = () => {
    if (stopping) {
      log("\nsalida forzada");
      return process.exit(130);
    }
    stopping = true;
    setTimeout(() => {
      log("el cierre esta tardando; salgo igual");
      process.exit(130);
    }, 20_000).unref();
    Promise.resolve(stop()).catch((err) => {
      console.error(`error cerrando: ${err?.message ?? err}`);
      process.exit(1);
    });
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

/**
 * close() deja de aceptar conexiones nuevas pero espera a las abiertas, y el
 * navegador con el panel abierto mantiene un keep-alive: solo con close() el
 * proceso no termina nunca.
 */
function closeServer(server) {
  if (!server?.close) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

// Handlers de negocio que el bot invoca. El bot parsea y valida; la logica vive aca.
async function buildHandlers(cfg, store) {
  const { planCalendar } = await import("./lib/calendar.mjs");
  const { generateWithRetry, generatePending, rescueStuck } = await import("./lib/generate.mjs");
  const { deliverItem } = await import("./lib/telegram.mjs");
  const { createBrand, reviseBrand } = await import("./lib/brand.mjs");
  const { syncAll } = await import("./lib/knowledge.mjs");
  const { telegramConfigurado } = await import("./lib/settings.mjs");

  const marcaActual = () => store.defaultBrand()?.id ?? null;

  return {
    today: () => store.listItems({ from: today(), to: today(), brandId: marcaActual() }),
    pending: () =>
      store.listItems({ status: ["planned", "briefed", "building", "built"], brandId: marcaActual() }),
    plan: async (days = 14, from, brandId) =>
      planCalendar(cfg, store, { days, from: from || today(), brandId: brandId ?? marcaActual(), log }),
    // El bot pide "generar" y espera recibir la pieza por Telegram, asi que
    // entregar es el default. El panel, que tiene su propio boton de enviar,
    // pide explicitamente que no entregue.
    generate: async (id, { entregar = true } = {}) => {
      const r = await generateWithRetry(cfg, store, id, { log });
      // Telegram es opcional: sin configurar, la pieza vive en el panel y no
      // tiene sentido fallar por no poder mandarla a ningun lado.
      if (entregar && telegramConfigurado(cfg)) await deliverItem(cfg, store, id);
      return r;
    },
    entregar: async (id) => deliverItem(cfg, store, id),
    crearMarca: async (opts) => createBrand(cfg, store, { ...opts, log }),
    revisarMarca: async (id, feedback) => reviseBrand(cfg, store, id, feedback, { log }),
    sincronizar: async (brandId) => syncAll(cfg, store, { log, brandId: brandId ?? marcaActual() }),
    generatePending: async (limit = 3) => generatePending(cfg, store, { limit, log }),
    // "generar todo lo pendiente" (el boton del panel): genera respetando
    // cfg.limits.maxConcurrentGenerations y entrega lo que quedo listo. Una
    // entrega que falla no puede tumbar a las demas: queda anotada en el item.
    //
    // Dos cosas que antes se hacian de mas y nadie habia pedido: generaba las
    // piezas de TODAS las marcas aunque el boton viviera en el calendario de
    // una, y al terminar mandaba a Telegram todo lo que estuviera en "built",
    // incluyendo piezas viejas de otras marcas que estaban ahi a proposito. Se
    // entrega unicamente lo que ESTA corrida genero.
    generateAll: async (limit = 20, brandId = null) => {
      const res = await generatePending(cfg, store, { limit, brandId, log });
      if (!telegramConfigurado(cfg)) return res;
      for (const r of res) {
        if (!r?.ok || !r.itemId) continue;
        const it = store.getItem(r.itemId);
        if (it?.status !== "built") continue;
        try {
          await deliverItem(cfg, store, it.id);
        } catch (err) {
          const detail = String(err?.message ?? err).slice(0, 300);
          store.setStatus(it.id, "built", { error: `entrega fallida: ${detail}` });
          log(`  ! entrega ${it.id}: ${detail}`);
        }
      }
      return res;
    },
    // Edicion a mano desde el panel. La validacion (formato/idioma contra la
    // config, fecha ISO) la hace quien llama: aca solo se persiste.
    update: (id, patch) => store.updateItem(id, patch),
    create: (item) => store.upsertItem(item),
    remove: (id) => store.deleteItem(id),
    // Items que quedaron en building porque murio la corrida que los generaba.
    rescue: () => rescueStuck(store, { log, staleSeconds: cfg.limits?.jobStaleSeconds }),
    approve: (id) => store.setStatus(id, "approved"),
    reject: async (id, feedback) => {
      const item = store.getItem(id);
      if (!item) throw new Error(`no existe el item ${id}`);
      if (item.revision >= cfg.limits.maxRegenerationsPerItem) {
        throw new Error(
          `${id} ya se regenero ${item.revision} veces (limite ${cfg.limits.maxRegenerationsPerItem})`,
        );
      }
      const rev = store.bumpRevision(id, feedback);
      const r = await generateWithRetry(cfg, store, id, { log });
      if (telegramConfigurado(cfg)) await deliverItem(cfg, store, id);
      return { revision: rev, ...r };
    },
    costs: (days = 30) => store.costSummary(days),
    getItem: (id) => store.getItem(id),
  };
}

async function runCycle(cfg, store, flags) {
  const { syncAll } = await import("./lib/knowledge.mjs");
  const { planCalendar } = await import("./lib/calendar.mjs");
  const { generatePending } = await import("./lib/generate.mjs");
  const { deliverItem } = await import("./lib/telegram.mjs");

  log("1/4 sync");
  await syncAll(cfg, store, { log });

  const horizon = addDays(today(), 3);
  const upcoming = store.listItems({ from: today(), to: horizon });
  if (upcoming.length < 2) {
    log("2/4 plan (quedan menos de 2 piezas en los proximos 3 dias)");
    await planCalendar(cfg, store, { days: Number(flags.days ?? 14), from: today(), log });
  } else {
    log(`2/4 plan — omitido, ya hay ${upcoming.length} pieza(s) proximas`);
  }

  log("3/4 generate");
  await generatePending(cfg, store, { limit: Number(flags.limit ?? 3), log });

  const { telegramConfigurado } = await import("./lib/settings.mjs");
  if (!telegramConfigurado(cfg)) {
    log("4/4 deliver — omitido: Telegram no esta configurado (las piezas quedan en el panel)");
    return;
  }
  log("4/4 deliver");
  const built = store.listItems({ status: "built" });
  for (const it of built) {
    await deliverItem(cfg, store, it.id);
    log(`  enviado: ${it.id}`);
  }
  if (!built.length) log("  nada para enviar");
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}`);
  if (env("DEBUG")) console.error(err.stack);
  process.exitCode = 1;
});
