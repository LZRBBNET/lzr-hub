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
