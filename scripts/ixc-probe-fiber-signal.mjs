/**
 * O IXC da BBNET guarda o sinal óptico da ONU? Sonda **só de leitura**, no cadastro de
 * TESTE autorizado (21857 — login `copadomundo2026`). Imprime nomes de campo e valores
 * numéricos de sinal, nunca dado pessoal.
 *
 *   node --experimental-strip-types scripts/ixc-probe-fiber-signal.mjs
 *
 * Por quê: o atendimento N1 de provedor de fibra decide "é na sua casa ou é na rede?"
 * olhando o sinal recebido pela ONU (abaixo de ~-27 dBm é crítico). Sem esse dado, a IA
 * só sabe se o login está online.
 */
import { existsSync, readFileSync } from "node:fs";
import { createIxcFetcher, resolveIxcHttpMethod } from "../lib/integrations/ixc/http.ts";
import { basicCredential } from "../lib/integrations/ixc/readonly-provider.ts";

const TEST_CUSTOMER = "21857";

function fromEnvFile(name) {
  if (!existsSync(".env.local")) return undefined;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (trimmed.slice(0, separator) === name) return trimmed.slice(separator + 1).trim();
  }
  return undefined;
}

const baseUrl = process.env.IXC_BASE_URL || fromEnvFile("IXC_BASE_URL");
const token = process.env.IXC_API_TOKEN || fromEnvFile("IXC_API_TOKEN");
if (!baseUrl || !token || baseUrl.includes("localhost")) { console.error("Faltam IXC_BASE_URL e IXC_API_TOKEN reais no .env.local."); process.exit(1); }
const fetcher = createIxcFetcher(resolveIxcHttpMethod(process.env.IXC_HTTP_METHOD));
const auth = `Basic ${basicCredential(token)}`;

async function list(table, qtype, query) {
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/webservice/v1/${table}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json", ixcsoft: "listar" },
    body: JSON.stringify({ qtype, query, oper: "=", page: "1", rp: "5" }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const SIGNAL = /sinal|rx|tx|potenc|temperat|dbm|onu|olt|pon|status|data|online/i;
const logins = await list("radusuarios", "radusuarios.id_cliente", TEST_CUSTOMER);
const loginIds = (logins.body.registros ?? []).map((row) => String(row.id));
console.log(`radusuarios: HTTP ${logins.status}, ${loginIds.length} login(s)`);

for (const table of ["radpop_radio_cliente_fibra", "radpop_radio_cliente_fibra_sinal"]) {
  for (const loginId of loginIds) {
    const result = await list(table, `${table}.id_login`, loginId);
    const rows = result.body.registros ?? [];
    console.log(`\n${table}: HTTP ${result.status}, type=${result.body.type ?? "-"}, total=${result.body.total ?? rows.length}${result.body.message ? `, msg=${String(result.body.message).slice(0, 120)}` : ""}`);
    for (const row of rows.slice(0, 2)) {
      console.log(`  campos: ${Object.keys(row).join(", ")}`);
      for (const [key, value] of Object.entries(row)) if (SIGNAL.test(key) && !/mac|serial|ip|senha|nome|endereco|login$/i.test(key)) console.log(`    ${key} = ${String(value).slice(0, 40)}`);
    }
  }
}
