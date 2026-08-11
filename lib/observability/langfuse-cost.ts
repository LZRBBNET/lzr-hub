/**
 * Lê o custo de IA registrado no Langfuse, para o cartão do cockpit (issue #22).
 *
 * O provedor em `langfuse-provider.ts` só **envia** rastro; ele não sabe
 * responder quanto custou. Esta é a metade que faltava.
 *
 * Duas coisas foram confirmadas contra a API real antes de escrever isto, em
 * vez de presumidas:
 *
 * 1. `/api/public/metrics/daily` está **deprecado** — a própria resposta diz
 *    que será removido e manda usar `/api/public/v2/metrics`. É este que
 *    usamos.
 * 2. O `view` aceito é `observations` (não `traces`), e o retorno vem como
 *    `{ data: [{ sum_totalCost: number, count_count: string }] }` — repare que
 *    a contagem chega **string**, não número.
 */

export interface LangfuseCostOptions {
  publicKey: string;
  secretKey: string;
  /** Região do projeto. Chave da nuvem US não funciona no host EU e vice-versa. */
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface LangfuseCostResult {
  /** Custo somado no período, em dólar (unidade do Langfuse). */
  cost: number;
  /** Quantas observações entraram na conta — distingue "custa zero" de "não há o que somar". */
  observations: number;
}

export class LangfuseCostError extends Error {
  constructor(message: string) { super(message); this.name = "LangfuseCostError"; }
}

export async function fetchLangfuseCost(
  options: LangfuseCostOptions,
  fromIso: string,
  toIso: string,
): Promise<LangfuseCostResult> {
  const fetcher = options.fetcher ?? fetch;
  const host = (options.baseUrl ?? "https://cloud.langfuse.com").replace(/\/$/, "");
  const query = encodeURIComponent(JSON.stringify({
    view: "observations",
    metrics: [{ measure: "totalCost", aggregation: "sum" }, { measure: "count", aggregation: "count" }],
    dimensions: [],
    fromTimestamp: fromIso,
    toTimestamp: toIso,
  }));

  let response: Response;
  try {
    response = await fetcher(`${host}/api/public/v2/metrics?query=${query}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    });
  } catch (error) {
    throw new LangfuseCostError(error instanceof Error && error.name === "TimeoutError" ? "LANGFUSE_TIMEOUT" : "LANGFUSE_INDISPONIVEL");
  }

  // 401 aqui quase sempre é região errada, não chave inválida: a mensagem do
  // Langfuse é a mesma nos dois casos, e a EU recusa chave da US.
  if (response.status === 401) throw new LangfuseCostError("LANGFUSE_CREDENCIAL_OU_REGIAO_INCORRETA");
  if (!response.ok) throw new LangfuseCostError(`LANGFUSE_HTTP_${response.status}`);

  const payload = await response.json().catch(() => null) as { data?: Array<Record<string, unknown>> } | null;
  const row = payload?.data?.[0];
  if (!row) return { cost: 0, observations: 0 };

  const cost = Number(row.sum_totalCost ?? 0);
  const observations = Number(row.count_count ?? 0);
  if (!Number.isFinite(cost) || !Number.isFinite(observations)) throw new LangfuseCostError("LANGFUSE_RESPOSTA_INESPERADA");
  return { cost, observations };
}

export function langfuseCostOptionsFromEnv(source: Record<string, string | undefined> = process.env): LangfuseCostOptions | null {
  if (source.FEATURE_LANGFUSE !== "true") return null;
  const publicKey = source.LANGFUSE_PUBLIC_KEY, secretKey = source.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;
  return { publicKey, secretKey, baseUrl: source.LANGFUSE_BASE_URL };
}
