"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Navigate } from "@/components/lzr-hub-app";
import { Icon } from "@/components/ui/icons";
import { Avatar, Badge, Bar, Card, Empty, Limits, Loading, Notice, PERIODS_SHORT, Segmented, Stat, Stats, Toolbar, money, plural, relativeTime } from "@/components/ui/kit";
import { conversationLabel, handoffLabel, intentLabel } from "@/components/modules/labels";

type OverviewMetrics = { conversations:number; resolvedWithoutHuman:number; resolutionRate:number|null; handoffs:number; suggestionsOnly:number; handoffReasons:Record<string,number>; intents:Record<string,number>; csatAverage:number|null; csatCount:number };
type QueueItem = { channel:string; externalConversationId:string; lastAt:string; messages:number; intent?:string; handoff?:boolean; displayName?:string; awaitingSince?:string };
type Overview = { available:boolean; detail?:string; metrics:OverviewMetrics|null; queue:QueueItem[]; integrations:{ channel:{enabled:boolean;autoReply:boolean} } };
type CockpitMetric = { value:number|null; detail:string };
type Cockpit = {
  activeCustomers:CockpitMetric; openInvoices:CockpitMetric; overdueInvoices:CockpitMetric; goalProgressPercent:CockpitMetric;
  openIncidents:CockpitMetric; affectedCustomers:CockpitMetric; aiCost:CockpitMetric;
  recentActivity:Array<{id:string;action:string;entity:string;result:string;createdAt:string;actorId:string}>;
  degraded:string[];
};

const ACTION_LABELS: Record<string,string> = {
  "billing.rule.save":"Régua salva", "billing.collections.dispatch":"Disparo da régua", "billing.promise.create":"Promessa registrada",
  "billing.promise.review":"Promessas revisadas", "ixc.write.invoice_reissue":"Segunda via de boleto",
  "support.incident.create":"Massiva registrada", "support.incident.close":"Massiva encerrada", "support.incident.notify":"Aviso de massiva",
  "sales.goal.save":"Meta salva", "channel.message.processed":"Mensagem do canal", "integrations.telegram.alert":"Alerta de rede",
  "whatsapp.reply.sent":"Resposta enviada ao cliente", "whatsapp.reply.blocked":"Resposta recusada", "whatsapp.reply.failed":"Resposta não enviada",
  "whatsapp.autoreply.blocked":"Resposta da IA recusada", "whatsapp.autoreply.failed":"Resposta da IA não enviada",
  "users.create":"Conta criada", "user.created":"Conta criada", "user.password.reset":"Senha resetada", "auth.login":"Entrou no sistema", "auth.password.change":"Senha trocada",
  "ixc.write.service_order_open":"OS aberta no IXC", "ixc.write.renegotiation":"Renegociação no IXC", "ixc.write.customer_create":"Cliente cadastrado no IXC",
  "crm.lead.create":"Lead registrado", "crm.lead.move":"Lead mudou de etapa", "sales.goal.delete":"Meta removida",
  "knowledge.ingest":"Documento criado", "knowledge.publish":"Documento publicado", "agent.reply.updated":"Resposta aprovada editada",
  "copilot.suggestion.used":"Sugestão do copiloto usada", "customer360.view":"Cadastro consultado", "customer360.refresh":"Cadastro relido",
  "team.create":"Equipe criada", "team.update":"Equipe alterada", "internal_chat.thread.create":"Conversa interna aberta", "internal_chat.message":"Mensagem interna",
};

