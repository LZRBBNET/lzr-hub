/**
 * Lê do IXC o que uma renegociação de dívida exige: carteira de cobrança,
 * condição de pagamento e a conta do cliente.
 *
 * O wizard de renegociação (`fn_renegociacao_wiz`) pede `id_carteira_cobranca`,
 * `id_condicao_pagamento`, `id_conta`, `id_filial` e `contrato_renegociacao`.
 * Diferente da OS, aqui os números decidem **quanto o cliente vai pagar**: a
 * condição de pagamento define em quantas parcelas, e a carteira define juro e
 * multa. Fixar qualquer um deles no código seria arbitrar dinheiro alheio.
 *
 * **Só lê.** Nenhuma renegociação é criada aqui.
 *
 *   node --experimental-strip-types scripts/ixc-probe-renegotiation-catalog.mjs
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
  console.error("Faltam IXC_BASE_URL e IXC_API_TOKEN reais no .env.local.");
  process.exit(1);
}
const fetcher = createIxcFetcher(resolveIxcHttpMethod(process.env.IXC_HTTP_METHOD));

async function listar(resource, body, campos) {
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/webservice/v1/${resource}`, {
      method: "POST",
      headers: { Authorization: `Basic ${basicCredential(token)}`, "Content-Type": "application/json", ixcsoft: "listar" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      console.log(`  ✗ resposta não-JSON (HTTP ${response.status}): ${text.slice(0, 140).replace(/\s+/g, " ")}`);
      return;
    }
    if (parsed.type === "error") { console.log(`  ✗ IXC recusou: ${String(parsed.message ?? "").slice(0, 200)}`); return; }
    const registros = Array.isArray(parsed.registros) ? parsed.registros : [];
    console.log(`  total=${parsed.total ?? "-"} | mostrando ${registros.length}`);
    for (const row of registros) console.log(`    ${campos.map((campo) => `${campo}=${row[campo] ?? ""}`).join("  ")}`);
    if (registros[0]) console.log(`    (campos disponíveis: ${Object.keys(registros[0]).slice(0, 18).join(", ")})`);
  } catch (error) {
    console.log(`  ✗ ERRO ${error?.cause?.code ?? ""} ${error?.message ?? ""}`);
  }
}

const page = (sortname, extra = {}) => ({ page: "1", rp: "50", sortname, sortorder: "asc", ...extra });

console.log("Carteiras de cobrança (fn_carteira_cobranca) — definem juro e multa:");
await listar("fn_carteira_cobranca", page("fn_carteira_cobranca.id", { qtype: "fn_carteira_cobranca.id", query: "0", oper: ">" }), ["id", "titulo", "descricao", "nome"]);

console.log("\nCondições de pagamento (condicoes_pagamento) — definem o parcelamento:");
await listar("condicoes_pagamento", page("condicoes_pagamento.id", { qtype: "condicoes_pagamento.id", query: "0", oper: ">" }), ["id", "descricao", "parcelas", "nome"]);

console.log("\nConta do cadastro real 21857 (id_conta é obrigatório no wizard):");
await listar("cliente", page("cliente.id", { qtype: "cliente.id", query: "21857", oper: "=", rp: "1" }), ["id", "id_conta", "filial_id"]);
