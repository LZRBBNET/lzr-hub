import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { diagnosticAuthorization, withDiagnosticAuthorization } from "../lib/integrations/ixc/diagnostic-authorization.ts";
import { createIxcDiagnosticFetcher } from "../lib/integrations/ixc/http.ts";

// Explicitly synthetic authorization markers, not examples of the platform's placeholder syntax.
const marker = "SYNTHETIC-NOT-A-NETWORK-SECRET";
const invalid = [undefined, "", " ", "SYNTHETIC\rNOT-A-SECRET", "SYNTHETIC\nNOT-A-SECRET", "SYNTHETIC-INVALID-" + "X".repeat(512)];
const command = ["--experimental-strip-types", new URL("../scripts/diagnose-ixc-direct.mjs", import.meta.url).pathname];

test("authorization syntax refuses absent, empty, CR/LF and oversized values", () => {
  for (const value of invalid) {
    let refused = false;
    try { diagnosticAuthorization({ IXC_DIRECT_AUTHORIZATION: value }); }
    catch (error) { refused = error instanceof Error && error.message === "IXC_DIAGNOSTIC_AUTHORIZATION_UNCONFIRMED"; }
    assert.ok(refused, "EXPECTED_SANITIZED_REFUSAL");
  }
  assert.ok(diagnosticAuthorization({ IXC_DIRECT_AUTHORIZATION: marker }) === marker, "VALUE_CHANGED");
});

test("real loopback GET preserves the opaque header exactly without Basic or Base64", async () => {
  const sockets = new Set(); let received; let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    received = { value: req.headers.authorization, count: req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === "authorization").length, method: req.method };
    req.resume(); req.on("end", () => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("transport-only"); });
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const value of [marker, "Basic SYNTHETIC-NOT-A-REAL-CREDENTIAL"]) {
      const transport = withDiagnosticAuthorization(createIxcDiagnosticFetcher({ origin, paths: ["/transport"], timeoutMs: 1000, maxRequestBytes: 128, maxResponseBytes: 128 }), value);
      const response = await transport(origin + "/transport", { method: "POST", body: "transport-only", headers: { Authorization: "Basic " } });
      await response.text();
      assert.ok(response.status === 200 && received.value === value && received.count === 1 && received.method === "GET", "WIRE_AUTHORIZATION_CHANGED");
    }
    assert.ok(requests === 2, "UNEXPECTED_REQUEST_COUNT");
  } finally {
    const closing = [...sockets].map(socket => new Promise(resolve => socket.once("close", resolve)));
    let timer;
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("CLEANUP_TIMEOUT")), 1000); });
      server.closeAllConnections();
      await Promise.race([Promise.all([...closing, new Promise(resolve => server.close(resolve))]), deadline]);
    } finally { clearTimeout(timer); }
    assert.ok(!server.listening && sockets.size === 0, "LISTENER_OR_SOCKET_REMAINED");
  }
});

test("real CLI refusals do not disclose markers in stdout, stderr or argv", () => {
  for (const value of [...invalid, marker]) {
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", IXC_DIRECT_READ_APPROVED: "true" };
    if (value !== undefined) env.IXC_DIRECT_AUTHORIZATION = value;
    const result = spawnSync(process.execPath, command, { env, input: "", encoding: "utf8", timeout: 3000 });
    assert.ok(!result.error && result.status === 78 && result.stderr === "", "CLI_REFUSAL_FAILED");
    const parsed = JSON.parse(result.stdout);
    const category = value === marker ? "transport-configuration" : "authorization-configuration";
    assert.ok(parsed.event === "ixc.directDiagnostic" && parsed.outcome === "refused" && parsed.category === category, "WRONG_REFUSAL_CATEGORY");
    if (value) assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value) && !command.some(arg => arg.includes(value)), "MARKER_DISCLOSED");
  }
});
