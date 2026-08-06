"use client";
import { useCallback, useEffect, useState } from "react";

export function SupportModule({view,onNavigateMassivas}:{view:"monitoramento"|"mapa-alertas"|"massivas"|"chamados";onNavigateMassivas?:()=>void}){
  if(view==="mapa-alertas")return <AlertMap/>; if(view==="massivas")return <MassIncidents/>; if(view==="chamados")return <Tickets/>; return <MonitoringCenter onNavigateMassivas={onNavigateMassivas}/>;
}

type Incident={id:string;title:string;severity:"low"|"medium"|"high"|"critical";status:"investigating"|"monitoring"|"resolved";city:string;neighborhood:string;equipment:string|null;affectedCustomers:number;startedAt:string;endedAt:string|null};
type Ticket={id:string;customerId:string;customerName:string|null;city:string|null;address?:string|null;subject:string;status:string;openedAt:string|null;closedAt:string|null};
type TicketPayload={available:boolean;detail?:string;scope:string;allowlistSize?:number;unavailableCustomers?:number;total?:number;page?:number;pageSize?:number;items:Ticket[]};

/** OS aberta no IXC: "F" e "finalizada" marcam encerramento; o resto segue em aberto. */
const isOpenTicket=(status:string)=>!/^f$|finaliz|encerr|conclu/i.test(status.trim());
const dateLabel=(value:string|null)=>{if(!value)return "—";const parsed=new Date(value);return Number.isNaN(parsed.getTime())?value:parsed.toLocaleDateString("pt-BR")};

