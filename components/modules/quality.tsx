"use client";
import { useEffect, useState } from "react";
import type { Navigate } from "@/components/lzr-hub-app";
import { Badge, Bar, Card, Empty, Limits, Loading, Notice, PERIODS_SHORT, Row, Segmented, Stat, Stats, Toolbar, count } from "@/components/ui/kit";
import { handoffLabel } from "@/components/modules/labels";

/**
 * Avaliações e "Como a IA decide". A primeira já foi uma tela genérica com
 * números fixos no código ("Nota média 9,4", "Aprovadas 96%"); hoje tudo vem
 * das conversas gravadas.
 */
export function QualityModule({ view, onNavigate }: { view: "avaliacoes" | "prompts"; onNavigate: Navigate }) {
  return view === "prompts" ? <HowAiDecides /> : <Evaluations onNavigate={onNavigate} />;
}

type Metrics = {
  conversations: number; resolvedWithoutHuman: number; resolutionRate: number | null;
  handoffs: number; suggestionsOnly: number; handoffReasons: Record<string, number>;
  intents: Record<string, number>; csatAverage: number | null; csatCount: number;
  csatDistribution: Record<string, number>;
};
type Payload = { period: string; available: boolean; detail?: string } & Partial<Metrics>;

function Evaluations({ onNavigate }: { onNavigate: Navigate }) {
  const [period, setPeriod] = useState<"24h" | "7d" | "30d">("7d");
  const [data, setData] = useState<Payload | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    fetch(`/api/support/metrics?period=${period}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: Payload) => { if (active) { setData(payload); setFailed(false); setLoadedFor(period); } })
      .catch(() => { if (active) { setFailed(true); setLoadedFor(period); } });
    return () => { active = false; };
  }, [period]);

  const loading = loadedFor !== period;
  const total = data?.conversations ?? 0;
  const handoffs = Object.entries(data?.handoffReasons ?? {}).sort((a, b) => b[1] - a[1]);
  const csat = data?.csatDistribution ?? {};
  const csatTotal = data?.csatCount ?? 0;
  const handoffTotal = Math.max(data?.handoffs ?? 0, 1);

  return <>
    <Toolbar><Segmented label="Período" value={period} options={PERIODS_SHORT} onChange={setPeriod} /></Toolbar>
    {loading && <Loading stats={4} rows={3} />}
    {!loading && failed && <Notice tone="bad">Não foi possível consultar as avaliações.</Notice>}
    {!loading && !failed && data && !data.available && <Notice tone="bad">{data.detail ?? "Fonte indisponível"}.</Notice>}
    {!loading && !failed && data?.available && (total === 0
      ? <Card><Empty icon="sparkles" title="Nenhuma conversa no período">Não há o que avaliar.</Empty></Card>
      : <>
        <Stats>
          <Stat label="Conversas avaliadas" icon="chat" value={count(total)} hint="Base de tudo abaixo" />
          <Stat label="Resolvidas sem humano" icon="sparkles" value={data.resolutionRate === null || data.resolutionRate === undefined ? "—" : `${Math.round(data.resolutionRate * 100)}%`} hint={`${data.resolvedWithoutHuman ?? 0} de ${total}`} />
          <Stat label="Transbordos" icon="users" value={count(data.handoffs ?? 0)} hint={data.handoffs ? "Passaram para humano" : "Nenhum"} />
          <Stat label="CSAT médio" icon="check" value={data.csatAverage === null || data.csatAverage === undefined ? "—" : data.csatAverage.toFixed(1).replace(".", ",")} hint={csatTotal ? `${csatTotal} avaliação(ões)` : "Nenhuma nota recebida"} />
        </Stats>
        {/* A causa mais comum tem nome técnico e consequência clara: vale explicar. */}
        {handoffs[0]?.[0] === "low_intent_confidence" && <Notice tone="warn" title="A causa principal é o classificador, não o cliente."
          action={<button className="button secondary small" onClick={() => onNavigate("prompts")}>Ver como a IA decide</button>}
          more="Quando nenhuma regra casa, a confiança fica em 0,55 — abaixo do corte de 0,6 — e a conversa transborda. Se o classificador por modelo foi ligado depois do início do período, as conversas mais novas já não passam por aqui.">Cliente real raramente escreve como a regra espera.</Notice>}
        <div className="grid-2 even">
          <Card title="Por que a IA passou para humano" badge={<Badge tone="warn">{data.handoffs ?? 0}</Badge>}>
            {handoffs.length === 0
              ? <Empty icon="check" title="Nenhum transbordo no período" />
              : <div className="bars">{handoffs.map(([reason, n]) => <Bar key={reason} label={handoffLabel(reason)} detail={`${n} de ${data.handoffs}`} value={n} max={handoffTotal} display={`${Math.round(n / handoffTotal * 100)}%`} />)}</div>}
          </Card>
          <Card title="Notas dos clientes" badge={<Badge tone="info">CSAT</Badge>}>
            {csatTotal === 0
              ? <Empty icon="check" title="Nenhuma nota recebida">A pergunta de avaliação só é feita quando a IA responde — e ela está em modo observação.</Empty>
              : <div className="bars">{[5, 4, 3, 2, 1].map((score) => <Bar key={score} label={`${score} ${score === 1 ? "estrela" : "estrelas"}`} value={csat[String(score)] ?? 0} max={csatTotal} />)}</div>}
          </Card>
        </div>
        <Limits items={[["Custo por atendimento", "Depende de instrumentar o Langfuse. Enquanto não estiver, nenhum número de custo aparece aqui."]]} />
      </>)}
  </>;
}

type Service = { name: string; state: string; mode: string; detail: string };

/**
 * Existe **um** prompt no sistema: o do classificador de intenção. Ele não
 * escreve nada para o cliente — escolhe um item de uma lista fechada.
 *
 * Por isso esta tela não versiona prompt em banco: quem muda esse texto muda um
 * arquivo, e o histórico já está no Git com autor, data e revisão.
 */
function HowAiDecides() {
  const [service, setService] = useState<Service | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let active = true;
    fetch("/api/admin/status", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("falhou")))
      .then((payload: { services: Service[] }) => {
        if (!active) return;
        setService(payload.services?.find((item) => item.name.startsWith("Classificação de intenção")) ?? null);
        setState("ready");
      })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, []);

  if (state === "loading") return <Loading stats={3} rows={4} />;
  if (state === "error") return <Notice tone="bad">Não foi possível consultar o estado do classificador.</Notice>;
  const ativo = service?.state === "ok";
  const meioLigado = service?.state === "degraded";
  const steps: Array<[string, string]> = [
    ["1. Entender o pedido", ativo
      ? `O modelo (${service?.mode}) escolhe um item de uma lista fechada de intenções. Resposta fora da lista é descartada e a regra assume.`
      : "Cadeia de expressões regulares. Se nenhuma casar, a confiança fica em 0,55 e a conversa transborda."],
    ["2. Decidir se passa para humano", "Regras explícitas: confiança baixa, pedido de humano, risco de cancelamento, pedido não autorizado."],
    ["3. Escrever a resposta", "Texto aprovado por assunto (Base de conhecimento → Respostas aprovadas). Não há geração de texto livre para o cliente — a resposta carrega garantias que texto livre jogaria fora."],
  ];
  return <>
    {meioLigado && <Notice tone="bad" title="A flag está ligada, mas não há chave.">{service?.detail} Toda mensagem está sendo classificada por expressão regular.</Notice>}
    <Stats>
      <Stat label="Classificador" icon="sparkles" tone={ativo ? "ok" : "warn"} value={ativo ? "Modelo" : "Regra"} hint={ativo ? String(service?.mode) : "Expressões regulares"} />
      <Stat label="Quem escreve ao cliente" icon="chat" value="Texto aprovado" hint="O modelo nunca redige a resposta" />
      <Stat label="Versionamento do prompt" icon="book" value="Git" hint="Autor, data e revisão de cada alteração" />
    </Stats>
    <Card title="Como a IA decide, passo a passo" badge={<Badge tone={ativo ? "ok" : "warn"} dot>{ativo ? "modelo ativo" : "só regra"}</Badge>} flush>
      <div className="list">{steps.map(([title, detail]) => <Row key={title} title={title} detail={detail} />)}</div>
    </Card>
    <Limits title="Garantias e detalhes técnicos" items={[
      ["Privacidade", "A mensagem sai sanitizada — e-mail, CPF e telefone removidos antes de qualquer chamada externa. A Groq não treina com dado de cliente em nenhuma camada."],
      ["Se o modelo falhar", "Sem chave não há chamada; erro ou demora acima de 4 s cai na regra; resposta inválida é descartada. Em nenhum caso o atendimento para."],
      ["Onde o prompt mora", "lib/agent/llm-classifier.ts. Uma segunda cópia versionada no banco criaria divergência entre o que esta tela mostra e o que o servidor executa."],
    ]} />
  </>;
}
