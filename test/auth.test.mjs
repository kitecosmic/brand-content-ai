// Cuentas, sesiones, invitaciones y roles.
//
// Se prueba contra el panel de verdad (startWeb en un puerto libre) porque lo
// que importa no es que las funciones devuelvan lo correcto, sino que NO se
// pueda entrar sin cuenta, que un miembro no pueda tocar los ajustes y que
// sacar a alguien le corte el acceso en el acto.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/lib/store.mjs";
import {
  aceptarInvitacion,
  crearCuenta,
  crearInvitacion,
  esUltimoOwner,
  firmarSesion,
  hashPassword,
  revisarInvitacion,
  usuarioDeSesion,
  validarPassword,
  verifyPassword,
} from "../src/lib/auth.mjs";
import { startWeb } from "../src/lib/web.mjs";

let root;
let store;
let server;
let base;

const CFG = {
  formats: { text: { enabled: true, kind: "text", maxChars: 600 } },
  limits: { jobStaleSeconds: 120, maxConcurrentGenerations: 2 },
  web: { port: 0 },
  models: { digest: "stub" },
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), "bca-auth-"));
  // El panel lee la config real por loadConfig() en algunas rutas; con un .env
  // vacio nos aseguramos de que no herede secretos de la maquina.
  writeFileSync(join(root, "vacio.env"), "# vacio\n");
  process.env.ADSAI_ENV_FILE = join(root, "vacio.env");
  delete process.env.ADSAI_PANEL_PASSWORD;

  store = openStore(join(root, "data", "brand-content-ai.db"));
  server = await startWeb(CFG, store, {}, { port: 4382, log: () => {} });
  base = "http://127.0.0.1:4382";
});

after(() => {
  try {
    server?.closeAllConnections?.();
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

const get = (ruta, cookie) =>
  fetch(base + ruta, { redirect: "manual", headers: cookie ? { cookie } : {} });
const post = (ruta, datos, cookie) =>
  fetch(base + ruta, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: base,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(datos).toString(),
  });
const galleta = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];

// ---------------------------------------------------------------------------
// Contrasenas
// ---------------------------------------------------------------------------

test("la contrasena se guarda hasheada y se verifica", () => {
  const h = hashPassword("una frase larga y facil");
  assert.ok(!h.includes("una frase"), "el hash no puede contener la contrasena");
  assert.ok(verifyPassword("una frase larga y facil", h));
  assert.ok(!verifyPassword("otra cosa", h));
  assert.ok(!verifyPassword("", h));
  assert.notEqual(hashPassword("misma"), hashPassword("misma"), "cada hash lleva su salt");
});

test("validarPassword pide largo, no jeroglificos", () => {
  assert.match(validarPassword("corta"), /10 caracteres/);
  assert.match(validarPassword("1234567890123"), /solo numeros/);
  assert.equal(validarPassword("una frase larga"), null);
});

// ---------------------------------------------------------------------------
// El panel, de punta a punta
// ---------------------------------------------------------------------------

test("primera corrida: todo lleva a crear la cuenta", async () => {
  const r = await get("/crear");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/setup");
  const setup = await get("/setup");
  assert.match(await setup.text(), /Crear tu cuenta/);
});

test("la contrasena se escribe dos veces y tienen que coincidir", async () => {
  // La pantalla trae los dos campos y el boton para verla: sin recuperacion por
  // email, una contrasena mal tipeada deja a alguien afuera de su instalacion.
  const html = await (await get("/setup")).text();
  assert.match(html, /name="password2"/);
  assert.match(html, /Repetila/);
  assert.match(html, /data-ver=/, "hay boton para ver la contrasena");

  // Y el server no confia en el navegador.
  const r = await post("/setup", {
    email: "otro@marca.com",
    password: "una frase larga y facil",
    password2: "otra frase distinta",
  });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /iguales/);
});

test("la primera cuenta es duena y deja la sesion abierta", async () => {
  const corta = await post("/setup", { email: "joel@marca.com", password: "corta" });
  assert.equal(corta.status, 400, "una contrasena corta no crea cuenta");

  const r = await post("/setup", {
    name: "Joel",
    email: "joel@marca.com",
    password: "una frase larga y facil",
  });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/empezar", "cae en el tour");
  assert.ok(galleta(r).startsWith("bca_sesion="));
  assert.equal(store.countUsers(), 1);
  assert.equal(store.listUsers()[0].role, "owner");
});

test("sin sesion no se ve nada; con la contrasena correcta si", async () => {
  assert.equal((await get("/crear")).status, 303);
  assert.equal((await post("/login", { email: "joel@marca.com", password: "mal" })).status, 401);

  const r = await post("/login", { email: "joel@marca.com", password: "una frase larga y facil" });
  assert.equal(r.status, 303);
  const cookie = galleta(r);
  assert.equal((await get("/crear", cookie)).status, 200);
});

test("el asistente arranca en el paso pendiente y avanza al completarlo", async () => {
  const cookie = galleta(
    await post("/login", { email: "joel@marca.com", password: "una frase larga y facil" }),
  );
  // Sin ?paso cae en el primero que falta; el 0 es la bienvenida.
  let html = await (await get("/empezar", cookie)).text();
  assert.match(html, /paso 1 de 5/);
  assert.match(html, /Esto genera contenido con la identidad de tu marca/);

  html = await (await get("/empezar?paso=1", cookie)).text();
  assert.match(html, /Conecta el modelo/);
  assert.match(html, /API key/);
  assert.doesNotMatch(html, /Endpoint/, "el asistente no pregunta cosas avanzadas");

  // Guardar desde el asistente vuelve al asistente, no a la pantalla de ajustes.
  const guardado = await post(
    "/action/ajustes",
    { minimax_api_key: "una-key-cualquiera", back: "/empezar?paso=2" },
    cookie,
  );
  assert.match(guardado.headers.get("location") ?? "", /^\/empezar\?paso=2/);

  html = await (await get("/empezar?paso=1", cookie)).text();
  assert.match(html, /ya esta listo/, "el paso queda marcado");
});

