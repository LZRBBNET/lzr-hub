"use client";
import { useEffect, useState } from "react";

/**
 * Avaliações e Prompts eram servidas por uma tela genérica com números fixos no
 * código ("Nota média 9,4", "Aprovadas 96%", "Versão ativa v12"). Nada disso
 * vinha de lugar nenhum.
 */
export function QualityModule({ view }: { view: "avaliacoes" | "prompts" }) {
  return view === "prompts" ? <Prompts /> : <Evaluations />;
}

type Metrics = {
  conversations: number; resolvedWithoutHuman: number; resolutionRate: number | null;
  handoffs: number; suggestionsOnly: number; handoffReasons: Record<string, number>;
  intents: Record<string, number>; csatAverage: number | null; csatCount: number;
  csatDistribution: Record<string, number>; costPerConversation: null;
};
type Payload = { period: string; available: boolean; detail?: string } & Partial<Metrics>;

const PERIODS: [string, string][] = [["24h", "24 horas"], ["7d", "7 dias"], ["30d", "30 dias"]];
const HANDOFF_LABELS: Record<string, string> = {
  low_intent_confidence: "A IA não entendeu o pedido",
  customer_requested_human: "Cliente pediu atendente",
  customer_irritated: "Cliente irritado",
  unauthorized_request: "Pedido não autorizado",
  cancellation_risk: "Risco de cancelamento",
};

