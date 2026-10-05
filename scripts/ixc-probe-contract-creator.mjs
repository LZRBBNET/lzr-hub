/**
 * Quem criou o contrato? Mede o que o IXC guarda sobre isso, antes de existir
 * código que dependa.
 *
 * O contrato (`cliente_contrato`) não tem campo de usuário criador — só
 * `id_vendedor` e `id_vendedor_ativ`. Este script mede: quanto esses campos
 * vêm preenchidos, a quem apontam (tabela `vendedor`), se o vendedor está ligado
 * a um usuário do sistema, e se o webservice expõe algum log de criação.
 *
 * Imprime nomes de **vendedores** (equipe da BBNET), nunca de clientes.
 *
 *   node --experimental-strip-types scripts/ixc-probe-contract-creator.mjs [contratos]
 */
import { existsSync, readFileSync } from "node:fs";
import { createIxcFetcher, resolveIxcHttpMethod } from "../lib/integrations/ixc/http.ts";
import { basicCredential } from "../lib/integrations/ixc/readonly-provider.ts";

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
if (!baseUrl || !token || baseUrl.includes("localhost")) {
  console.error("Faltam IXC_BASE_URL e IXC_API_TOKEN reais no ambiente ou no .env.local.");
  process.exit(1);
}
const contractCount = Number(process.argv[2] ?? 200);
const fetcher = createIxcFetcher(resolveIxcHttpMethod(process.env.IXC_HTTP_METHOD));

async function list(resource, body) {
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/webservice/v1/${resource}`, {
    method: "POST",
    headers: { Authorization: `Basic ${basicCredential(token)}`, "Content-Type": "application/json", ixcsoft: "listar" },
    body: JSON.stringify({ page: "1", sortorder: "asc", ...body }),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { error: `HTTP ${response.status}, resposta não-JSON` }; }
  if (parsed.type === "error") return { error: String(parsed.message ?? "erro").slice(0, 120) };
  return { total: Number(parsed.total ?? 0), rows: Array.isArray(parsed.registros) ? parsed.registros : [] };
}
const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

console.log(`Alvo: ${new URL(baseUrl).origin}\n`);

const contracts = await list("cliente_contrato", { qtype: "cliente_contrato.id", query: "0", oper: ">", rp: String(contractCount), sortname: "cliente_contrato.id", sortorder: "desc" });
if (contracts.error) { console.error(`contratos: ${contracts.error}`); process.exit(1); }
const keys = Object.keys(contracts.rows[0] ?? {});
console.log(`-- ${contracts.rows.length} contratos mais recentes --`);
console.log(`campos que podem indicar pessoa: ${keys.filter((key) => /usu|vend|oper|atend|cria|resp|tecn|func/i.test(key)).join(", ") || "nenhum"}`);

for (const field of ["id_vendedor", "id_vendedor_ativ"]) {
  const values = new Map();
  for (const row of contracts.rows) count(values, String(row[field] ?? "").trim() || "(vazio)");
  const filled = contracts.rows.filter((row) => !["", "0"].includes(String(row[field] ?? "").trim())).length;
  console.log(`${field}: preenchido (≠ 0) em ${filled}/${contracts.rows.length}; ${values.size} valores distintos`);
}

const sellerIds = [...new Set(contracts.rows.flatMap((row) => [row.id_vendedor, row.id_vendedor_ativ]).map((v) => String(v ?? "").trim()).filter((v) => v && v !== "0"))];
console.log(`\n-- Tabela vendedor (${sellerIds.length} ids citados) --`);
const sellers = new Map();
for (const id of sellerIds.slice(0, 25)) {
  const result = await list("vendedor", { qtype: "vendedor.id", query: id, oper: "=", rp: "1" });
  if (result.error) { console.log(`vendedor ${id}: ${result.error}`); continue; }
  const row = result.rows[0];
  if (!row) { console.log(`vendedor ${id}: não encontrado`); continue; }
  if (sellers.size === 0) console.log(`campos do vendedor: ${Object.keys(row).join(", ")}`);
  sellers.set(id, row);
}
const byContract = new Map();
for (const row of contracts.rows) count(byContract, String(row.id_vendedor ?? "").trim() || "(vazio)");
for (const [id, total] of [...byContract.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const seller = sellers.get(id);
  const link = seller ? Object.entries(seller).filter(([key, value]) => /usu|func|login|email/i.test(key) && String(value ?? "").trim() && String(value) !== "0").map(([key, value]) => `${key}=${String(value).slice(0, 30)}`).join(" ") : "";
  console.log(`  id_vendedor ${id.padEnd(6)} → ${total} contrato(s) — ${seller ? String(seller.nome ?? seller.vendedor ?? "?").slice(0, 40) : "sem cadastro"}${seller ? ` (ativo: ${seller.ativo ?? "?"})` : ""}${link ? ` [${link}]` : ""}`);
}

console.log("\n-- O webservice expõe log de criação? --");
for (const resource of ["ixc_logs", "log_alteracao", "log_alteracoes", "logs", "auditoria", "sis_log", "log"]) {
  const result = await list(resource, { qtype: `${resource}.id`, query: "0", oper: ">", rp: "1", sortname: `${resource}.id`, sortorder: "desc" });
  console.log(`  ${resource.padEnd(16)} ${result.error ? `não: ${result.error}` : `sim: ${result.total} registros; campos: ${Object.keys(result.rows[0] ?? {}).join(", ").slice(0, 160)}`}`);
}

console.log("\n-- ixc_logs para os 5 contratos mais recentes (sem imprimir 'campos' nem 'executou', que podem ter dado de cliente) --");
const responsible = new Map();
for (const row of contracts.rows) count(responsible, String(row.id_responsavel ?? "").trim() || "(vazio)");
console.log(`id_responsavel do contrato: ${[...responsible.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
const operators = new Set();
for (const contract of contracts.rows.slice(0, 5)) {
  const started = Date.now();
  const result = await list("ixc_logs", {
    qtype: "ixc_logs.id_tabela", query: String(contract.id), oper: "=", rp: "20", sortname: "ixc_logs.id", sortorder: "asc",
    grid_param: JSON.stringify([{ TB: "ixc_logs.tabela", OP: "=", P: "cliente_contrato" }]),
  });
  const ms = Date.now() - started;
  if (result.error) { console.log(`contrato ${contract.id}: ${result.error} (${ms} ms)`); continue; }
  const summary = result.rows.map((log) => { operators.add(String(log.operador ?? "")); return `${log.tipo}/${log.operador}@${String(log.data ?? "").slice(0, 16)}`; }).join("  ");
  console.log(`contrato ${contract.id} (vendedor ${contract.id_vendedor}, responsavel ${contract.id_responsavel}): ${result.total} log(s) em ${ms} ms → ${summary || "nenhum"}`);
}

console.log("\n-- operador do log → usuário do sistema --");
for (const operator of [...operators].filter(Boolean).slice(0, 8)) {
  const byId = /^\d+$/.test(operator) ? await list("usuarios", { qtype: "usuarios.id", query: operator, oper: "=", rp: "1" }) : { rows: [] };
  const user = byId.rows?.[0];
  console.log(`  operador ${operator.padEnd(8)} → ${byId.error ? `usuarios: ${byId.error}` : user ? `usuário "${String(user.nome ?? "").slice(0, 40)}" (campos: ${Object.keys(user).filter((k) => /nome|email|login|grupo|ativo/i.test(k)).join(", ")})` : "não é id de usuário"}`);
}
