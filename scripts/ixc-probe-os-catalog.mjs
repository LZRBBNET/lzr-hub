/**
 * Lê do IXC os valores que uma ordem de serviço exige: assunto, setor e filial.
 *
 * Por que isto existe antes de qualquer código de escrita: o corpo do
 * `POST /webservice/v1/su_oss_chamado` (confirmado na coleção Postman "API -
 * IXC Provedor" → Suporte → Ordem de serviço → OS de Cliente → Cliente
 * (inserir)) marca como **obrigatórios** `id_assunto`, `setor`, `id_filial`,
 * `prioridade`, `origem_endereco` e `status`. Esses números são configuração do
 * provedor, não constante universal — chutar `id_assunto: 1` abriria chamado
 * real na fila errada, e alguém iria atendê-lo.
 *
 * **Só lê.** Nenhuma OS é criada aqui.
 *
 *   node --experimental-strip-types scripts/ixc-probe-os-catalog.mjs
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
    for (const row of registros) {
      console.log(`    ${campos.map((campo) => `${campo}=${row[campo] ?? ""}`).join("  ")}`);
    }
  } catch (error) {
    console.log(`  ✗ ERRO ${error?.cause?.code ?? ""} ${error?.message ?? ""}`);
  }
}

const page = (sortname, extra = {}) => ({ page: "1", rp: "60", sortname, sortorder: "asc", ...extra });

console.log("Assuntos de OS (su_oss_assunto) — é o `id_assunto` do chamado:");
await listar("su_oss_assunto", page("su_oss_assunto.id", { qtype: "su_oss_assunto.id", query: "0", oper: ">" }), ["id", "assunto", "id_setor", "status"]);

console.log("\nSetores (empresa_setor) — é o `setor` do chamado:");
await listar("empresa_setor", page("empresa_setor.id", { qtype: "empresa_setor.id", query: "0", oper: ">" }), ["id", "setor", "descricao", "nome"]);

console.log("\nFiliais (filial) — é o `id_filial`:");
await listar("filial", page("filial.id", { qtype: "filial.id", query: "0", oper: ">" }), ["id", "razao", "fantasia"]);

console.log(`
Como ler:
  • Cada assunto costuma já apontar um setor (id_setor). Se apontar, o setor da OS
    deve vir do assunto escolhido, não de um número solto no código.
  • "IXC recusou" com mensagem de permissão significa que o token não tem acesso
    à rota — conversa com quem administra o IXC, não com o código.`);
