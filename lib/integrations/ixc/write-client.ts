import { basicCredential } from "./readonly-provider.ts";

/**
 * Cliente dedicado ao único endpoint de escrita/geração implementado até
 * agora: `get_boleto` (segunda via de boleto). Fica fora de
 * readonly-provider.ts de propósito — aquele arquivo é readonly por nome e
 * por trás do `ReadonlyIxcGuard`, que não tem essa operação na lista
 * permitida. Isolar aqui deixa óbvio, ao ler o código, que esta é a única
 * porta de escrita que existe hoje.
 *
 * Contrato confirmado na coleção Postman "API - IXC Provedor" → Financeiro →
 * Imprimir boleto → "Segunda via/Download do Boleto":
 *   POST {baseUrl}/webservice/v1/get_boleto
 *   { boletos, juro, multa, atualiza_boleto: "S", tipo_boleto: "arquivo", base64: "S", layout_impressao }
 *
 * O formato da resposta de **sucesso** não está confirmado: a coleção não
 * tinha exemplo salvo, e o único cliente da allowlist não tem fatura nenhuma
 * (nem histórica) para testar contra uma chamada real. O que foi confirmado
 * na prática: chamada com ID inexistente devolve HTTP 200 com corpo vazio —
 * por isso corpo vazio conta como "não encontrado", nunca como sucesso.
 * Qualquer resposta que não seja JSON reconhecível também falha alto, em vez
 * de arriscar devolver um boleto errado como se fosse válido.
 */

export interface IxcWriteClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface BoletoSecondCopyResult {
  /** Conteúdo cru da resposta do IXC, ainda não interpretado em campos específicos — ver nota acima. */
  raw: Record<string, unknown>;
}

export class IxcWriteClientError extends Error {
  constructor(message: string) { super(message); this.name = "IxcWriteClientError"; }
}

