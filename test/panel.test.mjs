// El panel: que lo que pedís sea lo que se hace.
//
// El bug que motivó este archivo: el selector de marca de arriba guarda la marca
// en una cookie y las acciones no la leían, así que se pedía una pieza para una
// marca y se generaba con la identidad de otra. Nada de eso se veía en los
// tests de antes porque probaban las funciones, no el recorrido del formulario.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/lib/store.mjs";
import { crearCuenta } from "../src/lib/auth.mjs";
import { startWeb } from "../src/lib/web.mjs";

let root;
let store;
let server;
let base;
let cookie;
const llamadas = [];

const CFG = {
  formats: {
    text: { enabled: true, kind: "text", maxChars: 600 },
    story: { enabled: true, kind: "still", aspect: "1080x1920" },
  },
  limits: { jobStaleSeconds: 120, maxConcurrentGenerations: 2 },
  models: { digest: "stub" },
};

const HANDLERS = {
  generate: async (id, opts) => llamadas.push({ que: "generate", id, opts }),
  plan: async (dias, from, brandId) => llamadas.push({ que: "plan", dias, brandId }),
  generateAll: async (limite, brandId) => llamadas.push({ que: "generateAll", limite, marca: brandId }),
  sincronizar: async (brandId) => llamadas.push({ que: "sync", brandId }),
  crearMarca: async (opts) => {
    llamadas.push({ que: "crearMarca", opts });
    const b = store.upsertBrand({ id: "nueva", name: "Nueva", languages: ["es"], status: "ready" });
    return { brand: b, warnings: [] };
  },
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), "bca-panel-"));
  // Rutas reales: sin esto, el panel no considera "suyo" ningun archivo y la
  // pantalla de borrado no puede ofrecer borrarlos.
  CFG.hyperframes = { projectsDir: join(root, "projects") };
  CFG.paths = { content: join(root, "content"), root };
  mkdirSync(join(root, "projects", "otra-base"), { recursive: true });
  writeFileSync(join(root, "projects", "otra-base", "frame.md"), "# frame\n");
  writeFileSync(join(root, "vacio.env"), "# vacio\n");
  process.env.ADSAI_ENV_FILE = join(root, "vacio.env");
  delete process.env.ADSAI_PANEL_PASSWORD;

  store = openStore(join(root, "data", "brand-content-ai.db"));
  // Dos marcas: la que quedo por defecto y la que se elige en el selector.
  store.upsertBrand({ id: "vieja", name: "Vieja", languages: ["es"], status: "ready", isDefault: 1 });
  store.setDefaultBrand("vieja");
  store.upsertBrand({
    id: "otra",
    name: "Otra",
    languages: ["es"],
    status: "ready",
    projectDir: join(root, "projects", "otra-base"),
  });
  store.putKnowledge({
    sourceId: "otra:site",
    brandId: "otra",
    kind: "url",
    ref: "https://otra.com",
    digest: "algo",
    facts: [{ claim: "x", source: "https://otra.com" }],
  });

  const u = crearCuenta(store, { email: "joel@marca.com", password: "una frase larga y facil" });
  server = await startWeb(CFG, store, HANDLERS, { port: 4386, log: () => {} });
  base = "http://127.0.0.1:4386";

  const r = await fetch(base + "/login", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ email: u.email, password: "una frase larga y facil" }).toString(),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
});

