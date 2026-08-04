/**
 * Descobre se o webservice do IXC aceita listar a base de clientes inteira,
 * em vez de só consultar cadastro por id.
 *
 * A allowlist (`IXC_ALLOWED_CUSTOMER_IDS`) é uma trava **nossa**, de homologação:
 * ela não diz nada sobre o que o ERP permite. Este script pergunta ao ERP.
 *
 * Não passa pelo guard nem pelo provider de propósito — é diagnóstico, fala
 * direto com o webservice. Só lê.
 *
 * Pega IXC_BASE_URL e IXC_API_TOKEN do ambiente ou do .env.local (que é
 * gitignorado). Copie os dois valores do painel do Railway do lzr-hub e rode:
 *
 *   node --experimental-strip-types scripts/ixc-probe-listing.mjs
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
  console.error("Faltam IXC_BASE_URL e IXC_API_TOKEN reais (o .env.local tem um localhost de exemplo).");
  console.error("Copie os dois do painel do Railway do lzr-hub para o .env.local e rode de novo.");
  process.exit(1);
}

// Um endereço mal colado (ex.: "http:https://...") só apareceria como
// ENOTFOUND lá na frente, uma vez por consulta. Melhor falhar aqui, dizendo o quê.
let target;
try { target = new URL(baseUrl); } catch { target = undefined; }
if (!target || !/^https?:$/.test(target.protocol) || !target.hostname.includes(".")) {
  console.error(`IXC_BASE_URL não é um endereço válido: ${JSON.stringify(baseUrl)}`);
  console.error('Esperado algo como "https://ixc-bridge.exemplo.com.br", sem prefixo sobrando.');
  process.exit(1);
}
console.log(`Alvo: ${target.origin}\n`);

const fetcher = createIxcFetcher(resolveIxcHttpMethod(process.env.IXC_HTTP_METHOD));

async function probe(label, resource, body) {
  const started = Date.now();
  try {
    const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/webservice/v1/${resource}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicCredential(token)}`,
        "Content-Type": "application/json",
        ixcsoft: "listar",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      // O IXC devolve página de erro HTML com HTTP 200 quando a consulta é inválida.
      console.log(`${label} | HTTP ${response.status} | resposta não-JSON: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
      return;
    }
    const registros = Array.isArray(parsed.registros) ? parsed.registros.length : 0;
    console.log(`${label} | HTTP ${response.status} | type=${parsed.type ?? "-"} | total=${parsed.total ?? "-"} | registros=${registros} | ${Date.now() - started}ms`);
    if (parsed.type === "error") console.log(`   mensagem do IXC: ${String(parsed.message ?? "").slice(0, 160)}`);
  } catch (error) {
    console.log(`${label} | ERRO ${error?.cause?.code ?? error?.code ?? ""} ${error?.message ?? ""}`);
  }
}

const page = (extra) => ({ page: "1", rp: "5", sortname: "cliente.id", sortorder: "asc", ...extra });

console.log("Cada linha é uma forma diferente de pedir a lista. `total` é o tamanho da base que o IXC admite ter.\n");
console.log("-- Listar a base --");
await probe("id > 0            ", "cliente", page({ qtype: "cliente.id", query: "0", oper: ">" }));
await probe("ativo = S         ", "cliente", page({ qtype: "cliente.ativo", query: "S", oper: "=" }));
await probe("query vazia       ", "cliente", page({ qtype: "cliente.id", query: "", oper: "" }));

console.log("\n-- Paginação (a lista da tela depende disso) --");
await probe("página 2 (rp 5)   ", "cliente", page({ qtype: "cliente.id", query: "0", oper: ">", page: "2" }));
await probe("rp 100            ", "cliente", page({ qtype: "cliente.id", query: "0", oper: ">", rp: "100" }));

// Estes são exatamente os filtros que `customerQuery` monta. Se algum falhar,
// a busca correspondente na tela não vai funcionar e é melhor saber agora.
console.log("\n-- Busca (formatos que a tela vai usar) --");
await probe("nome LIKE 'MARIA' ", "cliente", page({ qtype: "cliente.razao", query: "MARIA", oper: "L" }));
await probe("nome = 'MARIA'    ", "cliente", page({ qtype: "cliente.razao", query: "MARIA", oper: "=" }));
await probe("cnpj_cpf = (vazio)", "cliente", page({ qtype: "cliente.cnpj_cpf", query: "00000000000", oper: "=" }));

console.log("\n-- Conferência de escala --");
await probe("contratos ativos  ", "cliente_contrato", page({ qtype: "cliente_contrato.status", query: "A", oper: "=", sortname: "cliente_contrato.id" }));

console.log(`
Como ler:
  • \`total\` com o tamanho da base e \`registros\` respeitando o rp -> listagem paginada funciona, não precisa do suporte do IXC.
  • \`nome LIKE\` funcionando -> a busca por nome da tela funciona. Se só o \`=\` funcionar, a busca vira "nome exato" e eu ajusto o código.
  • erro de permissão -> aí sim é conversa com o suporte: o perfil do token precisa liberar a listagem.`);
