import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createIxcFetcher, resolveIxcHttpMethod } from "../lib/integrations/ixc/http.ts";

function withServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("método padrão é GET; só POST explícito muda", () => {
  assert.equal(resolveIxcHttpMethod(undefined), "GET");
  assert.equal(resolveIxcHttpMethod(""), "GET");
  assert.equal(resolveIxcHttpMethod("get"), "GET");
  assert.equal(resolveIxcHttpMethod("qualquer coisa"), "GET");
  assert.equal(resolveIxcHttpMethod("post"), "POST");
  assert.equal(resolveIxcHttpMethod(" POST "), "POST");
});

test("GET leva corpo JSON — o que o fetch nativo proíbe", async () => {
  const received = {};
  const { server, port } = await withServer((request, response) => {
    received.method = request.method;
    received.headers = request.headers;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.body = Buffer.concat(chunks).toString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ page: "1", total: "1", registros: [{ id: "1" }] }));
    });
  });

  try {
    const fetcher = createIxcFetcher("GET");
    const response = await fetcher(`http://127.0.0.1:${port}/webservice/v1/cliente`, {
      method: "POST", // o provider pede POST; o transporte converte para GET
      headers: { "Content-Type": "application/json", ixcsoft: "listar", Authorization: "Basic abc" },
      body: JSON.stringify({ qtype: "cliente.id", query: "1" }),
    });

    assert.equal(response.status, 200);
    assert.equal(received.method, "GET", "o IXC exige GET");
    assert.equal(received.headers.ixcsoft, "listar");
    assert.equal(received.headers.authorization, "Basic abc");
    assert.deepEqual(JSON.parse(received.body), { qtype: "cliente.id", query: "1" });
    assert.deepEqual(await response.json(), { page: "1", total: "1", registros: [{ id: "1" }] });
  } finally {
    server.close();
  }
});

test("erro HTTP do IXC chega como status, não como exceção", async () => {
  const { server, port } = await withServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => { response.writeHead(401); response.end("nao autorizado"); });
  });
  try {
    const response = await createIxcFetcher("GET")(`http://127.0.0.1:${port}/x`, { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

test("abort derruba a conexão para o timeout do provider funcionar", async () => {
  const { server, port } = await withServer((request) => {
    request.on("data", () => {});
    // Nunca responde: só o abort encerra.
  });
  try {
    const controller = new AbortController();
    const pending = createIxcFetcher("GET")(`http://127.0.0.1:${port}/x`, { method: "POST", body: "{}", signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (error) => error.name === "AbortError" || error.code === "ECONNRESET");
  } finally {
    server.close();
  }
});

test("POST usa o fetch nativo sem alterar o método", async () => {
  const received = {};
  const { server, port } = await withServer((request, response) => {
    received.method = request.method;
    request.on("data", () => {});
    request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
  });
  try {
    await createIxcFetcher("POST")(`http://127.0.0.1:${port}/x`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(received.method, "POST");
  } finally {
    server.close();
  }
});