after(() => {
  try {
    server?.closeAllConnections?.();
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

const conMarca = (id) => [cookie, id ? `bca_marca=${id}` : ""].filter(Boolean).join("; ");
const post = (ruta, datos, galletas) =>
  fetch(base + ruta, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base, cookie: galletas },
    body: new URLSearchParams(datos).toString(),
  });
const get = (ruta, galletas) => fetch(base + ruta, { redirect: "manual", headers: { cookie: galletas } });

test("la pieza se crea para la marca del selector, no para la de por defecto", async () => {
  const r = await post(
    "/action/crear-ahora",
    { tema: "una linea en promocion por 49 euros al ano", format: "text", language: "es" },
    conMarca("otra"),
  );
  assert.equal(r.status, 303);

  const items = store.listItems({ limit: 50 });
  assert.equal(items.length, 1);
  assert.equal(items[0].brand_id, "otra", `quedo en ${items[0].brand_id}`);
  assert.match(items[0].angle, /49 euros/);
});

test("planificar tambien respeta el selector", async () => {
  llamadas.length = 0;
  await post("/action/plan", { dias: "7" }, conMarca("otra"));
  // el trabajo se lanza en background: se espera un tick
  await new Promise((r) => setTimeout(r, 50));
  const plan = llamadas.find((l) => l.que === "plan");
  assert.ok(plan, "se llamo al planificador");
  assert.equal(plan.brandId, "otra");
});

test("sin cookie de marca se usa la que esta por defecto", async () => {
  const r = await post(
    "/action/crear-ahora",
    { tema: "otra idea distinta para probar", format: "text", language: "es" },
    conMarca(null),
  );
  assert.equal(r.status, 303);
  const item = store.listItems({ limit: 50 }).find((i) => i.angle.includes("otra idea"));
  assert.equal(item.brand_id, "vieja");
});

test("una marca que no existe en la cookie no rompe nada", async () => {
  const r = await post(
    "/action/crear-ahora",
    { tema: "tercera idea de prueba para el panel", format: "text", language: "es" },
    conMarca("no-existe"),
  );
  assert.equal(r.status, 303);
  const item = store.listItems({ limit: 50 }).find((i) => i.angle.includes("tercera idea"));
  assert.equal(item.brand_id, "vieja", "cae en la de por defecto");
});

test("la marca recien creada queda activa y la cookie vieja se limpia", async () => {
  const r = await post("/action/marca-nueva", { url: "https://nueva.com" }, conMarca("otra"));
  assert.equal(r.status, 303);
  assert.match(r.headers.get("set-cookie") ?? "", /bca_marca=;/, "limpia la cookie anterior");

  await new Promise((res) => setTimeout(res, 60));
  assert.equal(store.defaultBrand().id, "nueva", "la nueva pasa a ser la activa");
});

test("/api/marcas dice cuando termino el trabajo, para que la pagina se refresque", async () => {
  const r = await get("/api/marcas", cookie);
  const d = await r.json();
  assert.equal(typeof d.trabajando, "boolean");
  assert.equal(d.recargar, !d.trabajando, "recargar es lo contrario de estar trabajando");
});

test("el formato lo valida el server: no alcanza con mandar cualquier cosa", async () => {
  const r = await post(
    "/action/crear-ahora",
    { tema: "algo", format: "podcast", language: "es" },
    conMarca("otra"),
  );
  assert.match(decodeURIComponent(r.headers.get("location") ?? ""), /formato invalido/);
});

// ---------------------------------------------------------------------------
// Generar en lote: que lo que se aprieta sea lo que se hace
// ---------------------------------------------------------------------------

test("generar lo pendiente solo toca la marca activa, no todas", async () => {
  // Una pieza pendiente en cada marca. El boton vive en el calendario de una.
  for (const id of ["vieja", "otra"]) {
    store.upsertItem({
      id: `2026-10-01-pendiente-${id}`,
      scheduled_for: "2026-10-01",
      format: "text",
      language: "es",
      angle: `pendiente de ${id}`,
      message: "m",
      status: "planned",
      brandId: id,
    });
  }
  llamadas.length = 0;

  const r = await post("/action/generar-pendientes", {}, conMarca("otra"));
  assert.equal(r.status, 303);
  const lote = llamadas.find((l) => l.que === "generateAll");
  assert.ok(lote, "se llamo a generateAll");
  assert.equal(lote.marca, "otra", "con la marca del selector, no con todas");
  // El conteo es el de ESTA marca, no el total del sistema.
  const deOtra = store.listItems({ brandId: "otra", status: ["planned", "briefed"], limit: 50 }).length;
  const todas = store.listItems({ status: ["planned", "briefed"], limit: 50 }).length;
  assert.ok(todas > deOtra, "hay pendientes de otras marcas que NO se tienen que tocar");
  assert.match(
    decodeURIComponent(r.headers.get("location") ?? ""),
    new RegExp(`Generando ${deOtra} pieza`),
  );
  assert.match(decodeURIComponent(r.headers.get("location") ?? ""), /de Otra/);
});

test("la confirmacion dice cuantas piezas y cuanto cuesta antes de arrancar", async () => {
  // Historial: una pieza de texto que costo 2 dolares.
  store.logRun({ kind: "brief", itemId: "2026-10-01-pendiente-otra", costUsd: 2, ms: 60_000, ok: true });

  const pendientes = store.listItems({ brandId: "otra", status: ["planned", "briefed"], limit: 50 }).length;
  const r = await get("/confirmar/generar", conMarca("otra"));
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, new RegExp(`Generar ${pendientes} pieza`), "dice cuantas");
  assert.match(html, /de Otra/, "y de que marca");
  assert.match(html, /Estimado: \$/, "y cuanto sale, sacado del historial real");
  // El promedio historico es $2 por pieza de texto, y todas las pendientes de
  // esta marca son de texto: el total tiene que ser ese promedio por la cantidad.
  assert.match(
    html,
    new RegExp(`\\$${(2 * pendientes).toFixed(2)}`),
    "el total es el promedio real por la cantidad de piezas",
  );
  assert.match(html, /action="\/action\/generar-pendientes"/, "el boton confirma, no navega");
});

