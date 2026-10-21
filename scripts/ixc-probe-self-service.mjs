/**
 * Sonda o que o autoatendimento precisa do IXC, no cadastro de TESTE autorizado
 * pela BBNET (login de conexão `copadomundo2026`, Wendel Mendonça).
 *
 * Por que existe antes do código: a coleção Postman "API - IXC Provedor" dá o
 * pedido de `get_pix` ({ id_areceber }) e de `desbloqueio_confianca` ({ id } do
 * contrato), mas não a resposta. Inventar o formato da resposta foi o erro que
 * a escrita no IXC já ensinou a não cometer — o IXC recusa com HTTP 200.
 *
 *   node --experimental-strip-types scripts/ixc-probe-self-service.mjs                 # leitura + PIX
 *   node --experimental-strip-types scripts/ixc-probe-self-service.mjs --desbloquear   # + desbloqueio de confiança (ESCRITA)
 *
 * Nada de senha, CPF ou telefone na saída: só nomes de campo e os valores que
 * dizem estado (status, online, vencimento, valor).
 */
import { existsSync, readFileSync } from "node:fs";
import { createIxcFetcher, resolveIxcHttpMethod } from "../lib/integrations/ixc/http.ts";
import { basicCredential } from "../lib/integrations/ixc/readonly-provider.ts";

const TEST_LOGIN = "copadomundo2026";
const TEST_NAME = "wendel mendonca";

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

const baseUrl = (process.env.IXC_BASE_URL || fromEnvFile("IXC_BASE_URL") || "").replace(/\/$/, "");
const token = process.env.IXC_API_TOKEN || fromEnvFile("IXC_API_TOKEN");
if (!baseUrl || !token || baseUrl.includes("localhost")) { console.error("Faltam IXC_BASE_URL e IXC_API_TOKEN reais no .env.local."); process.exit(1); }
const auth = { Authorization: `Basic ${basicCredential(token)}`, "Content-Type": "application/json" };
const listFetcher = createIxcFetcher(resolveIxcHttpMethod(process.env.IXC_HTTP_METHOD));
const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const SECRET = /senha|password|cpf|cnpj|fone|telefone|celular|whatsapp|email|rg\b|ie_identidade|mac|ip\b|token|hash/i;

async function listar(resource, body) {
  const response = await listFetcher(`${baseUrl}/webservice/v1/${resource}`, { method: "POST", headers: { ...auth, ixcsoft: "listar" }, body: JSON.stringify(body) });
  const parsed = JSON.parse(await response.text());
  if (parsed.type === "error") throw new Error(`IXC recusou ${resource}: ${parsed.message}`);
  return Array.isArray(parsed.registros) ? parsed.registros : [];
}