function greeting(hour: number | null) { return hour === null ? "Olá" : hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite"; }
const noSubscribe = () => () => undefined;
/** Indisponível nunca vira zero: "—" e o motivo, senão "não há inadimplente" seria lido onde a fonte só não respondeu. */
const show = (metric: CockpitMetric | undefined, format: (value:number)=>string = (v)=>v.toLocaleString("pt-BR")) => metric?.value === null || metric === undefined ? "—" : format(metric.value);

/**
 * Início: o que pede atenção primeiro, depois os números.
 *
 * A versão anterior empilhava onze cartões de indicador, duas notas explicando
 * o que não era medido e o mesmo "Conversas no período" em dois lugares. Aqui o
 * topo é só o que exige ação (cliente esperando, massiva aberta, fonte fora do
 * ar); o resto vem agrupado por assunto.
 */
/**
 * `awaiting` vem da casca, que consulta a lista inteira de conversas: a fila do
 * painel traz só as mais recentes e contaria menos clientes do que o menu.
 */
export function HomeModule({ onNavigate, awaiting }: { onNavigate: Navigate; awaiting: { count: number; oldest: string | null } }) {
  const [period,setPeriod] = useState<"24h"|"7d"|"30d">("7d");
  const [overview,setOverview] = useState<Overview|null>(null);
  const [cockpit,setCockpit] = useState<Cockpit|null>(null);
  const [failed,setFailed] = useState({ overview:false, cockpit:false });
  const [loadedFor,setLoadedFor] = useState<string|null>(null);
  // A saudação depende do relógio de quem lê: no servidor (UTC) ela sairia errada e divergiria na hidratação.
  const hour = useSyncExternalStore(noSubscribe, () => new Date().getHours(), () => null);

  useEffect(() => {
    let active = true;
    const get = <T,>(url:string) => fetch(url).then((response) => response.ok ? response.json() as Promise<T> : Promise.reject(new Error("falhou")));
    void Promise.allSettled([get<Overview>(`/api/operation/overview?period=${period}`), get<Cockpit>(`/api/cockpit?period=${period}`)]).then(([o, c]) => {
      if (!active) return;
      setOverview(o.status === "fulfilled" ? o.value : null);
      setCockpit(c.status === "fulfilled" ? c.value : null);
      setFailed({ overview:o.status === "rejected", cockpit:c.status === "rejected" });
      setLoadedFor(period);
    });
    return () => { active = false; };
  }, [period]);

  const loading = loadedFor !== period;
  const metrics = overview?.available ? overview.metrics : null;
  const channel = overview?.integrations.channel;
  const observing = !!channel?.enabled && !channel.autoReply;
  const incidents = cockpit?.openIncidents.value ?? 0;
  const percent = (value:number|null) => value===null ? "—" : `${Math.round(value*100)}%`;
  const intents = metrics ? Object.entries(metrics.intents).sort((a,b)=>b[1]-a[1]).slice(0,6) : [];
  const reasons = metrics ? Object.entries(metrics.handoffReasons).sort((a,b)=>b[1]-a[1]) : [];

  return <>
    <Toolbar actions={<button className="button" onClick={() => onNavigate("atendimento")}><Icon name="chat" size={16} />Abrir atendimentos</button>}>
      <h2 className="greeting">{greeting(hour)}, equipe BBNET</h2>
      <Segmented label="Período" value={period} options={PERIODS_SHORT} onChange={setPeriod} />
    </Toolbar>

    {loading ? <Loading stats={4} rows={4} /> : <>
      {(awaiting.count > 0 || incidents > 0 || (cockpit?.degraded.length ?? 0) > 0 || failed.cockpit || failed.overview) && <div className="attention">
        {awaiting.count > 0 && <button className="attention-item tone-warn" onClick={() => onNavigate("atendimento")}>
          <Icon name="clock" size={18} /><span><strong>{plural(awaiting.count,"cliente aguardando","clientes aguardando")} resposta</strong><small>{awaiting.oldest ? `O mais antigo espera há ${relativeTime(awaiting.oldest)}` : "Abra a caixa de entrada"}</small></span><Icon name="chevron-right" size={16} />
        </button>}
        {incidents > 0 && <button className="attention-item tone-bad" onClick={() => onNavigate("monitoramento")}>
          <Icon name="alert" size={18} /><span><strong>{plural(incidents,"massiva aberta","massivas abertas")}</strong><small>{cockpit?.affectedCustomers.value ? `${cockpit.affectedCustomers.value.toLocaleString("pt-BR")} clientes impactados (estimativa)` : "Veja em Rede e massivas"}</small></span><Icon name="chevron-right" size={16} />
        </button>}
        {(cockpit?.degraded.length ?? 0) > 0 && <Notice tone="warn" title="Fonte fora do ar:">{cockpit?.degraded.join(", ")}. Os números dela aparecem como “—”, nunca como zero.</Notice>}
        {(failed.cockpit || failed.overview) && <Notice tone="bad">Parte do painel não carregou. {failed.overview ? "Indicadores de atendimento indisponíveis." : ""} {failed.cockpit ? "Indicadores de negócio indisponíveis." : ""}</Notice>}
      </div>}

      <h3 className="section-title">Atendimento</h3>
      {overview && !overview.available
        ? <Notice tone="bad">{overview.detail ?? "Fonte de indicadores indisponível"} — nenhum número é exibido para não induzir a erro.</Notice>
        : metrics && <Stats>
          <Stat label="Conversas" icon="chat" value={metrics.conversations.toLocaleString("pt-BR")} hint={metrics.conversations ? `Canal ${channel?.enabled ? (observing ? "em observação" : "respondendo") : "desligado"}` : "Nenhuma no período"} />
          {observing
            ? <Stat label="Sugestões sem envio" icon="bot" value={metrics.suggestionsOnly.toLocaleString("pt-BR")} hint={metrics.handoffs ? `${metrics.handoffs} recomendariam transbordo` : "A IA sugere, o atendente envia"}
                info="Modo observação: a IA lê, classifica e propõe a resposta, mas nada é enviado sozinho. Por isso “resolvidas sem humano” fica em zero — sugestão não é atendimento resolvido." />
            : <Stat label="Resolvidas sem humano" icon="sparkles" value={percent(metrics.resolutionRate)} hint={metrics.conversations ? `${metrics.resolvedWithoutHuman} de ${metrics.conversations}` : "Sem base para calcular"} />}
          <Stat label="Transbordos" icon="users" value={metrics.handoffs.toLocaleString("pt-BR")} hint={metrics.handoffs ? "Passaram ou passariam para humano" : "Nenhum no período"} />
          <Stat label="CSAT médio" icon="check" value={metrics.csatAverage===null ? "—" : metrics.csatAverage.toFixed(1).replace(".",",")} hint={metrics.csatCount ? plural(metrics.csatCount,"avaliação","avaliações") : observing ? "Só é perguntado quando a IA responde" : "Nenhuma avaliação"} />
        </Stats>}

      <h3 className="section-title">Negócio</h3>
      {cockpit ? <Stats>
        <Stat label="Clientes ativos" icon="users" value={show(cockpit.activeCustomers)} hint={cockpit.activeCustomers.detail} />
        <Stat label="Faturas vencidas" icon="wallet" tone={cockpit.overdueInvoices.value ? "warn" : "neutral"} value={show(cockpit.overdueInvoices)} hint={cockpit.openInvoices.value !== null ? `de ${cockpit.openInvoices.value.toLocaleString("pt-BR")} em aberto` : cockpit.overdueInvoices.detail} />
        <Stat label="Meta do mês" icon="trending" value={show(cockpit.goalProgressPercent, (v) => `${v}%`)} hint={cockpit.goalProgressPercent.detail} />
        <Stat label="Massivas abertas" icon="network" tone={incidents ? "bad" : "neutral"} value={show(cockpit.openIncidents)} hint={cockpit.openIncidents.detail} />
        {cockpit.aiCost.value !== null && <Stat label="Custo de IA" icon="bot" value={money(cockpit.aiCost.value)} hint={cockpit.aiCost.detail} />}
      </Stats> : <Notice tone="bad">Indicadores de negócio indisponíveis agora.</Notice>}

      <div className="grid-2">
        <Card title="Últimas conversas" badge={channel && <Badge tone={channel.enabled ? "ok" : "warn"} dot>{channel.enabled ? "Canal ativo" : "Canal desligado"}</Badge>}
          actions={<button className="link-button" onClick={() => onNavigate("atendimento")}>Ver todas</button>} flush>
          {!overview?.queue.length
            ? <Empty icon="chat" title="Nenhuma conversa registrada">{channel?.enabled ? "O canal está ligado e aguardando mensagens." : "O canal do WhatsApp está desligado."}</Empty>
            : <div className="list">{overview.queue.map((item) => {
                const title = item.displayName ?? conversationLabel(item.externalConversationId);
                return <button className="list-item" key={`${item.channel}:${item.externalConversationId}`} onClick={() => onNavigate("atendimento", { conversation: `${item.channel}:${item.externalConversationId}` })}>
                  <Avatar name={title} label={item.displayName ? undefined : conversationLabel(item.externalConversationId).slice(-2)} />
                  <span className="list-text"><strong>{title}</strong><small>{item.intent ? intentLabel(item.intent) : "Sem desfecho registrado"} · {plural(item.messages,"mensagem","mensagens")}</small></span>
                  <span className="list-meta">{item.awaitingSince ? <Badge tone="warn">aguarda {relativeTime(item.awaitingSince)}</Badge> : <time>{relativeTime(item.lastAt)}</time>}</span>
                </button>;
              })}</div>}
        </Card>

        <Card title="Assuntos das conversas">
          {!metrics || metrics.conversations === 0
            ? <Empty icon="sparkles" title="Sem conversas no período">Nada a distribuir.</Empty>
            : <div className="bars">{intents.map(([intent, total]) => <Bar key={intent} label={intentLabel(intent)} value={total} max={metrics.conversations} display={`${Math.round(total/metrics.conversations*100)}%`} />)}</div>}
          {reasons.length > 0 && <div className="subsection">
            <h4>Por que passou para humano</h4>
            <div className="chips">{reasons.map(([reason, total]) => <span className="chip" key={reason}>{handoffLabel(reason)} <b>{total}</b></span>)}</div>
          </div>}
        </Card>
      </div>

      {cockpit && cockpit.recentActivity.length > 0 && <Card title="Atividade recente" badge={<Badge>da auditoria</Badge>} flush>
        <ol className="timeline">{cockpit.recentActivity.map((item) => <li key={item.id}>
          <i className={item.result === "success" ? "ok" : ""} />
          <div><strong>{ACTION_LABELS[item.action] ?? item.action}</strong><span>{item.actorId} · {item.entity}</span></div>
          <time>{relativeTime(item.createdAt)}</time>
        </li>)}</ol>
      </Card>}

      <Limits items={[
        ["Tempo médio de atendimento", "Depende de instrumentar o Langfuse. Em vez de estimar, fica de fora."],
        ...(cockpit?.aiCost.value === null ? [["Custo por conversa", "Mesma razão: sem o rastro do Langfuse não há custo medido."] as [string, string]] : []),
      ]} />
    </>}
  </>;
}