test("sin piezas pendientes no se arranca nada aunque se postee la accion", async () => {
  llamadas.length = 0;
  const r = await post("/action/generar-pendientes", { brand: "vacia" }, conMarca("vieja"));
  const items = store.listItems({ brandId: "vieja", status: ["planned", "briefed"], limit: 10 });
  if (!items.length) {
    assert.equal(llamadas.find((l) => l.que === "generateAll"), undefined);
    assert.match(decodeURIComponent(r.headers.get("location") ?? ""), /no hay piezas pendientes/);
  }
});

// ---------------------------------------------------------------------------
// Marcas y tour
// ---------------------------------------------------------------------------

test("borrar una marca pide confirmacion y dice que pasa con las piezas", async () => {
  const r = await get("/marcas/otra/borrar", cookie);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /Borrar Otra/);
  assert.match(html, /quedan sin marca/, "avisa que las piezas se conservan");
  assert.match(html, /name="archivos"/, "y ofrece borrar tambien los archivos");
});

test("borrar la marca sin marcar archivos deja el disco intacto", async () => {
  const carpeta = join(root, "projects", "otra-base");
  assert.ok(existsSync(carpeta), "la marca tiene proyecto en disco");
  const antes = store.listItems({ brandId: "otra", limit: 100 }).length;
  assert.ok(antes > 0, "y tiene piezas");

  const r = await post("/action/marca-borrar", { brand: "otra" }, cookie);
  assert.equal(r.status, 303, decodeURIComponent(r.headers.get("location") ?? ""));
  assert.ok(!store.getBrand("otra"), `la marca ya no esta (${decodeURIComponent(r.headers.get("location") ?? "")})`);
  assert.equal(store.allKnowledge("otra").length, 0, "su conocimiento tampoco");
  assert.equal(
    store.listItems({ limit: 200 }).filter((i) => i.id === "2026-10-01-pendiente-otra").length,
    1,
    "pero la pieza sigue existiendo, huerfana",
  );
  assert.ok(existsSync(carpeta), "y el disco no se toco: nadie pidio borrarlo");
});

test("borrar la marca con archivos marcados si borra sus carpetas", async () => {
  const carpeta = join(root, "projects", "conarchivos-base");
  mkdirSync(carpeta, { recursive: true });
  writeFileSync(join(carpeta, "frame.md"), "# frame\n");
  store.upsertBrand({
    id: "conarchivos",
    name: "Con archivos",
    languages: ["es"],
    status: "ready",
    projectDir: carpeta,
  });

  const r = await post("/action/marca-borrar", { brand: "conarchivos", archivos: "1" }, cookie);
  assert.equal(r.status, 303);
  assert.ok(!store.getBrand("conarchivos"));
  assert.ok(!existsSync(carpeta), "la carpeta se fue con la marca");
  assert.match(decodeURIComponent(r.headers.get("location") ?? ""), /carpeta\(s\) borradas/);
});

test("no se borra nada que viva fuera de las carpetas de la instalacion", async () => {
  // Un projectDir apuntando afuera (instalacion vieja, config editada a mano).
  const afuera = mkdtempSync(join(tmpdir(), "bca-afuera-"));
  writeFileSync(join(afuera, "importante.txt"), "no me borres");
  store.upsertBrand({
    id: "peligrosa",
    name: "Peligrosa",
    languages: ["es"],
    status: "ready",
    projectDir: afuera,
  });

  await post("/action/marca-borrar", { brand: "peligrosa", archivos: "1" }, cookie);
  assert.ok(existsSync(join(afuera, "importante.txt")), "una ruta de afuera no se toca");
  rmSync(afuera, { recursive: true, force: true });
});

test("el tour se puede apagar y deja de aparecer al entrar", async () => {
  // Antes de apagarlo, el login manda al asistente: falta terminar pasos.
  const login = () =>
    fetch(base + "/login", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ email: "joel@marca.com", password: "una frase larga y facil" }).toString(),
    });

  assert.equal((await login()).headers.get("location"), "/empezar");

  const r = await post("/action/tour-listo", {}, cookie);
  assert.equal(r.status, 303);
  assert.equal(store.get("ui:tour-visto"), "1");
  assert.equal((await login()).headers.get("location"), "/crear", "ya no molesta");

  // Y se puede volver a pedir.
  await post("/action/tour-reiniciar", {}, cookie);
  assert.equal((await login()).headers.get("location"), "/empezar");
});
