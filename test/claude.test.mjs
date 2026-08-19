// Tests del wrapper del backend. Levantan un server HTTP local y le apuntan
// `baseUrl`: nada sale a internet y no hace falta una api key real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { runClaude, runClaudeJSON, extractJSON, ClaudeError } from "../src/lib/claude.mjs";

/**
 * Levanta un server que responde segun `handler(req, n)` donde `n` es el numero
 * de pedido (1-based). Devuelve { baseUrl, calls, close }.
 */
async function fakeApi(handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ headers: req.headers, body: JSON.parse(body || "{}") });
    handler(res, calls.length);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

const ok = (text = "listo", usage = {}) =>
  JSON.stringify({
    id: "msg_1",
    model: "MiniMax-M3",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5, ...usage },
  });

test("runClaude manda el prompt al endpoint con las cabeceras de Anthropic", async () => {
  const api = await fakeApi((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(ok("pong"));
  });
  try {
    const r = await runClaude("ping", {
      model: "MiniMax-M3",
      apiKey: "k",
      baseUrl: api.baseUrl,
      files: { "nota.txt": "contenido inline" },
    });
    assert.equal(r.text, "pong");
    assert.equal(api.calls[0].headers.authorization, "Bearer k");
    assert.equal(api.calls[0].headers["anthropic-version"], "2023-06-01");
    // los archivos viajan dentro del prompt: no hay tools de filesystem
    assert.match(api.calls[0].body.messages[0].content, /contenido inline/);
    assert.match(api.calls[0].body.messages[0].content, /ping/);
  } finally {
    await api.close();
  }
});

test("runClaude reintenta un 429 y respeta retry-after", async () => {
  const api = await fakeApi((res, n) => {
    if (n === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      return res.end(JSON.stringify({ error: { message: "rate limited" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(ok("al segundo intento"));
  });
  try {
    const r = await runClaude("hola", { model: "MiniMax-M3", apiKey: "k", baseUrl: api.baseUrl });
    assert.equal(r.text, "al segundo intento");
    assert.equal(api.calls.length, 2);
  } finally {
    await api.close();
  }
});

test("runClaude NO reintenta un 400: el prompt no mejora repitiendolo", async () => {
  const api = await fakeApi((res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "model not found" } }));
  });
  try {
    await assert.rejects(
      runClaude("hola", { model: "no-existe", apiKey: "k", baseUrl: api.baseUrl }),
      (err) => {
        assert.ok(err instanceof ClaudeError);
        assert.equal(err.status, 400);
        assert.match(err.message, /model not found/);
        return true;
      },
    );
    assert.equal(api.calls.length, 1);
  } finally {
    await api.close();
  }
});

test("runClaude se rinde tras agotar los reintentos configurados", async () => {
  const api = await fakeApi((res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream caido" } }));
  });
  try {
    await assert.rejects(
      runClaude("hola", { model: "MiniMax-M3", apiKey: "k", baseUrl: api.baseUrl, retries: 1 }),
      /503/,
    );
    assert.equal(api.calls.length, 2, "un intento original + un reintento");
  } finally {
    await api.close();
  }
});

test("el costo cuenta los tokens servidos desde cache, que la API reporta aparte", async () => {
  const api = await fakeApi((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(ok("hecho", { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000 }));
  });
  try {
    const r = await runClaude("hola", { model: "MiniMax-M3", apiKey: "k", baseUrl: api.baseUrl });
    assert.equal(r.cacheReadTokens, 1000);
    // pricing real de la config: 0.0003 in + 0.0012 out + 0.00006 cache, por 1K
    // (el wrapper redondea a 6 decimales, si no arrastra el ruido del float)
    assert.equal(r.costUsd, 0.00156);
  } finally {
    await api.close();
  }
});

test("runClaudeJSON avisa cuando el JSON quedo cortado por max_tokens", async () => {
  const api = await fakeApi((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "m",
        model: "MiniMax-M3",
        content: [{ type: "text", text: '{"a": 1, "b":' }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  try {
    await assert.rejects(
      runClaudeJSON("dame json", { model: "MiniMax-M3", apiKey: "k", baseUrl: api.baseUrl }),
      /max_tokens/,
    );
  } finally {
    await api.close();
  }
});

test("runClaude explica el error de DNS en vez de dejar 'fetch failed'", async () => {
  await assert.rejects(
    runClaude("hola", {
      model: "MiniMax-M3",
      apiKey: "k",
      baseUrl: "https://api.minimax.com.no-existe-de-verdad/v1",
      retries: 0,
    }),
    (err) => {
      assert.match(err.message, /api\.minimax\.io\/anthropic\/v1/);
      return true;
    },
  );
});

test("extractJSON tolera prosa alrededor y bloques de codigo", () => {
  assert.deepEqual(extractJSON('aca va: {"a":1} y listo'), { a: 1 });
  assert.deepEqual(extractJSON("```json\n[1,2]\n```"), [1, 2]);
  assert.equal(extractJSON("sin json"), undefined);
});
