/**
 * Piloto: a IA abre UMA ordem de serviço de teste no IXC real, no cadastro de TESTE
 * autorizado pela BBNET (21857 — Wendel Mendonça, login `copadomundo2026`).
 * Autorizado pelo Vinícius em 18/11/2026: assunto 14 SEM FUNCIONAR/EQUIPE CARRO,
 * setor 1 TECNICO. A equipe técnica é avisada para ignorar e fechar.
 *
 *   node --experimental-strip-types scripts/ixc-pilot-ai-service-order.mjs
 *
 * Por quê: nenhuma OS tinha sido aberta pela API em produção, então o formato da
 * resposta de sucesso nunca tinha sido visto — e o assunto 14 exige login. A IA só
 * passa a abrir OS sozinha depois que isto provar o caminho inteiro: criar, ler de
 * volta e conferir cliente, contrato, assunto, setor e login.
 *
 * Travas antes de escrever: o nome do cadastro tem de ser o do Wendel; o contrato tem
 * de estar ativo e ser dele; não pode haver OS aberta com o mesmo assunto.
 */
import { existsSync, readFileSync } from "node:fs";
import { createIxcFetcher, resolveIxcHttpMethod } from "../lib/integrations/ixc/http.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { openServiceOrder } from "../lib/integrations/ixc/write-client.ts";

const TEST_CUSTOMER = "21857";
const SUBJECT = "14";
const SECTOR = "1";

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
const provider = new IxcReadonlyProvider({ baseUrl, token, allowedCustomerIds: [TEST_CUSTOMER], fetcher });
const corr = `pilot-ai-os-${Date.now()}`;

const snapshot = await provider.getSnapshot(TEST_CUSTOMER, corr, true);
if (!/wendel/i.test(snapshot.customer.name)) { console.error("O cadastro 21857 não é o do Wendel. Nada foi feito."); process.exit(1); }
console.log("Cadastro de teste confirmado (Wendel). Filial:", snapshot.customer.branchId);

const diagnosis = await provider.getServiceDiagnosis(TEST_CUSTOMER, corr);
const contract = diagnosis.contracts.find((c) => c.status === "A");
const login = diagnosis.logins.find((l) => l.contractId === contract?.id) ?? diagnosis.logins[0];
if (!contract || !login) { console.error("Sem contrato ativo ou login. Nada foi feito."); process.exit(1); }
const confirmed = await provider.getServiceOrderContract(TEST_CUSTOMER, contract.id, corr);
console.log("Contrato confirmado:", confirmed.id, "| login:", login.id);

const subjects = await provider.listOsSubjects(corr);
const subjectName = subjects.find((s) => s.id === SUBJECT)?.name;
const open = snapshot.serviceOrders.filter((o) => o.status !== "F" && o.subject === subjectName);
if (open.length) { console.error(`Já existe OS aberta com o assunto ${subjectName} (nº ${open.map((o) => o.id).join(", ")}). Nada foi feito.`); process.exit(1); }

const message = [
  "TESTE DO LZR HUB — abertura automática de OS pela IA. Cadastro de teste autorizado; pode ignorar e fechar.",
  "Ficha montada pela IA: sem internet desde as 7h; nenhum aparelho conecta; luz LOS vermelha piscando; reinício não resolveu.",
  "Visita: período da tarde, com pessoa maior de idade no local.",
].join("\n");

// Sem o `fetcher` de listagem: ele transforma o pedido em GET com corpo (`ixcsoft: listar`) e o
// IXC devolve uma LISTA de OS em vez de criar uma — foi o que aconteceu nas duas primeiras
// tentativas, sem criar nada. A criação usa o fetch nativo com POST, como a rota de OS em produção.
const result = await openServiceOrder({ baseUrl, token }, {
  customerId: TEST_CUSTOMER, contractId: contract.id, subjectId: SUBJECT, sectorId: SECTOR,
  branchId: snapshot.customer.branchId ?? "", priority: "N", message, loginId: login.id,
}, corr);
// Só os campos de controle: a resposta crua pode trazer dado de cliente (inclusive de outros).
if (Array.isArray(result.raw.registros)) { console.error("O IXC devolveu uma listagem, não uma criação. Nada foi criado; parei."); process.exit(2); }
console.log("\nResposta do IXC (campos de controle):", JSON.stringify({ type: result.raw.type, message: String(result.raw.message ?? "").slice(0, 160), id: result.raw.id, chaves: Object.keys(result.raw) }));

const orderId = String(result.raw.id ?? "");
if (!/^[1-9]\d*$/.test(orderId)) { console.error("A resposta não trouxe o número da OS — conferir no IXC antes de qualquer nova tentativa."); process.exit(2); }
const back = await provider.reconcileServiceOrder(TEST_CUSTOMER, contract.id, orderId, corr);
console.log("Lida de volta no IXC:", JSON.stringify(back));
