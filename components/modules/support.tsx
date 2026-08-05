"use client";
import { useCallback, useEffect, useState } from "react";

export function SupportModule({view}:{view:"monitoramento"|"mapa-alertas"|"massivas"|"chamados"}){
  if(view==="mapa-alertas")return <AlertMap/>; if(view==="massivas")return <MassIncidents/>; if(view==="chamados")return <Tickets/>; return <MonitoringCenter/>;
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

function MonitoringCenter(){
  const {items,available,state}=useIncidents();
  const {data:tickets,state:ticketState}=useTickets(1);
  const open=items.filter(i=>i.status!=="resolved");
  // Na base inteira `items` é só a primeira página; a contagem verdadeira é o
  // `total` do IXC. Contar a página daria 25 chamados para um provedor com milhares.
  const fullBase=tickets?.scope==="full-base";
  const openTicketCount=fullBase?(tickets?.total??0):(tickets?.items.filter(t=>isOpenTicket(t.status)).length??0);
  return <main className="content">
    <Heading title="Centro de Monitoramento" text="O que existe de medido hoje: massivas registradas pela operação e ordens de serviço do IXC."/>
    <section className="metrics">
      <Metric label="Massivas em aberto" value={state==="ready"&&available?String(open.length):"—"} detail={state==="ready"&&available?(open.length?`${open.reduce((sum,i)=>sum+i.affectedCustomers,0)} clientes estimados`:"Nenhuma massiva aberta"):"Registro indisponível"}/>
      <Metric label="Chamados em aberto" value={ticketState==="ready"&&tickets?.available?openTicketCount.toLocaleString("pt-BR"):"—"} detail={ticketState==="ready"&&tickets?.available?(fullBase?"Fila real do IXC, base inteira":`De ${tickets.items.length} OS dos cadastros da allowlist`):"IXC indisponível"}/>
      <Metric label="Alertas de rede" value="—" detail="Sem integração de monitoramento conectada"/>
      <Metric label="Clientes impactados" value="—" detail="Depende do monitoramento de rede"/>
    </section>
    <AiMetrics/>
    <div className="support-grid">
      <section className="data-card"><div className="card-header"><strong>Massivas registradas</strong><span className={`badge ${open.length?"amber":"green"}`}>{open.length?"● atenção necessária":"● nada em aberto"}</span></div>
        {state==="loading"&&<p style={{padding:14}}>Carregando…</p>}
        {state==="error"&&<p style={{padding:14}}>Não foi possível consultar as massivas.</p>}
        {state==="ready"&&!available&&<p style={{padding:14}}>Registro de massivas indisponível.</p>}
        {state==="ready"&&available&&items.length===0&&<p style={{padding:14,lineHeight:1.6,color:"#64748b"}}>Nenhuma massiva registrada. Elas são cadastradas por uma pessoa na tela de Massivas — não existe integração de monitoramento alimentando isso automaticamente.</p>}
        {items.map(i=><IncidentRow incident={i} key={i.id}/>)}
      </section>
      <section className="data-card"><div className="card-header"><strong>Fontes desta tela</strong><span className="badge blue">Origem declarada</span></div><div style={{padding:16,fontSize:12,lineHeight:1.9,color:"#40566d"}}>
        <p><strong>Massivas</strong> — banco do LZR HUB, registradas manualmente.</p>
        <p><strong>Chamados</strong> — ordens de serviço reais do IXC, limitadas aos cadastros da allowlist.</p>
        <p><strong>IA de Atendimento</strong> — desfechos e avaliações das conversas gravadas.</p>
        <p style={{marginTop:12,paddingTop:12,borderTop:"1px solid #e2e8f0"}}><strong>O que não temos:</strong> alerta de rede, potência de ONU em massa e correlação geográfica automática. Isso exigiria integrar o monitoramento da rede (SmartOLT, Zabbix ou equivalente), que ainda não está conectado. Enquanto não estiver, esses campos ficam em branco em vez de estimados.</p>
      </div></section>
    </div>
  </main>;
}

function AlertMap(){
  const {items,available,state}=useIncidents();
  const open=items.filter(i=>i.status!=="resolved");
  const byCity=Object.entries(open.reduce<Record<string,{count:number;affected:number}>>((acc,i)=>{const key=`${i.city} • ${i.neighborhood}`;acc[key]={count:(acc[key]?.count??0)+1,affected:(acc[key]?.affected??0)+i.affectedCustomers};return acc},{}));
  return <main className="content">
    <Heading title="Mapa de Alertas" text="Agrupamento por cidade e bairro das massivas registradas. Sem coordenada de cliente."/>
    {state==="loading"&&<div className="state-card">Carregando…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível consultar as massivas.</div>}
    {state==="ready"&&!available&&<div className="state-card error">Registro de massivas indisponível.</div>}
    {state==="ready"&&available&&open.length===0&&<div className="state-card"><strong>Nenhuma região com massiva aberta.</strong><p style={{marginTop:6,lineHeight:1.6}}>Este mapa mostra as massivas que a operação registrar. Um mapa de alertas automático dependeria de integrar o monitoramento da rede, que ainda não existe aqui — por isso não há pino de exemplo.</p></div>}
    {open.length>0&&<div className="support-grid">
      <section className="data-card"><div className="card-header"><strong>Regiões afetadas</strong><span className="badge amber">{byCity.length} região(ões)</span></div>
        {byCity.map(([region,{count,affected}])=><div className="incident-row" key={region}><i className="severity-dot high"/><div><strong>{region}</strong><span>{count} massiva(s) em aberto</span></div><div><b>{affected}</b><small>clientes</small></div></div>)}
      </section>
      <section className="data-card"><div className="card-header"><strong>Massivas em aberto</strong></div>{open.map(i=><IncidentRow incident={i} key={i.id}/>)}</section>
    </div>}
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
    <Heading title="Massivas" text="Registre e encerre incidentes de rede. O registro fica auditado; nenhum cliente é comunicado por aqui."/>
    <div className="support-grid">
      <section className="data-card"><div className="card-header"><strong>Registrar massiva</strong><span className="badge blue">Fica auditado</span></div>
        <div style={{padding:16,display:"grid",gap:10}}>
          <input placeholder="O que está acontecendo (ex.: rompimento de fibra no anel norte)" value={form.title} onChange={set("title")}/>
          <input placeholder="Cidade" value={form.city} onChange={set("city")}/>
          <input placeholder="Bairro ou região" value={form.neighborhood} onChange={set("neighborhood")}/>
          <input placeholder="Equipamento (opcional — ex.: OLT-ITA-02 / PON 4)" value={form.equipment} onChange={set("equipment")}/>
          <input placeholder="Clientes afetados (estimativa)" inputMode="numeric" value={form.affectedCustomers} onChange={set("affectedCustomers")}/>
          <select value={form.severity} onChange={set("severity")}><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="critical">Crítica</option></select>
          {error&&<p style={{color:"#b91c1c",fontSize:12}}>{error}</p>}
          <button className="button" disabled={busy} onClick={()=>void submit()}>{busy?"Registrando…":"Registrar massiva"}</button>
          <p style={{fontSize:11,color:"#64748b",lineHeight:1.6}}>A estimativa de clientes é sua: o sistema não consegue calcular isso sozinho enquanto não houver integração com o monitoramento da rede.</p>
        </div>
      </section>
      <section className="data-card"><div className="card-header"><strong>Massivas registradas</strong><span className="badge green">{items.length} registro(s)</span></div>
        {state==="loading"&&<p style={{padding:14}}>Carregando…</p>}
        {state==="error"&&<p style={{padding:14}}>Não foi possível consultar as massivas.</p>}
        {state==="ready"&&!available&&<p style={{padding:14}}>Registro de massivas indisponível.</p>}
        {state==="ready"&&available&&items.length===0&&<p style={{padding:14,color:"#64748b",lineHeight:1.6}}>Nenhuma massiva registrada ainda.</p>}
        {items.map(i=><div key={i.id}><IncidentRow incident={i}/>{i.status!=="resolved"&&<div style={{padding:"0 16px 14px"}}><button className="button secondary" disabled={busy} onClick={()=>void close(i.id)}>Encerrar</button></div>}</div>)}
      </section>
    </div>
  </main>;
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
        : <section className="data-card">
            <div className="data-row header"><span>OS / {fullBase?"local":"cliente"}</span><span>Assunto</span><span>Status</span><span>Aberta em</span><span></span></div>
            {items.map(t=><div className="data-row" key={t.id}><span><strong>{t.id}</strong><small>{fullBase?`Cadastro ${t.customerId}${t.address?` • ${t.address}`:""}`:`${t.customerName} • ${t.city}`}</small></span><span>{t.subject.slice(0,90)}</span><span><i className={`severity ${isOpenTicket(t.status)?"high":"low"}`}>{isOpenTicket(t.status)?"Em aberto":"Encerrada"}</i></span><span>{dateLabel(t.openedAt)}</span><span>›</span></div>)}
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