async function acao(resource, body) {
  const response = await fetch(`${baseUrl}/webservice/v1/${resource}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return { status: response.status, text, parsed };
}

/** Mostra os campos que interessam e o nome de todos os outros — nunca valor de campo sensível. */
function mostrar(titulo, row, campos) {
  console.log(`\n${titulo}`);
  // Valor longo (linha digitável, código PIX) aparece só como tamanho: basta saber que veio.
  for (const campo of campos) if (campo in row && !SECRET.test(campo)) console.log(`  ${campo} = ${String(row[campo]).length > 24 ? `texto(${String(row[campo]).length})` : row[campo]}`);
  console.log(`  (campos disponíveis: ${Object.keys(row).filter((k) => !SECRET.test(k)).join(", ")})`);
}

function descreverResposta(nome, { status, text, parsed }) {
  console.log(`\n${nome}: HTTP ${status}`);
  if (!parsed) { console.log(`  corpo não-JSON (${text.length} bytes): ${text.slice(0, 120).replace(/\s+/g, " ")}`); return; }
  const shape = (value) => (typeof value === "string" ? `texto(${value.length})` : Array.isArray(value) ? `lista(${value.length})` : typeof value);
  for (const [key, value] of Object.entries(parsed)) {
    const show = key === "type" || key === "message" || key === "msg" ? ` = ${String(value).slice(0, 200)}` : "";
    console.log(`  ${key}: ${shape(value)}${show}`);
    if (value && typeof value === "object" && !Array.isArray(value)) for (const [sub, inner] of Object.entries(value)) console.log(`    ${key}.${sub}: ${shape(inner)}`);
  }
}

const login = (await listar("radusuarios", { qtype: "radusuarios.login", query: TEST_LOGIN, oper: "=", page: "1", rp: "5" }))[0];
if (!login) { console.error(`Login ${TEST_LOGIN} não encontrado.`); process.exit(1); }
mostrar("Login (radusuarios)", login, ["id", "id_cliente", "id_contrato", "ativo", "online", "ultima_conexao_inicial", "ultima_conexao_final", "tempo_conectado"]);

const cliente = (await listar("cliente", { qtype: "cliente.id", query: String(login.id_cliente), oper: "=", page: "1", rp: "1" }))[0];
if (!cliente) { console.error("Cadastro do login não encontrado."); process.exit(1); }
const nome = normalize(cliente.razao);
console.log(`\nCadastro ${cliente.id}: nome confere com o de teste? ${nome.includes(TEST_NAME) ? "SIM" : "NÃO"} · documento preenchido: ${cliente.cnpj_cpf ? `sim (${String(cliente.cnpj_cpf).replace(/\D/g, "").length} dígitos)` : "não"}`);
if (!nome.includes(TEST_NAME)) { console.error("O login não é do cadastro de teste. Parando antes de qualquer ação."); process.exit(1); }

const contrato = (await listar("cliente_contrato", { qtype: "cliente_contrato.id", query: String(login.id_contrato), oper: "=", page: "1", rp: "1" }))[0];
if (contrato) mostrar("Contrato (cliente_contrato)", contrato, Object.keys(contrato).filter((k) => /status|bloq|confian|liber|desbl|ativ/i.test(k)));

const faturas = await listar("fn_areceber", {
  qtype: "fn_areceber.id_contrato", query: String(login.id_contrato), oper: "=", page: "1", rp: "20", sortname: "fn_areceber.data_vencimento", sortorder: "asc",
  grid_param: JSON.stringify([{ TB: "fn_areceber.liberado", OP: "=", P: "S" }, { TB: "fn_areceber.status", OP: "!=", P: "C" }, { TB: "fn_areceber.status", OP: "!=", P: "R" }]),
});
console.log(`\nFaturas em aberto do contrato: ${faturas.length}`);
for (const fatura of faturas.slice(0, 3)) mostrar(`Fatura ${fatura.id}`, fatura, ["id", "status", "data_vencimento", "valor", "valor_aberto", "linha_digitavel", "pix_txid", "tipo_recebimento"]);

// Sem fatura em aberto, a mais recente de qualquer situação: ao menos mostra o formato da recusa.
const alvo = faturas[0] ?? (await listar("fn_areceber", { qtype: "fn_areceber.id_cliente", query: String(login.id_cliente), oper: "=", page: "1", rp: "3", sortname: "fn_areceber.id", sortorder: "desc" }))[0];
if (alvo) {
  if (!faturas[0]) mostrar(`Fatura mais recente ${alvo.id} (não está em aberto)`, alvo, ["id", "status", "data_vencimento", "valor", "linha_digitavel", "pix_txid", "tipo_recebimento"]);
  descreverResposta(`get_pix (fatura ${alvo.id})`, await acao("get_pix", { id_areceber: String(alvo.id) }));
  descreverResposta(`get_boleto tipo "dados" (fatura ${alvo.id})`, await acao("get_boleto", { boletos: String(alvo.id), juro: "", multa: "", atualiza_boleto: "", tipo_boleto: "dados", base64: "S", layout_impressao: "" }));
} else console.log("O cadastro de teste não tem fatura nenhuma: PIX e boleto ficam sem prova.");

if (process.argv.includes("--desbloquear")) {
  if (!contrato) { console.error("Sem contrato para desbloquear."); process.exit(1); }
  console.log(`\nESCRITA: desbloqueio de confiança no contrato ${contrato.id} (cadastro de teste)`);
  descreverResposta("desbloqueio_confianca", await acao("desbloqueio_confianca", { id: String(contrato.id) }));
  const depois = (await listar("cliente_contrato", { qtype: "cliente_contrato.id", query: String(contrato.id), oper: "=", page: "1", rp: "1" }))[0];
  if (depois) mostrar("Contrato depois", depois, Object.keys(depois).filter((k) => /status|bloq|confian|liber|desbl/i.test(k)));
}