test("invitar: link de un solo uso, y el invitado entra como miembro", async () => {
  const cookie = galleta(
    await post("/login", { email: "joel@marca.com", password: "una frase larga y facil" }),
  );
  const r = await post("/action/invitar", { email: "ana@marca.com", role: "member" }, cookie);
  const link = decodeURIComponent((r.headers.get("location") ?? "").split("invite=")[1] ?? "");
  assert.match(link, /\/invitacion\//);

  const token = link.split("/invitacion/")[1];
  assert.match(await (await get(`/invitacion/${token}`)).text(), /Sumate al equipo/);

  const alta = await post(`/invitacion/${token}`, { name: "Ana", password: "otra frase larga" });
  assert.equal(alta.status, 303);
  assert.equal(store.countUsers(), 2);
  assert.equal(store.getUserByEmail("ana@marca.com").role, "member");

  const repetido = await post(`/invitacion/${token}`, { name: "Otro", password: "otra frase larga" });
  assert.equal(repetido.status, 400, "el token no se puede reusar");
});

test("un miembro genera contenido pero no toca los ajustes ni invita", async () => {
  const cookie = galleta(await post("/login", { email: "ana@marca.com", password: "otra frase larga" }));

  assert.equal((await get("/crear", cookie)).status, 200, "puede crear");
  assert.match(await (await get("/ajustes", cookie)).text(), /lo maneja el duenio/);

  const intento = await post("/action/invitar", { email: "colado@marca.com" }, cookie);
  assert.match(decodeURIComponent(intento.headers.get("location") ?? ""), /duenio/);
  assert.equal(store.countUsers(), 2, "no se creo ninguna invitacion");

  const equipo = await (await get("/equipo", cookie)).text();
  assert.match(equipo, /Ana/);
  assert.doesNotMatch(equipo, /Generar link/, "no ve el formulario de invitar");
});

test("sacar a alguien le corta el acceso en el acto", async () => {
  const cookieOwner = galleta(
    await post("/login", { email: "joel@marca.com", password: "una frase larga y facil" }),
  );
  const cookieAna = galleta(await post("/login", { email: "ana@marca.com", password: "otra frase larga" }));
  assert.equal((await get("/crear", cookieAna)).status, 200);

  const ana = store.getUserByEmail("ana@marca.com");
  await post("/action/usuario-borrar", { id: ana.id }, cookieOwner);

  assert.equal(store.countUsers(), 1);
  assert.equal((await get("/crear", cookieAna)).status, 303, "la cookie ya no sirve");
});

// ---------------------------------------------------------------------------
// Reglas que no dependen del panel
// ---------------------------------------------------------------------------

test("una cookie manoseada no vale", () => {
  const s2 = openStore(join(root, "data", "otra.db"));
  const u = crearCuenta(s2, { email: "x@y.com", password: "una frase larga" });
  const buena = firmarSesion("secreto", u.id);

  assert.equal(usuarioDeSesion(s2, "secreto", buena)?.id, u.id);
  assert.equal(usuarioDeSesion(s2, "otro-secreto", buena), null, "firmada con otro secreto");
  assert.equal(usuarioDeSesion(s2, "secreto", buena.replace(/.$/, "0")), null, "firma cambiada");
  assert.equal(usuarioDeSesion(s2, "secreto", `${u.id}.${Date.now() - 1000}.x`), null, "vencida");
  assert.equal(usuarioDeSesion(s2, "secreto", ""), null);
  s2.close();
});

test("una invitacion vencida no sirve", () => {
  const s2 = openStore(join(root, "data", "tercera.db"));
  crearCuenta(s2, { email: "owner@y.com", password: "una frase larga" });
  const inv = crearInvitacion(s2, { email: "tarde@y.com", dias: -1 });
  const chequeo = revisarInvitacion(s2, inv.token);
  assert.equal(chequeo.ok, false);
  assert.match(chequeo.motivo, /vencio/);
  assert.throws(
    () => aceptarInvitacion(s2, inv.token, { password: "una frase larga" }),
    /vencio/,
  );
  s2.close();
});

test("la invitacion con email fija la identidad: no se entra con otro", () => {
  const s2 = openStore(join(root, "data", "cuarta.db"));
  crearCuenta(s2, { email: "owner@y.com", password: "una frase larga" });
  const inv = crearInvitacion(s2, { email: "ana@y.com" });
  const u = aceptarInvitacion(s2, inv.token, { email: "otro@y.com", password: "una frase larga" });
  assert.equal(u.email, "ana@y.com", "manda el email de la invitacion");
  s2.close();
});

test("no se puede quedar sin duenio", () => {
  const s2 = openStore(join(root, "data", "quinta.db"));
  const owner = crearCuenta(s2, { email: "owner@y.com", password: "una frase larga" });
  assert.equal(esUltimoOwner(s2, owner.id), true);

  const otro = crearCuenta(s2, { email: "dos@y.com", password: "una frase larga", role: "owner" });
  assert.equal(esUltimoOwner(s2, owner.id), false, "con dos duenios ya no es el ultimo");
  assert.equal(otro.role, "owner");
  s2.close();
});