function useIncidents(){
  const [items,setItems]=useState<Incident[]>([]);const [available,setAvailable]=useState(true);const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  // `nonce` é o gatilho de recarga: manter o efeito como única origem do fetch
  // evita atualizar estado de forma síncrona dentro dele.
  const [nonce,setNonce]=useState(0);
  useEffect(()=>{let active=true;
    fetch("/api/support/incidents").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:{available:boolean;items:Incident[]})=>{if(active){setAvailable(payload.available);setItems(payload.items??[]);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[nonce]);
  const reload=useCallback(()=>setNonce(current=>current+1),[]);
  return {items,available,state,reload};
}

function useTickets(page:number){
  const [data,setData]=useState<TicketPayload|null>(null);const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  useEffect(()=>{let active=true;
    fetch(`/api/support/tickets?page=${page}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:TicketPayload)=>{if(active){setData(payload);setState("ready")}}).catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[page]);
  return {data,state};
}

type NetworkAlert={id:string;kind:string;equipment:string;description:string|null;status:"open"|"resolved";startedAt:string;resolvedAt:string|null;parsed:boolean};
type NetworkAlertsPayload={available:boolean;detail?:string;open:NetworkAlert[];recent:NetworkAlert[];suggestMassiva:boolean;threshold?:number};

/** Alertas reais do Telegram, não simulados — atualiza sozinho, é para ficar aberto num monitor de NOC. */
function useNetworkAlerts(refreshMs=30_000){
  const [data,setData]=useState<NetworkAlertsPayload|null>(null);const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  useEffect(()=>{let active=true;
    const load=()=>fetch("/api/support/network-alerts?period=24h").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:NetworkAlertsPayload)=>{if(active){setData(payload);setState("ready")}}).catch(()=>{if(active)setState("error")});
    load();
    const timer=setInterval(load,refreshMs);
    return()=>{active=false;clearInterval(timer)}},[refreshMs]);
  return {data,state};
}

const ALERT_KIND_LABELS:Record<string,string>={olt_interface:"Interface de OLT",fiber_link:"Possível rompimento de fibra",unrecognized:"Formato não reconhecido"};

function MonitoringCenter({onNavigateMassivas}:{onNavigateMassivas?:()=>void}){
  const {items,available,state}=useIncidents();
  const {data:tickets,state:ticketState}=useTickets(1);
  const {data:alerts,state:alertState}=useNetworkAlerts();
  const open=items.filter(i=>i.status!=="resolved");
  // Na base inteira `items` é só a primeira página; a contagem verdadeira é o
  // `total` do IXC. Contar a página daria 25 chamados para um provedor com milhares.
  const fullBase=tickets?.scope==="full-base";
  const openTicketCount=fullBase?(tickets?.total??0):(tickets?.items.filter(t=>isOpenTicket(t.status)).length??0);
  const openAlerts=alerts?.open??[];
  return <main className="content">
    <Heading title="Centro de Monitoramento" text="O que existe de medido hoje: massivas registradas pela operação, alertas reais do Telegram e ordens de serviço do IXC."/>
    <section className="metrics">
      <Metric label="Massivas em aberto" value={state==="ready"&&available?String(open.length):"—"} detail={state==="ready"&&available?(open.length?`${open.reduce((sum,i)=>sum+i.affectedCustomers,0)} clientes estimados`:"Nenhuma massiva aberta"):"Registro indisponível"}/>
      <Metric label="Chamados em aberto" value={ticketState==="ready"&&tickets?.available?openTicketCount.toLocaleString("pt-BR"):"—"} detail={ticketState==="ready"&&tickets?.available?(fullBase?"Fila real do IXC, base inteira":`De ${tickets.items.length} OS dos cadastros da allowlist`):"IXC indisponível"}/>
      <Metric label="Alertas de rede" value={alertState==="ready"&&alerts?.available?String(openAlerts.length):"—"} detail={alertState==="ready"&&alerts?.available?"Abertos agora, via Telegram":alerts?.detail??"Sem integração conectada"}/>
      <Metric label="Clientes impactados" value="—" detail="Depende de decodificar local do equipamento"/>
    </section>
    {alerts?.suggestMassiva&&<div className="state-card error" style={{marginTop:14}}>
      <strong>{openAlerts.length} alertas de rede abertos ao mesmo tempo</strong> — pode ser um problema regional. O nome do equipamento não é decodificado em cidade/bairro automaticamente; confira os alertas abaixo e registre uma massiva se fizer sentido.
      {onNavigateMassivas&&<div style={{marginTop:8}}><button className="button secondary" onClick={onNavigateMassivas}>Ir para Massivas</button></div>}
    </div>}
    <AiMetrics/>
    <div className="support-grid">
      <section className="data-card"><div className="card-header"><strong>Massivas registradas</strong><span className={`badge ${open.length?"amber":"green"}`}>{open.length?"● atenção necessária":"● nada em aberto"}</span></div>
        {state==="loading"&&<p style={{padding:14}}>Carregando…</p>}
        {state==="error"&&<p style={{padding:14}}>Não foi possível consultar as massivas.</p>}
        {state==="ready"&&!available&&<p style={{padding:14}}>Registro de massivas indisponível.</p>}
        {state==="ready"&&available&&items.length===0&&<p style={{padding:14,lineHeight:1.6,color:"var(--muted)"}}>Nenhuma massiva registrada. Elas são cadastradas por uma pessoa na tela de Massivas — não existe integração de monitoramento alimentando isso automaticamente.</p>}
        {items.map(i=><IncidentRow incident={i} key={i.id}/>)}
      </section>
      <section className="data-card"><div className="card-header"><strong>Alertas de rede (Telegram)</strong><span className="badge blue">{alertState==="ready"&&alerts?.available?`${openAlerts.length} aberto(s)`:"origem declarada"}</span></div>
        {alertState==="loading"&&<p style={{padding:14}}>Carregando…</p>}
        {alertState==="ready"&&!alerts?.available&&<p style={{padding:14,lineHeight:1.6,color:"var(--muted)"}}>{alerts?.detail}.</p>}
        {alertState==="ready"&&alerts?.available&&openAlerts.length===0&&<p style={{padding:14,color:"var(--muted)"}}>Nenhum alerta aberto agora.</p>}
        {openAlerts.map(a=><NetworkAlertRow alert={a} key={a.id}/>)}
      </section>
    </div>
    <section className="data-card" style={{marginTop:14}}><div className="card-header"><strong>Fontes desta tela</strong><span className="badge blue">Origem declarada</span></div><div style={{padding:16,fontSize:12,lineHeight:1.9,color:"var(--text-2)"}}>
      <p><strong>Massivas</strong> — banco do LZR HUB, registradas manualmente.</p>
      <p><strong>Alertas de rede</strong> — grupo de Telegram onde o monitoramento posta queda e normalização, recebido por webhook. O código do equipamento (OLT-ZTE-CDB-SUP-02, por exemplo) não é decodificado em cidade/bairro: mostrar o código bruto é mais honesto que adivinhar geografia.</p>
      <p><strong>Chamados</strong> — ordens de serviço reais do IXC, limitadas aos cadastros da allowlist.</p>
      <p><strong>IA de Atendimento</strong> — desfechos e avaliações das conversas gravadas.</p>
      <p style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--line)"}}><strong>O que ainda não temos:</strong> potência de ONU em massa e correlação geográfica automática dos alertas. Isso exigiria uma tabela de tradução do código do equipamento para cidade/bairro, que ainda não existe.</p>
    </div></section>
  </main>;
}

function NetworkAlertRow({alert:a}:{alert:NetworkAlert}){
  return <div className="incident-row">
    <i className={`severity-dot ${a.kind==="unrecognized"?"medium":"high"}`}/>
    <div><strong>{a.equipment}</strong><span>{ALERT_KIND_LABELS[a.kind]??a.kind}{a.description?` • ${a.description}`:""}</span><small>desde {new Date(a.startedAt).toLocaleString("pt-BR")}</small></div>
    <div><i className={`severity ${a.kind==="unrecognized"?"medium":"high"}`}>{a.status==="open"?"Aberto":"Resolvido"}</i></div>
  </div>;
}

function AlertMap(){
  const {items,available,state}=useIncidents();
  const {data:alerts,state:alertState}=useNetworkAlerts();
  const open=items.filter(i=>i.status!=="resolved");
  const openAlerts=alerts?.open??[];
  const byCity=Object.entries(open.reduce<Record<string,{count:number;affected:number}>>((acc,i)=>{const key=`${i.city} • ${i.neighborhood}`;acc[key]={count:(acc[key]?.count??0)+1,affected:(acc[key]?.affected??0)+i.affectedCustomers};return acc},{}));
  return <main className="content">
    <Heading title="Mapa de Alertas" text="Agrupamento por cidade e bairro das massivas registradas. Sem coordenada de cliente."/>
    {state==="loading"&&<div className="state-card">Carregando…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível consultar as massivas.</div>}
    {state==="ready"&&!available&&<div className="state-card error">Registro de massivas indisponível.</div>}
    {state==="ready"&&available&&open.length===0&&<div className="state-card"><strong>Nenhuma região com massiva aberta.</strong><p style={{marginTop:6,lineHeight:1.6}}>Este mapa mostra as massivas que a operação registrar. Um mapa de alertas automático dependeria de decodificar o código do equipamento em cidade/bairro, que ainda não existe — por isso não há pino de exemplo.</p></div>}
    {open.length>0&&<div className="support-grid">
      <section className="data-card"><div className="card-header"><strong>Regiões afetadas</strong><span className="badge amber">{byCity.length} região(ões)</span></div>
        {byCity.map(([region,{count,affected}])=><div className="incident-row" key={region}><i className="severity-dot high"/><div><strong>{region}</strong><span>{count} massiva(s) em aberto</span></div><div><b>{affected}</b><small>clientes</small></div></div>)}
      </section>
      <section className="data-card"><div className="card-header"><strong>Massivas em aberto</strong></div>{open.map(i=><IncidentRow incident={i} key={i.id}/>)}</section>
    </div>}
    {alertState==="ready"&&alerts?.available&&openAlerts.length>0&&<section className="data-card" style={{marginTop:14}}>
      <div className="card-header"><strong>Alertas de rede sem local decodificado</strong><span className="badge blue">{openAlerts.length} aberto(s)</span></div>
      <p style={{padding:"0 16px",margin:"10px 0",fontSize:11,color:"var(--muted)",lineHeight:1.6}}>Estes alertas vêm do Telegram com o código bruto do equipamento — sem tradução confirmada para cidade/bairro, não entram no agrupamento por região acima.</p>
      {openAlerts.map(a=><NetworkAlertRow alert={a} key={a.id}/>)}
    </section>}
  </main>;
}

const EMPTY_FORM={title:"",severity:"high",city:"",neighborhood:"",equipment:"",affectedCustomers:""};

function MassIncidents(){
  const {items,available,state,reload}=useIncidents();
  const [form,setForm]=useState(EMPTY_FORM);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  async function submit(){
    setBusy(true);setError("");
    const response=await fetch("/api/support/incidents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...form,affectedCustomers:Number(form.affectedCustomers||0)})});
    if(response.ok){setForm(EMPTY_FORM);reload()}
    else{const payload=await response.json().catch(()=>({}));setError(payload.error??"Não foi possível registrar a massiva")}
    setBusy(false);
  }
  async function close(id:string){
    setBusy(true);
    await fetch("/api/support/incidents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"close",id})});
    reload();setBusy(false);
  }

  const set=(key:keyof typeof EMPTY_FORM)=>(event:{target:{value:string}})=>setForm(current=>({...current,[key]:event.target.value}));
  return <main className="content">
    <Heading title="Massivas" text="Registre, avise a área afetada e encerre incidentes de rede. Tudo fica auditado."/>
    <div className="support-grid">
      <section className="data-card"><div className="card-header"><strong>Registrar massiva</strong><span className="badge blue">Fica auditado</span></div>
        <div style={{padding:16,display:"grid",gap:10}}>
          {/* Rótulo visível, não só placeholder: o placeholder some ao digitar. */}
          <label className="field"><span>O que está acontecendo</span><input placeholder="ex.: rompimento de fibra no anel norte" value={form.title} onChange={set("title")}/></label>
          <label className="field"><span>Cidade</span><input placeholder="ex.: Itabaiana" value={form.city} onChange={set("city")}/></label>
          <label className="field"><span>Bairro ou região</span><input placeholder="ex.: Centro" value={form.neighborhood} onChange={set("neighborhood")}/></label>
          <label className="field"><span>Equipamento (opcional)</span><input placeholder="ex.: OLT-ITA-02 / PON 4" value={form.equipment} onChange={set("equipment")}/></label>
          <label className="field"><span>Clientes afetados (estimativa)</span><input placeholder="ex.: 340" inputMode="numeric" value={form.affectedCustomers} onChange={set("affectedCustomers")}/></label>
          <label className="field"><span>Severidade</span><select value={form.severity} onChange={set("severity")}><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="critical">Crítica</option></select></label>
          {error&&<p style={{color:"var(--bad)",fontSize:12}}>{error}</p>}
          <button className="button" disabled={busy} onClick={()=>void submit()}>{busy?"Registrando…":"Registrar massiva"}</button>
          <p style={{fontSize:11,color:"var(--muted)",lineHeight:1.6}}>A estimativa de clientes é sua: o sistema não consegue calcular isso sozinho enquanto não houver integração com o monitoramento da rede. Avisar, abaixo, casa a área da massiva com a cidade e bairro reais do cadastro — não com esta estimativa.</p>
        </div>
      </section>
      <section className="data-card"><div className="card-header"><strong>Massivas registradas</strong><span className="badge green">{items.length} registro(s)</span></div>
        {state==="loading"&&<p style={{padding:14}}>Carregando…</p>}
        {state==="error"&&<p style={{padding:14}}>Não foi possível consultar as massivas.</p>}
        {state==="ready"&&!available&&<p style={{padding:14}}>Registro de massivas indisponível.</p>}
        {state==="ready"&&available&&items.length===0&&<p style={{padding:14,color:"var(--muted)",lineHeight:1.6}}>Nenhuma massiva registrada ainda.</p>}
        {items.map(i=><div key={i.id}>
          <IncidentRow incident={i}/>
          <div style={{padding:"0 16px 14px",display:"flex",gap:8,flexWrap:"wrap"}}>
            <NotifyButton incidentId={i.id} kind="opened" label="Avisar clientes da área" busy={busy}/>
            {i.status==="resolved"&&<NotifyButton incidentId={i.id} kind="closed" label="Avisar normalização" busy={busy}/>}
            {i.status!=="resolved"&&<button className="button secondary" disabled={busy} onClick={()=>void close(i.id)}>Encerrar</button>}
          </div>
        </div>)}
      </section>
    </div>
  </main>;
}

type NoticeResult={kind:"opened"|"closed";matched:number;recorded:number;duplicates:number;enqueued:number;queueEnabled:boolean;capped:boolean};

/**
 * Avisa quem está na área da massiva, revalidando cidade e bairro contra o
 * cadastro real na hora do clique — não contra a estimativa digitada no
 * formulário. Ver mass-notice-service.ts para o limite do que "avisar"
 * significa sem ponte de envio ligada ao WhatsApp.
 */
function NotifyButton({incidentId,kind,label,busy}:{incidentId:string;kind:"opened"|"closed";label:string;busy:boolean}){
  const [running,setRunning]=useState(false);
  const [result,setResult]=useState<NoticeResult|null>(null);
  const [error,setError]=useState<string|null>(null);

  async function run(){
    setRunning(true);setError(null);setResult(null);
    const response=await fetch("/api/support/incidents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"notify",id:incidentId,kind})});
    const payload=await response.json();
    if(response.ok)setResult(payload);else setError(payload.error??"Não foi possível avisar.");
    setRunning(false);
  }

  return <div style={{display:"grid",gap:4}}>
    <button className="button secondary" disabled={busy||running} onClick={()=>void run()}>{running?"Avisando…":label}</button>
    {error&&<small style={{color:"var(--bad)"}}>{error}</small>}
    {result&&<small style={{color:"var(--text-3)",maxWidth:260}}>
      {result.matched} na área, {result.recorded} novo(s){result.duplicates>0?`, ${result.duplicates} já avisado(s) antes`:""}.
      {result.queueEnabled?` ${result.enqueued} enfileirado(s).`:" Fila de envio desligada — só registrado."}
    </small>}
  </div>;
}

function Tickets(){
  const [page,setPage]=useState(1);
  const {data,state}=useTickets(page);
  const [onlyOpen,setOnlyOpen]=useState(true);
  const fullBase=data?.scope==="full-base";
  // Na base inteira o próprio IXC já devolve só as não fechadas; filtrar de novo
  // aqui esconderia parte da página sem reduzir o total, o que confunde.
  const items=fullBase?(data?.items??[]):(data?.items??[]).filter(t=>!onlyOpen||isOpenTicket(t.status));
  return <main className="content">
    <Heading title="Chamados" text="Ordens de serviço reais do IXC."/>
    {state==="loading"&&<div className="state-card">Consultando o IXC…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível consultar os chamados.</div>}
    {state==="ready"&&!data?.available&&<div className="state-card error">{data?.detail??"Fonte de chamados indisponível"}.</div>}
    {state==="ready"&&data?.available&&<>
      {fullBase
        ? <div className="state-card">Fila real do provedor: <strong>{(data.total??0).toLocaleString("pt-BR")}</strong> OS ainda não fechadas. O IXC não devolve o nome do cliente na OS — buscar linha a linha seria uma consulta por item, então a fila mostra o código do cadastro e o endereço do atendimento.</div>
        : <div className="state-card">Mostrando as OS dos <strong>{data.allowlistSize} cadastro(s)</strong> liberados na allowlist do IXC — trava nossa, de homologação, não é a fila inteira do provedor.{data.unavailableCustomers?` ${data.unavailableCustomers} cadastro(s) não responderam.`:""}</div>}
      {!fullBase&&<section className="filter-bar"><select value={onlyOpen?"open":"all"} onChange={e=>setOnlyOpen(e.target.value==="open")}><option value="open">Só em aberto</option><option value="all">Todas as OS</option></select></section>}
      {items.length===0
        ? <div className="state-card">Nenhuma OS {onlyOpen&&!fullBase?"em aberto":"encontrada"} nos cadastros consultados.</div>
        : <section className="data-card tickets">
            <div className="data-row header"><span>OS / {fullBase?"local":"cliente"}</span><span>Assunto</span><span>Status</span><span>Aberta em</span><span></span></div>
            {items.map(t=><div className="data-row" key={t.id}><span><strong>{t.id}</strong><small>{fullBase?`Cadastro ${t.customerId}${t.address?` • ${t.address}`:""}`:`${t.customerName} • ${t.city}`}</small></span>{/* O assunto do IXC vem com o processo inteiro descrito e quebrava a linha em
    seis; truncar na exibição mantém a fila legível e o texto completo no title. */}
<span className="cell-clip" title={t.subject}>{t.subject}</span><span><i className={`severity ${isOpenTicket(t.status)?"high":"low"}`}>{isOpenTicket(t.status)?"Em aberto":"Encerrada"}</i></span><span>{dateLabel(t.openedAt)}</span><span>›</span></div>)}
            {fullBase&&<div className="pagination"><span>{((data.page??1)-1)*(data.pageSize??25)+1}–{((data.page??1)-1)*(data.pageSize??25)+items.length} de {(data.total??0).toLocaleString("pt-BR")}</span><button disabled={page<=1} onClick={()=>setPage(page-1)}>‹</button><button disabled={((data.page??1)-1)*(data.pageSize??25)+items.length>=(data.total??0)} onClick={()=>setPage(page+1)}>›</button></div>}
          </section>}
    </>}
  </main>;
}

type SupportMetricsPayload={period:string;available:boolean;conversations?:number;resolvedWithoutHuman?:number;resolutionRate?:number|null;handoffs?:number;suggestionsOnly?:number;csatAverage?:number|null;csatCount?:number;detail?:string};
const PERIOD_LABELS:Record<string,string>={"24h":"24 horas","7d":"7 dias","30d":"30 dias"};
function AiMetrics(){
  const [period,setPeriod]=useState("7d");const [data,setData]=useState<SupportMetricsPayload|null>(null);
  useEffect(()=>{let active=true;
    fetch(`/api/support/metrics?period=${period}`).then(r=>r.json()).then(payload=>{if(active)setData(payload)}).catch(()=>{if(active)setData({period,available:false,detail:"Falha ao consultar métricas"})});
    return()=>{active=false}},[period]);
  const loading=data?.period!==period;
  const percent=(value:number|null|undefined)=>value===null||value===undefined?"—":`${Math.round(value*100)}%`;
  const average=(value:number|null|undefined)=>value===null||value===undefined?"—":value.toFixed(2);
  return <section className="data-card"><div className="card-header"><strong>IA de Atendimento N1</strong><span className="badge blue">{PERIOD_LABELS[period]}</span></div>
    <div className="wizard-progress" style={{display:"flex",gap:8,marginBottom:12}}>{Object.keys(PERIOD_LABELS).map(key=><button key={key} className={`button ${key===period?"":"secondary"}`} onClick={()=>setPeriod(key)}>{PERIOD_LABELS[key]}</button>)}</div>
    {loading?<p>Carregando métricas…</p>:!data?.available?<p>Métricas indisponíveis: {data?.detail??"fonte não configurada"}. Conecte o banco de dados para começar a medir.</p>:
      <section className="metrics">
        <Metric label="Resolvido sem humano" value={percent(data.resolutionRate)} detail={`${data.resolvedWithoutHuman??0} de ${data.conversations??0} conversas`}/>
        <Metric label="CSAT médio" value={average(data.csatAverage)} detail={`${data.csatCount??0} avaliação(ões)`}/>
        <Metric label={data.suggestionsOnly?"Sugestões sem envio":"Transbordos"} value={String(data.suggestionsOnly||data.handoffs||0)} detail={data.suggestionsOnly?"Canal em modo observação":"Passaram para atendente"}/>
        <Metric label="Custo por atendimento" value="—" detail="Requer Langfuse (issue #6)"/>
      </section>}
  </section>;
}

const SEVERITY_LABELS:Record<string,string>={low:"baixa",medium:"média",high:"alta",critical:"crítica"};
const STATUS_LABELS:Record<string,string>={investigating:"Investigando",monitoring:"Monitorando",resolved:"Encerrada"};
function IncidentRow({incident:i}:{incident:Incident}){return <div className="incident-row"><i className={`severity-dot ${i.severity}`}/><div><strong>{i.title}</strong><span>{i.city} • {i.neighborhood}{i.equipment?` • ${i.equipment}`:""}</span><small>{STATUS_LABELS[i.status]??i.status} • aberta em {dateLabel(i.startedAt)}{i.endedAt?` • encerrada em ${dateLabel(i.endedAt)}`:""}</small></div><div><b>{i.affectedCustomers}</b><small>clientes</small><i className={`severity ${i.severity}`}>{SEVERITY_LABELS[i.severity]??i.severity}</i></div></div>}
function Heading({title,text}:{title:string;text:string}){return <div className="page-heading"><div><h1>{title}</h1><p>{text}</p></div></div>}
function Metric({label,value,detail}:{label:string;value:string;detail:string}){return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">⌁</span></div><strong>{value}</strong><small>{detail}</small></article>}