export async function fetchBoletoSecondCopy(
  options: IxcWriteClientOptions,
  boletoId: string,
  correlationId: string,
): Promise<BoletoSecondCopyResult> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  let response: Response;
  try {
    response = await fetcher(`${options.baseUrl}/webservice/v1/get_boleto`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicCredential(options.token)}`,
        "content-type": "application/json",
        "x-correlation-id": correlationId,
      },
      // juro/multa vazios de propósito: uma segunda via de rotina não deve
      // incluir encargo sem pedido explícito de quem chamou.
      body: JSON.stringify({
        boletos: boletoId, juro: "", multa: "", atualiza_boleto: "S",
        tipo_boleto: "arquivo", base64: "S", layout_impressao: "",
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new IxcWriteClientError(error instanceof Error && error.name === "AbortError" ? "IXC_TIMEOUT" : "IXC_NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new IxcWriteClientError(`IXC_HTTP_${response.status}`);

  const text = await response.text();
  if (!text.trim()) throw new IxcWriteClientError("IXC_BOLETO_NAO_ENCONTRADO");

  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new IxcWriteClientError("IXC_RESPOSTA_INESPERADA"); }
  if (!parsed || typeof parsed !== "object") throw new IxcWriteClientError("IXC_RESPOSTA_INESPERADA");

  return { raw: parsed as Record<string, unknown> };
}

/**
 * Abertura de ordem de serviço.
 *
 * Contrato confirmado na coleção Postman "API - IXC Provedor" → Suporte →
 * Ordem de serviço → OS de Cliente → Cliente (inserir):
 *   POST {baseUrl}/webservice/v1/su_oss_chamado
 *
 * O corpo lá marca como **obrigatórios**: `tipo`, `id_assunto`, `id_cliente`,
 * `id_filial`, `origem_endereco`, `prioridade`, `setor` e `status`. Só esses são
 * enviados — mandar o corpo inteiro com dezenas de campos vazios é convite a
 * sobrescrever com string vazia algo que o IXC preencheria sozinho.
 *
 * `tipo: "C"` é OS de cliente (a alternativa, "E", é OS de estrutura).
 * `origem_endereco: "M"` usa o endereço do cadastro do cliente — sem isso a OS
 * nasceria sem para onde o técnico ir.
 * `status: "A"` é aberta/aguardando.
 *
 * ⚠️ O formato da **resposta de sucesso** não está confirmado: a coleção não tem
 * exemplo salvo, e nenhuma OS foi aberta em produção para conferir. Por isso o
 * resultado devolve a resposta crua e quem chama guarda no ledger — a primeira
 * abertura real, auditada, é quem prova o formato. Um `type: "error"` no corpo
 * falha alto, porque o IXC responde HTTP 200 mesmo quando recusa.
 */
export interface ServiceOrderInput {
  customerId: string;
  subjectId: string;
  sectorId: string;
  branchId: string;
  priority: string;
  message: string;
}

export async function openServiceOrder(
  options: IxcWriteClientOptions,
  input: ServiceOrderInput,
  correlationId: string,
): Promise<{ raw: Record<string, unknown> }> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  let response: Response;
  try {
    response = await fetcher(`${options.baseUrl}/webservice/v1/su_oss_chamado`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicCredential(options.token)}`,
        "content-type": "application/json",
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify({
        tipo: "C", id_assunto: input.subjectId, id_cliente: input.customerId,
        id_filial: input.branchId, origem_endereco: "M", prioridade: input.priority,
        setor: input.sectorId, status: "A", mensagem: input.message,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new IxcWriteClientError(error instanceof Error && error.name === "AbortError" ? "IXC_TIMEOUT" : "IXC_NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new IxcWriteClientError(`IXC_HTTP_${response.status}`);
  const text = await response.text();
  if (!text.trim()) throw new IxcWriteClientError("IXC_RESPOSTA_VAZIA");

  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new IxcWriteClientError("IXC_RESPOSTA_INESPERADA"); }
  if (!parsed || typeof parsed !== "object") throw new IxcWriteClientError("IXC_RESPOSTA_INESPERADA");

  // O IXC recusa com HTTP 200 e `type: "error"` no corpo. Sem esta checagem, uma
  // recusa viraria "sucesso" no ledger e ninguém iria atrás da OS que não existe.
  const body = parsed as { type?: unknown; message?: unknown };
  if (body.type === "error") throw new IxcWriteClientError(`IXC_RECUSOU: ${String(body.message ?? "").slice(0, 200)}`);

  return { raw: parsed as Record<string, unknown> };
}

/**
 * Renegociação de dívida — o wizard de 5 passos do IXC.
 *
 * ⚠️ **Isto não é atômico, e essa é a característica mais importante daqui.**
 * O passo 1 (`renegociar_selecionados`) **já cria a renegociação no ERP** e
 * devolve `id_renegociacao`. Se um passo seguinte falhar, o cliente fica com uma
 * renegociação pela metade grudada nas faturas reais dele, e a coleção do IXC
 * não tem endpoint de desfazer. Por isso cada passo reporta progresso: quem
 * chama grava o `id_renegociacao` e o passo alcançado no ledger, para que uma
 * pessoa consiga achar e terminar (ou cancelar) na mão.
 *
 * Ordem executada: criar → calcular juro/multa → preencher (finalizar "N") →
 * finalizar ("S"). O cálculo vem antes do preenchimento porque é ele que
 * devolve o acréscimo que os campos de valor precisam.
 *
 * ⚠️ **Nenhum valor é inventado aqui.** O total renegociado é a soma das faturas
 * lidas do IXC, e o acréscimo é o que o próprio IXC calculou no passo 2.
 * `valor_descontos` é sempre "0,00": conceder desconto é justamente o que o
 * projeto se recusa a automatizar.
 */
export interface RenegotiationInput {
  invoiceIds: string[];
  customerId: string;
  branchId: string;
  accountId: string;
  contractId: string;
  walletId: string;
  paymentTermId: string;
  /** Soma das faturas, calculada a partir do que o IXC devolveu — nunca do que o navegador mandou. */
  originalTotal: number;
  /** Data de emissão em dd/mm/aaaa, como o IXC espera. */
  issuedOn: string;
}

export interface RenegotiationProgress { step: number; renegotiationId?: string; note: string }
export interface RenegotiationResult { raw: Record<string, unknown>; renegotiationId: string; surcharge: string; dueDate: string }

const money = (value: number) => value.toFixed(2);

async function ixcCall(
  options: IxcWriteClientOptions,
  path: string,
  method: "POST" | "PUT",
  payload: Record<string, unknown>,
  correlationId: string,
): Promise<Record<string, unknown>> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);
  let response: Response;
  try {
    response = await fetcher(`${options.baseUrl}/webservice/v1/${path}`, {
      method,
      headers: {
        Authorization: `Basic ${basicCredential(options.token)}`,
        "content-type": "application/json",
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    throw new IxcWriteClientError(error instanceof Error && error.name === "AbortError" ? "IXC_TIMEOUT" : "IXC_NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new IxcWriteClientError(`IXC_HTTP_${response.status}`);
  const text = await response.text();
  if (!text.trim()) throw new IxcWriteClientError("IXC_RESPOSTA_VAZIA");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new IxcWriteClientError("IXC_RESPOSTA_INESPERADA"); }
  if (!parsed || typeof parsed !== "object") throw new IxcWriteClientError("IXC_RESPOSTA_INESPERADA");
  const body = parsed as { type?: unknown; message?: unknown };
  if (body.type === "error") throw new IxcWriteClientError(`IXC_RECUSOU: ${String(body.message ?? "").slice(0, 200)}`);
  return parsed as Record<string, unknown>;
}

/**
 * Cadastro de cliente novo.
 *
 * Contrato confirmado na coleção Postman → Cadastros → Clientes → Cliente
 * (inserir): `POST {baseUrl}/webservice/v1/cliente`. Obrigatórios lá: `ativo`,
 * `tipo_pessoa`, `cnpj_cpf`, `contribuinte_icms`, `tipo_assinante`, `cep`,
 * `endereco`, `numero`, `bairro`, `cidade`, `tipo_localidade`, `cob_envia_email`
 * e `cob_envia_sms`.
 *
 * ⚠️ `cidade` e `uf` são **códigos internos do IXC**, não nomes nem IBGE — o
 * cadastro real 21857 tem `cidade: "1759"`, `uf: "28"`. Mandar "Aracaju" aí cria
 * cliente sem cidade válida, e ninguém percebe até a primeira cobrança.
 *
 * Só os campos obrigatórios mais contato vão no corpo. O exemplo da coleção tem
 * ~130 campos, quase todos vazios; mandá-los todos gravaria string vazia em
 * lugares que o IXC preencheria com o padrão dele.
 */
export interface CustomerInput {
  name: string;
  document: string;
  personKind: "F" | "J";
  cep: string;
  street: string;
  number: string;
  neighborhood: string;
  cityId: string;
  ufId: string;
  phone: string;
  email: string;
}

export async function createCustomer(
  options: IxcWriteClientOptions,
  input: CustomerInput,
  correlationId: string,
): Promise<{ raw: Record<string, unknown>; customerId: string }> {
  const raw = await ixcCall(options, "cliente", "POST", {
    ativo: "S", tipo_pessoa: input.personKind, razao: input.name, cnpj_cpf: input.document,
    // "I" é isento de ICMS: cliente pessoa física de provedor não é contribuinte.
    contribuinte_icms: "I", tipo_assinante: "1",
    cep: input.cep, endereco: input.street, numero: input.number, bairro: input.neighborhood,
    cidade: input.cityId, uf: input.ufId, tipo_localidade: "U",
    telefone_celular: input.phone, whatsapp: input.phone, email: input.email,
    // Vazio de propósito: ligar aviso de cobrança por e-mail/SMS sem a pessoa
    // ter pedido é mandar mensagem em nome do provedor por decisão nossa.
    cob_envia_email: "", cob_envia_sms: "",
  }, correlationId);
  const customerId = String(raw.id ?? "").trim();
  if (!customerId) throw new IxcWriteClientError("IXC_SEM_ID_CLIENTE");
  return { raw, customerId };
}

export async function renegotiateInvoices(
  options: IxcWriteClientOptions,
  input: RenegotiationInput,
  correlationId: string,
  onProgress?: (progress: RenegotiationProgress) => void,
): Promise<RenegotiationResult> {
  const report = (progress: RenegotiationProgress) => { try { onProgress?.(progress); } catch { /* relatar progresso nunca pode derrubar a operação */ } };

  report({ step: 1, note: "criando a renegociação com as faturas selecionadas" });
  const created = await ixcCall(options, "renegociar_selecionados", "POST", { get_id: input.invoiceIds.join(",") }, correlationId);
  const renegotiationId = String(created.id_renegociacao ?? "").trim();
  // Sem id não dá para continuar nem para achar depois. Falhar aqui é o melhor
  // caso possível: é o único momento em que ainda não há nada pendurado.
  if (!renegotiationId) throw new IxcWriteClientError("IXC_SEM_ID_RENEGOCIACAO");
  report({ step: 1, renegotiationId, note: `renegociação ${renegotiationId} criada no IXC` });

  report({ step: 2, renegotiationId, note: "pedindo ao IXC o cálculo de juro e multa" });
  const calculated = await ixcCall(options, "calcula_juros_multa", "POST", {
    id_carteira_cobranca: input.walletId, id_condicao_pagamento: input.paymentTermId, id: renegotiationId,
  }, correlationId);
  // "totalFineAndFess" é o nome do campo no IXC (com o erro de grafia dele).
  const surcharge = String(calculated.totalFineAndFess ?? "0,00").trim();
  const dueDate = String(calculated.dateExpiration ?? "").trim();
  const surchargeValue = Number(surcharge.replace(/\./g, "").replace(",", ".")) || 0;
  const total = input.originalTotal + surchargeValue;
  report({ step: 2, renegotiationId, note: `IXC calculou acréscimo de ${surcharge}` });

  const wizardBody = {
    id_filial: input.branchId, id_conta: input.accountId, id_cliente: input.customerId,
    data_emissao: input.issuedOn, previsao: "S",
    id_carteira_cobranca: input.walletId, id_condicao_pagamento: input.paymentTermId,
    vendedor_renegociacao: "", contrato_renegociacao: input.contractId,
    data_vencimento: dueDate || input.issuedOn,
    valor_parcelas: money(total),
    valor_acrescimos: surcharge,
    valor_descontos: "0,00",
    valor_total: money(total),
    valor_renegociado: money(input.originalTotal),
    acre_juros_multa: "",
    valor_total_pagar: money(total),
    status: "A",
  };

  report({ step: 3, renegotiationId, note: "preenchendo os dados obrigatórios" });
  await ixcCall(options, `fn_renegociacao_wiz/${renegotiationId}`, "PUT", { ...wizardBody, data_finalizada: "", finalizar: "N" }, correlationId);

  report({ step: 4, renegotiationId, note: "finalizando" });
  const finished = await ixcCall(options, `fn_renegociacao_wiz/${renegotiationId}`, "PUT", { ...wizardBody, data_finalizada: input.issuedOn, finalizar: "S" }, correlationId);

  return { raw: finished, renegotiationId, surcharge, dueDate };
}