function Evaluations() {
  const [period, setPeriod] = useState("7d");
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let active = true;
    fetch(`/api/support/metrics?period=${period}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: Payload) => { if (active) { setData(payload); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [period]);

  const total = data?.conversations ?? 0;
  const handoffs = Object.entries(data?.handoffReasons ?? {}).sort((a, b) => b[1] - a[1]);
  const csat = data?.csatDistribution ?? {};
  const csatTotal = data?.csatCount ?? 0;

  return <main className="content">
    <Heading title="Avaliações da IA" text="Como o atendimento automático se saiu, medido nas conversas reais." />
    <section className="filter-bar"><select value={period} onChange={(event) => { setState("loading"); setPeriod(event.target.value); }}>{PERIODS.map(([value, label]) => <option key={value} value={value}>Últimos {label}</option>)}</select></section>
    {state === "loading" && <div className="state-card">Consultando os atendimentos…</div>}
    {state === "error" && <div className="state-card error">Não foi possível consultar as avaliações.</div>}
    {state === "ready" && data && !data.available && <div className="state-card error">{data.detail ?? "Fonte indisponível"}.</div>}
    {state === "ready" && data?.available && <>
      {total === 0
        ? <div className="state-card">Nenhuma conversa no período — não há o que avaliar.</div>
        : <>
          <section className="metrics">
            <Metric label="Conversas avaliadas" value={String(total)} detail="Base de tudo abaixo" />
            <Metric label="Resolvidas sem humano" value={data.resolutionRate === null || data.resolutionRate === undefined ? "—" : `${Math.round(data.resolutionRate * 100)}%`} detail={`${data.resolvedWithoutHuman ?? 0} de ${total}`} />
            <Metric label="Transbordos" value={String(data.handoffs ?? 0)} detail={data.handoffs ? "Passaram para humano" : "Nenhum"} />
            <Metric label="CSAT médio" value={data.csatAverage === null || data.csatAverage === undefined ? "—" : data.csatAverage.toFixed(1).replace(".", ",")} detail={csatTotal ? `${csatTotal} avaliação(ões)` : "Nenhuma nota recebida"} />
          </section>

          <div className="dashboard-grid">
            <section className="data-card">
              <div className="card-header"><strong>Por que a IA passou para humano</strong><span className="badge amber">{data.handoffs ?? 0}</span></div>
              {handoffs.length === 0
                ? <p className="card-empty">Nenhum transbordo no período.</p>
                : <div className="ranked-list">{handoffs.map(([reason, count]) => <div className="ranked-row" key={reason}>
                    <div className="ranked-label"><strong>{HANDOFF_LABELS[reason] ?? reason}</strong><span>{count} de {data.handoffs} transbordo(s)</span></div>
                    <div className="ranked-bar"><span style={{ width: `${Math.round(count / Math.max(data.handoffs ?? 1, 1) * 100)}%` }} /></div>
                    <b>{Math.round(count / Math.max(data.handoffs ?? 1, 1) * 100)}%</b>
                  </div>)}</div>}
              {/* A causa mais comum tem nome técnico e consequência clara: vale explicar. */}
              {handoffs[0]?.[0] === "low_intent_confidence" && <div className="insight insight-warning">
                <strong>A causa principal é o classificador, não o cliente.</strong>
                A intenção é detectada por expressões regulares fixas. Quando nenhuma casa, a confiança fica em 0,55 — abaixo do corte de 0,6 — e a conversa transborda. Cliente real raramente escreve exatamente o que a regra espera.
              </div>}
            </section>

            <section className="data-card">
              <div className="card-header"><strong>Notas dos clientes</strong><span className="badge blue">CSAT</span></div>
              {csatTotal === 0
                ? <p className="card-empty">Nenhuma nota recebida. A pergunta de avaliação só é feita quando a IA responde — e ela está em modo observação.</p>
                : <div className="ranked-list">{[5, 4, 3, 2, 1].map((score) => {
                    const count = csat[String(score)] ?? 0;
                    return <div className="ranked-row" key={score}>
                      <div className="ranked-label"><strong>{score} {score === 1 ? "estrela" : "estrelas"}</strong><span>{count} resposta(s)</span></div>
                      <div className="ranked-bar"><span style={{ width: `${csatTotal ? Math.round(count / csatTotal * 100) : 0}%` }} /></div>
                      <b>{count}</b>
                    </div>;
                  })}</div>}
              <div className="insight">
                <strong>Custo por atendimento não é medido.</strong>
                Depende de instrumentar o Langfuse. Enquanto não estiver, nenhum número de custo aparece aqui.
              </div>
            </section>
          </div>
        </>}
    </>}
  </main>;
}

/**
 * Não há prompt nenhum para versionar: a classificação de intenção é uma cadeia
 * de expressões regulares em `lib/agent/pipeline.ts` e as respostas são textos
 * fixos. Versionar prompt pressupõe que exista prompt.
 */
function Prompts() {
  return <main className="content">
    <Heading title="Prompts e versões" text="Versionamento das instruções que guiam a IA." />
    <div className="state-card error">
      <strong>Não existe prompt neste sistema.</strong>
      <p>A tela mostrava &quot;versão ativa v12&quot;, &quot;3 experimentos&quot; e &quot;rollback disponível&quot; — texto fixo no código, sem nada por trás.</p>
    </div>
    <section className="data-card">
      <div className="card-header"><strong>Como a IA decide hoje</strong></div>
      <div className="ranked-list">
        {[
          ["Classificação de intenção", "Cadeia de expressões regulares em lib/agent/pipeline.ts. Se nenhuma casar, a confiança cai para 0,55 e a conversa transborda."],
          ["Resposta ao cliente", "Textos fixos por intenção e por desfecho da ferramenta. Não há geração de linguagem."],
          ["Decisão de transbordo", "Regras explícitas em lib/agent/handoff.ts (confiança baixa, pedido de humano, risco de cancelamento, pedido não autorizado)."],
          ["Modelo de linguagem", "Nenhum. O projeto não tem dependência de LLM nem chave de API."],
        ].map(([item, detail]) => <div className="ranked-row" key={item}>
          <div className="ranked-label"><strong>{item}</strong><span>{detail}</span></div>
        </div>)}
      </div>
      <div className="insight insight-warning">
        <strong>O que muda quando houver um modelo de verdade.</strong>
        Aí esta tela passa a fazer sentido: versão do prompt em uso, histórico, comparação entre versões e rollback. Enquanto a decisão é código, versionar prompt é versionar nada — quem muda o comportamento é um commit, e isso já está no Git.
      </div>
    </section>
  </main>;
}

function Heading({ title, text }: { title: string; text: string }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{text}</p></div></div>;
}
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">✓</span></div><strong>{value}</strong><small>{detail}</small></article>;
}
