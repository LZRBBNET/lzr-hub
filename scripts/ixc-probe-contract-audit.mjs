/**
 * Mede, na base real, o que a auditoria de contratos vai encontrar — antes de
 * existir código que dependa disso.
 *
 * Lê os contratos mais recentes de `cliente_contrato` e, para uma amostra, o
 * cadastro do cliente: celular/WhatsApp, e-mail e o campo Número do endereço.
 * **Não imprime dado pessoal**: só contagens, nomes de campo e, para o Número,
 * os valores que não são algarismos (como "SN", "S/N", "0") — que é exatamente o
 * que a regra precisa conhecer.
 *
 *   node --experimental-strip-types scripts/ixc-probe-contract-audit.mjs [contratos] [amostra]
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
const sampleSize = Number(process.argv[3] ?? 60);
const fetcher = createIxcFetcher(resolveIxcHttpMethod(process.env.IXC_HTTP_METHOD));

async function list(resource, body) {
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/webservice/v1/${resource}`, {
    method: "POST",
    headers: { Authorization: `Basic ${basicCredential(token)}`, "Content-Type": "application/json", ixcsoft: "listar" },
    body: JSON.stringify({ page: "1", sortorder: "asc", ...body }),
  });
  const parsed = await response.json();
  if (parsed.type === "error") throw new Error(`IXC recusou: ${String(parsed.message ?? "").slice(0, 120)}`);
  return { total: Number(parsed.total ?? 0), rows: Array.isArray(parsed.registros) ? parsed.registros : [] };
}

const digits = (value) => String(value ?? "").replace(/\D/g, "");
const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const show = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => `${JSON.stringify(key)}: ${value}`).join(", ");

console.log(`Alvo: ${new URL(baseUrl).origin}\n`);

const contracts = await list("cliente_contrato", { qtype: "cliente_contrato.id", query: "0", oper: ">", rp: String(contractCount), sortname: "cliente_contrato.id", sortorder: "desc" });
console.log(`-- Contratos: ${contracts.total} na base; lidos os ${contracts.rows.length} mais recentes por id --`);
const ids = contracts.rows.map((row) => Number(row.id)).filter(Number.isFinite);
console.log(`ids de ${Math.min(...ids)} a ${Math.max(...ids)} (crescente com a criação? os mais novos têm id maior: ${ids[0] >= ids.at(-1)})`);
const dateKeys = Object.keys(contracts.rows[0] ?? {}).filter((key) => /data|criad|cadastro/i.test(key));
console.log(`campos de data no contrato: ${dateKeys.join(", ")}`);
for (const key of dateKeys) {
  const filled = contracts.rows.filter((row) => String(row[key] ?? "").trim() && !String(row[key]).startsWith("0000")).length;
  console.log(`  ${key.padEnd(28)} preenchido em ${filled}/${contracts.rows.length} — exemplo do mais novo: ${String(contracts.rows[0]?.[key] ?? "").slice(0, 19)}`);
}
const statusMap = new Map(); for (const row of contracts.rows) count(statusMap, String(row.status ?? ""));
console.log(`status: ${show(statusMap)}`);
console.log(`campos com 'vendedor' ou 'usuario': ${Object.keys(contracts.rows[0] ?? {}).filter((key) => /vendedor|usuario|operador/i.test(key)).join(", ") || "nenhum"}`);

const customerIds = [...new Set(contracts.rows.map((row) => String(row.id_cliente ?? "")).filter(Boolean))].slice(0, sampleSize);
console.log(`\n-- Cadastro de ${customerIds.length} clientes desses contratos --`);
let mobileOk = 0, mobileOnlyWhatsapp = 0, noMobile = 0, emailOk = 0, emailInvalid = 0, emailEmpty = 0, notFound = 0;
const numberShapes = new Map();
const numberNonDigits = new Map();
for (const id of customerIds) {
  const { rows } = await list("cliente", { qtype: "cliente.id", query: id, oper: "=", rp: "1" });
  const customer = rows[0];
  if (!customer) { notFound += 1; continue; }
  const mobile = digits(customer.telefone_celular).length >= 10;
  const whatsapp = digits(customer.whatsapp).length >= 10;
  if (mobile) mobileOk += 1; else if (whatsapp) mobileOnlyWhatsapp += 1; else noMobile += 1;
  const email = String(customer.email ?? "").trim();
  if (!email) emailEmpty += 1; else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) emailOk += 1; else emailInvalid += 1;
  const number = String(customer.numero ?? "").trim();
  const shape = !number ? "vazio" : /^0+$/.test(number) ? "zero" : /^\d+$/.test(number) ? "só algarismos" : /\d/.test(number) ? "algarismos + letras" : "sem algarismo";
  count(numberShapes, shape);
  if (number && !/\d/.test(number)) count(numberNonDigits, number.toUpperCase());
  if (/^0+$/.test(number)) count(numberNonDigits, number);
}
console.log(`celular/WhatsApp: celular ok ${mobileOk}, só WhatsApp ${mobileOnlyWhatsapp}, nenhum ${noMobile}`);
console.log(`e-mail: válido ${emailOk}, preenchido mas inválido ${emailInvalid}, vazio ${emailEmpty}`);
console.log(`Número do endereço: ${show(numberShapes)}`);
console.log(`  valores sem algarismo (e zeros): ${show(numberNonDigits) || "nenhum"}`);
if (notFound) console.log(`cadastros não encontrados: ${notFound}`);
