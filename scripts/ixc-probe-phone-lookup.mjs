/**
 * Pergunta ao IXC se dá para **encontrar um cadastro pelo telefone**.
 *
 * Por que isso importa: o canal de WhatsApp entrega o número do cliente, mas o
 * LZR HUB nunca soube de quem é aquele número. Isso bloqueia, hoje, o item 3
 * de Massivas (#13), os itens 1 e 3 da IA de Cobrança (#16), a captação de
 * lead do funil (#17) e a IA Comercial inteira (#18). Antes de declarar isso
 * "impossível" mais uma vez, este script pergunta ao ERP.
 *
 * Cuidado que o script existe para provar: um celular brasileiro com DDD tem
 * **11 dígitos**, exatamente como um CPF. O `customerQuery` atual manda
 * qualquer coisa de 11 dígitos para `cliente.cnpj_cpf` — ou seja, buscar por
 * telefone hoje consultaria o campo errado e não acharia nada, sem erro
 * nenhum. Por isso as consultas abaixo são explícitas por campo.
 *
 * Não passa pelo guard nem pelo provider: é diagnóstico, fala direto com o
 * webservice, e só lê.
 *
 *   node --experimental-strip-types scripts/ixc-probe-phone-lookup.mjs [telefone]
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

// Telefone do cadastro 21857 (allowlist), usado como caso conhecido de teste.
const raw = process.argv[2] ?? "79998307232";
const digits = raw.replace(/\D/g, "");
const withoutCountry = digits.startsWith("55") ? digits.slice(2) : digits;
const ddd = withoutCountry.slice(0, 2);
const rest = withoutCountry.slice(2);
// O WhatsApp entrega alguns números sem o nono dígito; o cadastro pode ter com.
const withNinth = rest.length === 8 ? `9${rest}` : rest;
const withoutNinth = rest.length === 9 && rest.startsWith("9") ? rest.slice(1) : rest;

const fetcher = createIxcFetcher(resolveIxcHttpMethod(process.env.IXC_HTTP_METHOD));

async function probe(label, body) {
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/webservice/v1/cliente`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicCredential(token)}`,
        "Content-Type": "application/json",
        ixcsoft: "listar",
      },
      body: JSON.stringify({ page: "1", rp: "5", sortname: "cliente.id", sortorder: "asc", ...body }),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      console.log(`${label} | HTTP ${response.status} | resposta não-JSON: ${text.slice(0, 100).replace(/\s+/g, " ")}`);
      return;
    }
    const registros = Array.isArray(parsed.registros) ? parsed.registros : [];
    const achados = registros.map((r) => `${r.id}:${String(r.razao ?? "").slice(0, 22)}`).join(" | ");
    console.log(`${label} | total=${parsed.total ?? "-"} | ${registros.length ? achados : "nenhum"}`);
    if (parsed.type === "error") console.log(`   erro do IXC: ${String(parsed.message ?? "").slice(0, 140)}`);
  } catch (error) {
    console.log(`${label} | ERRO ${error?.cause?.code ?? error?.code ?? ""} ${error?.message ?? ""}`);
  }
}

console.log(`Alvo: ${new URL(baseUrl).origin}`);
console.log(`Telefone de teste: ${raw} → DDD ${ddd}, com nono ${withNinth}, sem nono ${withoutNinth}\n`);

console.log("-- O campo existe e é consultável? --");
for (const field of ["telefone_celular", "whatsapp", "telefone_comercial", "fone"]) {
  await probe(`${field.padEnd(20)} = ${ddd}${withNinth}`, { qtype: `cliente.${field}`, query: `${ddd}${withNinth}`, oper: "=" });
}

console.log("\n-- Formatos de armazenamento (o cadastro pode ter máscara) --");
await probe("com máscara         ", { qtype: "cliente.telefone_celular", query: `(${ddd}) ${withNinth.slice(0, 5)}-${withNinth.slice(5)}`, oper: "=" });
await probe("LIKE só o número    ", { qtype: "cliente.telefone_celular", query: withNinth, oper: "L" });
await probe("LIKE com DDD        ", { qtype: "cliente.telefone_celular", query: `${ddd}${withNinth}`, oper: "L" });
await probe("LIKE sem nono dígito", { qtype: "cliente.telefone_celular", query: withoutNinth, oper: "L" });

console.log("\n-- A armadilha dos 11 dígitos: o código de hoje mandaria isto --");
await probe("como se fosse CPF   ", { qtype: "cliente.cnpj_cpf", query: `${ddd}${withNinth}`, oper: "=" });

console.log("\n-- LIKE precisa de curinga explícito? (define se a busca é robusta ou frágil) --");
await probe("LIKE %numero%       ", { qtype: "cliente.telefone_celular", query: `%${withNinth}%`, oper: "L" });
await probe("LIKE %sem-nono%     ", { qtype: "cliente.telefone_celular", query: `%${withoutNinth}%`, oper: "L" });
await probe("LIKE %parcial final%", { qtype: "cliente.telefone_celular", query: `%${withNinth.slice(-4)}%`, oper: "L" });
await probe("LIKE máscara parcial", { qtype: "cliente.telefone_celular", query: `%${withNinth.slice(0, 5)}-${withNinth.slice(5)}%`, oper: "L" });

console.log("\n-- Outras máscaras que o cadastro pode usar --");
await probe("sem espaço          ", { qtype: "cliente.telefone_celular", query: `(${ddd})${withNinth.slice(0, 5)}-${withNinth.slice(5)}`, oper: "=" });
await probe("hífen só            ", { qtype: "cliente.telefone_celular", query: `${ddd} ${withNinth.slice(0, 5)}-${withNinth.slice(5)}`, oper: "=" });
