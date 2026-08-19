// Ajustes: lo que se guarda desde el panel.
//
// El caso que motivó estos tests: alguien escribió el endpoint con `.com` en
// lugar de `.io`, el host no existe, y el sistema quedó devolviendo
// "fetch failed" sin ninguna pista de por qué.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/lib/store.mjs";
import {
  CAMPOS,
  aplicarAjustes,
  campoPorClave,
  estadoAjustes,
  guardarAjuste,
  leerAjustes,
  modeloConfigurado,
  pista,
  revisarValor,
  telegramConfigurado,
} from "../src/lib/settings.mjs";

const raices = [];
process.on("exit", () => {
  for (const r of raices) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {}
  }
});

function nuevoStore() {
  const root = mkdtempSync(join(tmpdir(), "bca-set-"));
  raices.push(root);
  return openStore(join(root, "data", "brand-content-ai.db"));
}

test("guardar un ajuste lo aplica al entorno en el acto", () => {
  const store = nuevoStore();
  delete process.env.BCA_MINIMAX_API_KEY;

  guardarAjuste(store, "minimax_api_key", "una-key");
  assert.equal(process.env.BCA_MINIMAX_API_KEY, "una-key");
  assert.equal(leerAjustes(store).minimax_api_key, "una-key");

  // Vaciarlo lo borra y devuelve el control al entorno.
  guardarAjuste(store, "minimax_api_key", "");
  assert.equal(process.env.BCA_MINIMAX_API_KEY, undefined);
  assert.equal(leerAjustes(store).minimax_api_key, undefined);
  store.close();
});

test("aplicarAjustes vuelca lo guardado y distingue de donde viene cada valor", () => {
  const store = nuevoStore();
  process.env.TELEGRAM_CHAT_ID = "del-env";
  delete process.env.BCA_MINIMAX_API_KEY;

  guardarAjuste(store, "minimax_api_key", "del-panel");
  aplicarAjustes(store);

  const estado = estadoAjustes(store);
  const key = estado.find((c) => c.clave === "minimax_api_key");
  const chat = estado.find((c) => c.clave === "telegram_chat_id");
  assert.equal(key.origen, "panel");
  assert.equal(chat.origen, "env");
  assert.equal(chat.pista, "del-env", "lo que no es secreto se muestra tal cual");
  assert.ok(!key.pista.includes("del-panel"), "un secreto nunca se muestra entero");
  delete process.env.TELEGRAM_CHAT_ID;
  store.close();
});

test("el endpoint con .com se corrige y se avisa", () => {
  const campo = campoPorClave("minimax_base_url");
  const r = revisarValor(campo, "https://api.minimax.com/anthropic/v1");
  assert.equal(r.valor, "https://api.minimax.io/anthropic/v1");
  assert.match(r.aviso, /no existe/);
});

test("los hosts validos de MiniMax pasan sin ruido", () => {
  const campo = campoPorClave("minimax_base_url");
  for (const url of [
    "https://api.minimax.io/anthropic/v1",
    "https://api.minimaxi.com/anthropic/v1",
  ]) {
    const r = revisarValor(campo, url);
    assert.equal(r.valor, url);
    assert.equal(r.aviso, null);
  }
});

test("un host desconocido pasa pero avisa; una URL invalida se rechaza", () => {
  const campo = campoPorClave("minimax_base_url");
  const r = revisarValor(campo, "https://mi-proxy.interno/anthropic/v1");
  assert.equal(r.valor, "https://mi-proxy.interno/anthropic/v1", "puede ser un proxy propio");
  assert.match(r.aviso, /no es un host conocido/);

  assert.throws(() => revisarValor(campo, "api.minimax.io"), /URL valida/);
  assert.throws(() => revisarValor(campo, "cualquier cosa"), /URL valida/);
});

test("pista muestra lo justo para reconocer un secreto", () => {
  assert.equal(pista(""), "");
  assert.equal(pista("corto"), "•••••");
  assert.match(pista("una-clave-larga-1234"), /^•+1234$/);
});

test("modeloConfigurado y telegramConfigurado miran lo que hace falta", () => {
  assert.equal(modeloConfigurado({ secrets: {} }), false);
  assert.equal(modeloConfigurado({ secrets: { minimaxApiKey: "x" } }), true);

  assert.equal(telegramConfigurado({ secrets: { telegramToken: "x" } }), false, "falta el chat");
  assert.equal(
    telegramConfigurado({ secrets: { telegramToken: "x", telegramChatId: "1" } }),
    true,
  );
});

test("los campos del asistente no incluyen las opciones avanzadas", () => {
  // El asistente pide solo la API key; endpoint, clave vieja y ffmpeg viven
  // plegados en Ajustes. Si alguien marca uno como no avanzado, este test avisa.
  const avanzados = CAMPOS.filter((c) => c.avanzado).map((c) => c.clave);
  assert.deepEqual(avanzados.sort(), ["ffmpeg", "minimax_base_url", "panel_password"]);
});
