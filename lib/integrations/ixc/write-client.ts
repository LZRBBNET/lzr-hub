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
