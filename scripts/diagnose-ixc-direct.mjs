import { readFileSync, lstatSync } from "node:fs";
import { Agent } from "node:https";
import { rootCertificates } from "node:tls";
import { X509Certificate } from "node:crypto";
import { diagnosticAuthorization, withDiagnosticAuthorization } from "../lib/integrations/ixc/diagnostic-authorization.ts";
import { createIxcDiagnosticFetcher } from "../lib/integrations/ixc/http.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { createPaymentDiagnostic } from "../lib/integrations/ixc/payment-diagnostics.ts";

// No dotenv/DB/global runtime; authorization origin is not inferred from its value.
const emit = (value) => console.info(JSON.stringify(value));
const refuse = () => {
  emit({ event: "ixc.directDiagnostic", version: 1, outcome: "refused", category: "configuration" });
  process.exitCode = 78;
};
async function readConfiguration() {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const cleanup = () => { clearTimeout(timer); process.stdin.removeAllListeners("data"); process.stdin.removeAllListeners("end"); process.stdin.pause(); };
    const invalid = () => { cleanup(); reject(new Error("CONFIGURATION")); };
    const timer = setTimeout(invalid, 2000);
    process.stdin.on("error", invalid);
    process.stdin.on("data", chunk => {
      size += chunk.length;
      if (size > 4096) { invalid(); return; }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("CONFIGURATION")); }
    });
    process.stdin.resume();
  });
}
const fields = ["id", "id_cliente", "id_receber", "id_fatura", "valor", "credito", "data", "data_pagamento", "tipo_recebimento"];
function shape(body) {
  const rows = Array.isArray(body?.registros) ? body.registros : [];
  const types = {};
  for (const field of fields) {
    const observed = new Set();
    for (const row of rows) if (row && typeof row === "object" && Object.hasOwn(row, field)) {
      const value = row[field];
      observed.add(value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
    }
    if (observed.size) types[field] = [...observed].sort();
  }
  return { registros: Array.isArray(body?.registros) ? "array" : "unconfirmed", fields: types };
}
// Fail closed for unknown Cloud metadata/CA/proxy variants; never infer permission from env.
function managedAgent() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const path = "/usr/local/share/ca-certificates/environment-proxy-ca.crt";
  const policy = JSON.parse(readFileSync("/etc/codex/network-policy.json", "utf8"));
  const proxy = new URL(policy.http_proxy);
  if (major !== 24 || minor < 5 || process.env.HTTPS_PROXY !== policy.http_proxy
    || proxy.protocol !== "http:" || proxy.username || proxy.password || proxy.search || proxy.hash
    || proxy.pathname !== "/" || policy.http_proxy === policy.tcp_connect_proxy
    || !policy.http_network_policy?.egress_rules?.some(rule => rule.host === "ixc.bbnetup.com.br")
    || process.env.CODEX_PROXY_CERT !== path) throw new Error("TRANSPORT_CONFIGURATION");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o022)) throw new Error("TRANSPORT_CONFIGURATION");
  const ca = readFileSync(path, "utf8");
  if (!new X509Certificate(ca).ca) throw new Error("TRANSPORT_CONFIGURATION");
  return new Agent({ proxyEnv: { HTTPS_PROXY: policy.http_proxy },
    ca: [...rootCertificates, ca], rejectUnauthorized: true, keepAlive: false, maxSockets: 1 });
}
async function main() {
  if (process.env.IXC_DIRECT_READ_APPROVED !== "true" || process.argv.length !== 2) { refuse(); return; }
  let authorization;
  try { authorization = diagnosticAuthorization(process.env); } catch {
    emit({ event: "ixc.directDiagnostic", version: 1, outcome: "refused", category: "authorization-configuration" });
    process.exitCode = 78; return;
  }
  let agent;
  try { agent = managedAgent(); } catch {
    emit({ event: "ixc.directDiagnostic", version: 1, outcome: "refused", category: "transport-configuration" });
    process.exitCode = 78; return;
  }
  let config;
  try {
    config = await readConfiguration();
    if (!config || typeof config !== "object" || Array.isArray(config)
      || Object.keys(config).some(key => !["origin", "customerId", "invoiceId", "page"].includes(key))
      || config.origin !== "https://ixc.bbnetup.com.br"
      || typeof config.customerId !== "string" || !/^[1-9]\d{0,31}$/.test(config.customerId)
      || typeof config.invoiceId !== "string" || !/^[1-9]\d{0,31}$/.test(config.invoiceId)
      || !Number.isSafeInteger(config.page) || config.page < 1 || config.page > 1000) throw new Error("CONFIGURATION");
  } catch { agent.destroy(); refuse(); return; }
  const diagnostic = createPaymentDiagnostic();
  const transport = withDiagnosticAuthorization(createIxcDiagnosticFetcher({
    origin: config.origin, paths: ["/webservice/v1/fn_areceber", "/webservice/v1/fn_movim_finan"],
    timeoutMs: 3500, maxRequestBytes: 4096, maxResponseBytes: 1048576,
  }, agent), authorization);
  let calls = 0;
  const fetcher = async (input, init) => {
    if (++calls > 3) throw new Error("IXC_TRANSPORT_POLICY");
    const response = await transport(input, init);
    // Fixed field-name catalog + type names only; never log arbitrary keys or values.
    let structure = { registros: "unconfirmed", fields: {} };
    try { structure = shape(await response.clone().json()); } catch { /* Provider retains JSON validation. */ }
    emit({ event: "ixc.directResponseShape", version: 1, sequence: calls,
      resource: new URL(String(input)).pathname.endsWith("/fn_areceber") ? "invoice" : "movements",
      httpStatus: response.status, ...structure });
    return response;
  };
  // Empty internal credential is never sent: the mandatory wrapper supplies the opaque header.
  const provider = new IxcReadonlyProvider({ baseUrl: config.origin, token: "",
    allowedCustomerIds: [config.customerId], fullBase: false, timeoutMs: 3500, retryLimit: 0,
    cacheTtlMs: 0, rateLimitPerMinute: 3, fetcher });
  try {
    const page = await provider.getInvoicePaymentPage(config.customerId, config.invoiceId, config.page,
      "direct-diagnostic", diagnostic.progress);
    diagnostic.finish("success");
    emit({ event: "ixc.directDiagnostic", version: 1, outcome: "accepted", calls,
      scope: "invoice-page", totalConfirmed: page.total !== null,
      note: "validated-page-not-proof-of-settlement" });
  } catch (error) {
    diagnostic.finish("failure", error);
    emit({ event: "ixc.directDiagnostic", version: 1, outcome: "rejected", calls });
    process.exitCode = 1;
  } finally { agent.destroy(); }
}
await main();
