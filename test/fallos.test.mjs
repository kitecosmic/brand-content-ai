// Un trabajo de fondo que falla tiene que decirlo en la pantalla.
//
// El panel lanza el trabajo y contesta enseguida —crear una marca tarda un
// minuto y nadie va a mirar una request colgada— asi que el error llega despues,
// cuando ya no hay a quien contestarle. Durante un tiempo se iba al log del
// servidor y nada mas: la tarjeta de "creando una marca" desaparecia, la marca
// no estaba, y el motivo real vivia en un `docker compose logs` que nadie tiene
// por que ir a leer.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/lib/store.mjs";
import { startWeb } from "../src/lib/web.mjs";

const MOTIVO = "falta la API key del modelo: cargala en el panel (Ajustes) o en .env";

let root;
let store;
let server;
let base;
let cookie;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "bca-fallos-"));
  writeFileSync(join(root, "vacio.env"), "# vacio\n");
  process.env.BCA_ENV_FILE = join(root, "vacio.env");
  delete process.env.BCA_MINIMAX_API_KEY;
  delete process.env.ADSAI_MINIMAX_API_KEY;

  store = openStore(join(root, "data", "brand-content-ai.db"));
  server = await startWeb(
    { formats: {}, limits: {}, web: { port: 0 }, models: {} },
    store,
    {
      // El motor real explota asi cuando no hay modelo conectado.
      crearMarca: async () => {
        throw new Error(MOTIVO);
      },
    },
    { port: 4385, log: () => {} },
  );
  base = "http://127.0.0.1:4385";

  const alta = await post("/setup", {
    name: "Joel",
    email: "joel@marca.com",
    password: "una frase larga y facil",
  });
  cookie = (alta.headers.get("set-cookie") ?? "").split(";")[0];
});

after(() => {
  try {
    server?.closeAllConnections?.();
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

function post(ruta, datos, conCookie) {
  return fetch(base + ruta, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: base,
      ...(conCookie ? { cookie: conCookie } : {}),
    },
    body: new URLSearchParams(datos).toString(),
  });
}

const ver = async (ruta) => (await fetch(base + ruta, { headers: { cookie } })).text();

/** El trabajo corre de fondo: hay que darle su tiempo antes de mirar. */
async function esperarA(condicion, intentos = 40) {
  for (let i = 0; i < intentos; i++) {
    if (await condicion()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("crear una marca sin modelo lo avisa antes de intentar", async () => {
  assert.match(
    await ver("/marcas"),
    /Falta la API key del modelo/,
    "sin modelo, la pantalla lo dice sin que haya que probar",
  );
});

test("si el trabajo de fondo falla, el motivo aparece en la pantalla", async () => {
  const r = await post("/action/marca-nueva", { url: "https://ejemplo.com" }, cookie);
  assert.equal(r.status, 303, "el panel contesta enseguida y sigue trabajando de fondo");

  const aparecio = await esperarA(async () => (await ver("/marcas")).includes("El último intento falló"));
  assert.ok(aparecio, "el fallo nunca llego a la pantalla");
  assert.match(await ver("/marcas"), /falta la API key del modelo/, "y dice el motivo real");
});

test("el aviso se descarta y no vuelve solo", async () => {
  await post("/action/descartar-fallo", { clave: "__marca", back: "/marcas" }, cookie);
  assert.doesNotMatch(await ver("/marcas"), /El último intento falló/, "descartado, no vuelve");
});

test("no se puede usar el descarte para borrar cualquier cosa de la base", async () => {
  store.set("auth:session-secret", "un-secreto-que-tiene-que-sobrevivir");
  await post("/action/descartar-fallo", { clave: "auth:session-secret", back: "/marcas" }, cookie);
  assert.equal(
    store.get("auth:session-secret"),
    "un-secreto-que-tiene-que-sobrevivir",
    "solo se borran claves de tareas",
  );
});

test("Crear avisa que faltan las fuentes en vez de dejar fallar la pieza", async () => {
  // Una marca recien creada tiene su sitio como fuente, pero sin sincronizar.
  store.upsertBrand({ id: "keio", name: "Keio", palette: {}, languages: ["es"] });
  store.addSource({
    brandId: "keio",
    sourceId: "keio:site",
    kind: "url",
    ref: "https://keio.example/",
    label: "keio.example",
  });
  store.setDefaultBrand("keio");

  const html = await ver("/crear");
  assert.match(html, /Falta leer las fuentes de Keio/, "lo dice antes de que gastes el intento");
  assert.match(html, /action="\/action\/sync"/, "y con el boton para resolverlo ahi mismo");

  // Con los hechos ya sincronizados, el aviso no molesta mas.
  store.putKnowledge({
    sourceId: "keio:site",
    brandId: "keio",
    kind: "url",
    ref: "https://keio.example/",
    label: "keio.example",
    fingerprint: "abc",
    digest: "Keio vende eSIM.",
    facts: [{ claim: "Se activa en cinco minutos", source: "https://keio.example/" }],
  });
  assert.doesNotMatch(await ver("/crear"), /Falta leer las fuentes/, "sincronizada, el aviso se va");
});

test("mientras sincroniza, la pantalla de la marca se actualiza sola", async () => {
  // Un sync que tarda: lo que importa es lo que se ve mientras corre.
  let terminar;
  const enCurso = new Promise((r) => {
    terminar = r;
  });
  server.closeAllConnections?.();
  server.close();
  server = await startWeb(
    { formats: {}, limits: {}, web: { port: 0 }, models: {} },
    store,
    { sincronizar: async () => enCurso },
    { port: 4390, log: () => {} },
  );
  base = "http://127.0.0.1:4390";

  // El test de mas arriba piso el secreto de sesion en la base a proposito, asi
  // que este panel nuevo no reconoce la cookie vieja: hay que entrar de nuevo.
  const entrada = await post("/login", {
    email: "joel@marca.com",
    password: "una frase larga y facil",
    recordarme: "1",
  });
  cookie = (entrada.headers.get("set-cookie") ?? "").split(";")[0];

  await post("/action/sync", { brand: "keio", back: "/marcas/keio" }, cookie);
  const html = await ver("/marcas/keio");

  // El cartel es el que trae el data-vivo: sin el, la pagina se queda quieta y
  // no hay forma de enterarse de que ya termino.
  assert.match(html, /data-vivo="\/api\/marcas"/, "la pagina tiene que refrescarse sola");
  assert.match(html, /leyendo sus fuentes/, "y decir que esta haciendo");

  // Y la API que consulta ese cartel avisa que todavia no termino.
  const api = await (await fetch(`${base}/api/marcas`, { headers: { cookie } })).json();
  assert.equal(api.trabajando, true);
  assert.equal(api.recargar, false, "recargar recien cuando el trabajo termino");

  terminar();
  await new Promise((r) => setTimeout(r, 30));
  const despues = await (await fetch(`${base}/api/marcas`, { headers: { cookie } })).json();
  assert.equal(despues.recargar, true, "al terminar, la pagina se entera");
});
