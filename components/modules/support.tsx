"use client";
import { useCallback, useEffect, useState } from "react";
import type { Navigate } from "@/components/lzr-hub-app";
import { Icon } from "@/components/ui/icons";
import { Badge, Card, Empty, InfoTip, Limits, Loading, Modal, Notice, Stat, Stats, Toolbar, count, dateOnly, plural, useToast } from "@/components/ui/kit";

export function SupportModule({view,onNavigate}:{view:"monitoramento"|"mapa-alertas"|"massivas"|"chamados";onNavigate:Navigate}){
  if(view==="mapa-alertas")return <AlertMap/>; if(view==="massivas")return <MassIncidents/>; if(view==="chamados")return <Tickets/>; return <MonitoringCenter onNavigate={onNavigate}/>;
}

type Incident={id:string;title:string;severity:"low"|"medium"|"high"|"critical";status:"investigating"|"monitoring"|"resolved";city:string;neighborhood:string;equipment:string|null;affectedCustomers:number;startedAt:string;endedAt:string|null};
type Ticket={id:string;customerId:string;customerName:string|null;city:string|null;address?:string|null;subject:string;status:string;openedAt:string|null;closedAt:string|null};
type TicketPayload={available:boolean;detail?:string;scope:string;allowlistSize?:number;unavailableCustomers?:number;total?:number;page?:number;pageSize?:number;items:Ticket[]};

/** OS aberta no IXC: "F" e "finalizada" marcam encerramento; o resto segue em aberto. */
const isOpenTicket=(status:string)=>!/^f$|finaliz|encerr|conclu/i.test(status.trim());

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
  const [data,setData]=useState<TicketPayload|null>(null);const [loadedPage,setLoadedPage]=useState<number|null>(null);const [failed,setFailed]=useState(false);
  useEffect(()=>{let active=true;
    fetch(`/api/support/tickets?page=${page}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:TicketPayload)=>{if(active){setData(payload);setFailed(false);setLoadedPage(page)}}).catch(()=>{if(active){setFailed(true);setLoadedPage(page)}});
    return()=>{active=false}},[page]);
  return {data,state:loadedPage!==page?"loading":failed?"error":"ready" as "loading"|"ready"|"error"};
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
const SEVERITY_LABELS:Record<string,string>={low:"baixa",medium:"média",high:"alta",critical:"crítica"};
const STATUS_LABELS:Record<string,string>={investigating:"Investigando",monitoring:"Monitorando",resolved:"Encerrada"};

function MonitoringCenter({onNavigate}:{onNavigate:Navigate}){
  const {items,available,state}=useIncidents();
  const {data:tickets,state:ticketState}=useTickets(1);
  const {data:alerts,state:alertState}=useNetworkAlerts();
  const open=items.filter(i=>i.status!=="resolved");
  // Na base inteira `items` é só a primeira página; a contagem verdadeira é o
  // `total` do IXC. Contar a página daria 25 chamados para um provedor com milhares.
  const fullBase=tickets?.scope==="full-base";
  const openTicketCount=fullBase?(tickets?.total??0):(tickets?.items.filter(t=>isOpenTicket(t.status)).length??0);
  const openAlerts=alerts?.open??[];
  const affected=open.reduce((sum,i)=>sum+i.affectedCustomers,0);
  return <>
    {alerts?.suggestMassiva&&<Notice tone="bad" title={`${openAlerts.length} alertas de rede abertos ao mesmo tempo`}
      action={<button className="button secondary small" onClick={()=>onNavigate("massivas")}>Registrar massiva</button>}
      more="O nome do equipamento não é decodificado em cidade/bairro automaticamente: confira os alertas abaixo antes de registrar.">pode ser um problema regional.</Notice>}
    <Stats>
      <Stat label="Massivas em aberto" icon="network" tone={open.length?"bad":"neutral"} value={state==="ready"&&available?count(open.length):"—"} hint={state==="ready"&&available?(open.length?`${count(affected)} clientes estimados`:"Nenhuma aberta"):"Registro indisponível"}/>
      <Stat label="Alertas de rede" icon="alert" tone={openAlerts.length?"warn":"neutral"} value={alertState==="ready"&&alerts?.available?count(openAlerts.length):"—"} hint={alertState==="ready"&&alerts?.available?"Abertos agora, via Telegram":alerts?.detail??"Sem integração conectada"}/>
      <Stat label="Chamados em aberto" icon="ticket" value={ticketState==="ready"&&tickets?.available?count(openTicketCount):"—"} hint={ticketState==="ready"&&tickets?.available?(fullBase?"Fila real do IXC":`Das OS da allowlist`):ticketState==="loading"?"Consultando o IXC…":"IXC indisponível"}/>
    </Stats>
    <div className="grid-2 even">
      <Card title="Massivas" badge={<Badge tone={open.length?"warn":"ok"} dot>{open.length?`${open.length} aberta(s)`:"nada em aberto"}</Badge>}
        actions={<button className="link-button" onClick={()=>onNavigate("massivas")}>Gerenciar</button>} flush>
        {state==="loading"&&<Loading rows={2} />}
        {state==="error"&&<div className="card-content"><Notice tone="bad">Não foi possível consultar as massivas.</Notice></div>}
        {state==="ready"&&!available&&<div className="card-content"><Notice tone="bad">Registro de massivas indisponível.</Notice></div>}
        {state==="ready"&&available&&items.length===0&&<Empty icon="network" title="Nenhuma massiva registrada">Elas são cadastradas por uma pessoa, na aba Massivas.</Empty>}
        {items.slice(0,6).map(i=><IncidentRow incident={i} key={i.id}/>)}
      </Card>
      <Card title="Alertas de rede" badge={<Badge tone="info">Telegram</Badge>} flush>
        {alertState==="loading"&&<Loading rows={2} />}
        {alertState==="error"&&<div className="card-content"><Notice tone="bad">Não foi possível consultar os alertas.</Notice></div>}
        {alertState==="ready"&&!alerts?.available&&<Empty icon="alert" title="Alertas indisponíveis">{alerts?.detail}.</Empty>}
        {alertState==="ready"&&alerts?.available&&openAlerts.length===0&&<Empty icon="check" title="Nenhum alerta aberto agora" />}
        {openAlerts.map(a=><NetworkAlertRow alert={a} key={a.id}/>)}
      </Card>
    </div>
    <Limits title="De onde vêm estes números" items={[
      ["Massivas","Banco do LZR HUB, registradas manualmente. Não existe integração de monitoramento alimentando isso."],
      ["Alertas de rede","Grupo do Telegram onde o monitoramento posta queda e normalização. O código do equipamento (OLT-ZTE-CDB-SUP-02) não é decodificado em cidade/bairro: mostrar o código bruto é mais honesto que adivinhar."],
      ["Clientes impactados","Estimativa digitada por quem registra a massiva. Potência de ONU em massa e correlação geográfica automática não existem."],
    ]}/>
  </>;
}

function NetworkAlertRow({alert:a}:{alert:NetworkAlert}){
  return <div className="incident">
    <i className={`severity-dot ${a.kind==="unrecognized"?"medium":"high"}`}/>
    <div><strong>{a.equipment}</strong><span>{ALERT_KIND_LABELS[a.kind]??a.kind}{a.description?` · ${a.description}`:""}</span><small>desde {new Date(a.startedAt).toLocaleString("pt-BR")}</small></div>
    <div className="incident-side"><span className={`status ${a.status==="open"?"bad":"ok"}`}>{a.status==="open"?"Aberto":"Resolvido"}</span></div>
  </div>;
}

function IncidentRow({incident:i,children}:{incident:Incident;children?:React.ReactNode}){
  return <div className="incident">
    <i className={`severity-dot ${i.severity}`}/>
    <div><strong>{i.title}</strong><span>{i.city} · {i.neighborhood}{i.equipment?` · ${i.equipment}`:""}</span><small>{STATUS_LABELS[i.status]??i.status} · aberta em {dateOnly(i.startedAt)}{i.endedAt?` · encerrada em ${dateOnly(i.endedAt)}`:""}</small></div>
    <div className="incident-side"><b>{count(i.affectedCustomers)}</b><small>clientes</small><i className={`severity ${i.severity}`}>{SEVERITY_LABELS[i.severity]??i.severity}</i></div>
    {children&&<div className="incident-actions">{children}</div>}
  </div>;
}

function AlertMap(){
  const {items,available,state}=useIncidents();
  const {data:alerts,state:alertState}=useNetworkAlerts();
  const open=items.filter(i=>i.status!=="resolved");
  const openAlerts=alerts?.open??[];
  const byCity=Object.entries(open.reduce<Record<string,{count:number;affected:number}>>((acc,i)=>{const key=`${i.city} · ${i.neighborhood}`;acc[key]={count:(acc[key]?.count??0)+1,affected:(acc[key]?.affected??0)+i.affectedCustomers};return acc},{})).sort((a,b)=>b[1].affected-a[1].affected);
  if(state==="loading")return <Loading rows={3}/>;
  if(state==="error")return <Notice tone="bad">Não foi possível consultar as massivas.</Notice>;
  if(!available)return <Notice tone="bad">Registro de massivas indisponível.</Notice>;
  return <>
    {open.length===0
      ? <Card><Empty icon="network" title="Nenhuma região com massiva aberta">Esta visão agrupa as massivas que a operação registrar. Não há pino de exemplo.</Empty></Card>
      : <div className="grid-2 even">
          <Card title="Regiões afetadas" badge={<Badge tone="warn">{byCity.length}</Badge>} flush>
            {byCity.map(([region,{count:total,affected}])=><div className="incident" key={region}><i className="severity-dot high"/><div><strong>{region}</strong><span>{plural(total,"massiva em aberto","massivas em aberto")}</span></div><div className="incident-side"><b>{count(affected)}</b><small>clientes</small></div></div>)}
          </Card>
          <Card title="Massivas em aberto" flush>{open.map(i=><IncidentRow incident={i} key={i.id}/>)}</Card>
        </div>}
    {alertState==="ready"&&alerts?.available&&openAlerts.length>0&&<Card title="Alertas sem local decodificado" badge={<Badge tone="info">{openAlerts.length}</Badge>} flush>
      {openAlerts.map(a=><NetworkAlertRow alert={a} key={a.id}/>)}
    </Card>}
    <Limits items={[["Mapa automático","Dependeria de traduzir o código do equipamento em cidade/bairro, tabela que ainda não existe. Por isso os alertas do Telegram ficam fora do agrupamento por região."]]}/>
  </>;
}

const EMPTY_FORM={title:"",severity:"high",city:"",neighborhood:"",equipment:"",affectedCustomers:""};

function MassIncidents(){
  const {items,available,state,reload}=useIncidents();
  const [form,setForm]=useState(EMPTY_FORM);
  const [creating,setCreating]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [showClosed,setShowClosed]=useState(false);
  const toast=useToast();

  async function submit(){
    setBusy(true);setError("");
    const response=await fetch("/api/support/incidents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...form,affectedCustomers:Number(form.affectedCustomers||0)})});
    if(response.ok){setForm(EMPTY_FORM);setCreating(false);toast("Massiva registrada.");reload()}
    else{const payload=await response.json().catch(()=>({}));setError(payload.error??"Não foi possível registrar a massiva")}
    setBusy(false);
  }
  async function close(id:string){
    setBusy(true);
    const response=await fetch("/api/support/incidents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"close",id})});
    toast(response.ok?"Massiva encerrada.":"Não foi possível encerrar.",response.ok?"ok":"bad");
    reload();setBusy(false);
  }

  const set=(key:keyof typeof EMPTY_FORM)=>(event:{target:{value:string}})=>setForm(current=>({...current,[key]:event.target.value}));
  const shown=items.filter(i=>showClosed||i.status!=="resolved");
  const closed=items.length-items.filter(i=>i.status!=="resolved").length;
  return <>
    <Toolbar actions={<button className="button" onClick={()=>{setCreating(true);setError("")}}><Icon name="plus" size={16}/>Registrar massiva</button>}>
      {closed>0&&<label className="checks-inline"><input type="checkbox" checked={showClosed} onChange={e=>setShowClosed(e.target.checked)}/> Mostrar encerradas ({closed})</label>}
    </Toolbar>
    {state==="loading"&&<Loading rows={3}/>}
    {state==="error"&&<Notice tone="bad">Não foi possível consultar as massivas.</Notice>}
    {state==="ready"&&!available&&<Notice tone="bad">Registro de massivas indisponível.</Notice>}
    {state==="ready"&&available&&<Card flush>
      {shown.length===0
        ? <Empty icon="network" title={items.length?"Nenhuma massiva aberta":"Nenhuma massiva registrada ainda"} action={<button className="button secondary" onClick={()=>setCreating(true)}>Registrar massiva</button>}/>
        : shown.map(i=><IncidentRow incident={i} key={i.id}>
            <NotifyButton incidentId={i.id} kind="opened" label="Avisar clientes da área" busy={busy}/>
            {i.status==="resolved"&&<NotifyButton incidentId={i.id} kind="closed" label="Avisar normalização" busy={busy}/>}
            {i.status!=="resolved"&&<button className="button secondary small" disabled={busy} onClick={()=>void close(i.id)}>Encerrar</button>}
          </IncidentRow>)}
    </Card>}
    <Modal open={creating} title="Registrar massiva" onClose={()=>setCreating(false)}
      footer={<><button className="button secondary" onClick={()=>setCreating(false)}>Cancelar</button><button className="button" disabled={busy||!form.title.trim()} onClick={()=>void submit()}>{busy?"Registrando…":"Registrar"}</button></>}>
      <div className="form-grid">
        <label className="field span-2"><span>O que está acontecendo</span><input data-autofocus placeholder="ex.: rompimento de fibra no anel norte" value={form.title} onChange={set("title")}/></label>
        <label className="field"><span>Cidade</span><input placeholder="ex.: Itabaiana" value={form.city} onChange={set("city")}/></label>
        <label className="field"><span>Bairro ou região</span><input placeholder="ex.: Centro" value={form.neighborhood} onChange={set("neighborhood")}/></label>
        <label className="field"><span>Equipamento (opcional)</span><input placeholder="ex.: OLT-ITA-02 / PON 4" value={form.equipment} onChange={set("equipment")}/></label>
        <label className="field"><span>Clientes afetados (estimativa)</span><input placeholder="ex.: 340" inputMode="numeric" value={form.affectedCustomers} onChange={set("affectedCustomers")}/></label>
        <label className="field span-2"><span>Severidade</span><select value={form.severity} onChange={set("severity")}><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="critical">Crítica</option></select></label>
        {error&&<p className="form-error span-2">{error}</p>}
        <p className="field-hint span-2">A estimativa é sua: o sistema não calcula isso sozinho. “Avisar clientes da área” casa cidade e bairro com o cadastro real — não com esta estimativa.</p>
      </div>
    </Modal>
  </>;
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

  return <div>
    <button className="button secondary small" disabled={busy||running} onClick={()=>void run()}>{running?"Avisando…":label}</button>
    {error&&<small className="warn-text">{error}</small>}
    {result&&<small className="muted">
      {result.matched} na área, {result.recorded} novo(s){result.duplicates>0?`, ${result.duplicates} já avisado(s) antes`:""}.
      {result.queueEnabled?` ${result.enqueued} enfileirado(s).`:" Fila de envio desligada — só registrado."}
    </small>}
  </div>;
}

type OsCatalog={available:boolean;detail?:string;subjects:{id:string;name:string}[];sectors:{id:string;name:string}[];writeEnabled?:boolean};

/**
 * Abertura de OS no IXC (issue #20, segunda operação do catálogo de escrita).
 *
 * Assunto e setor vêm do próprio ERP — nada é digitado nem fixado no código.
 * São 159 assuntos e 12 setores com ids salteados na base da BBNET, e escolher
 * um deles é escolher qual fila recebe o chamado e qual técnico vai à casa do
 * cliente. Sem catálogo, o formulário não abre.
 */
function NewServiceOrder({open,onClose}:{open:boolean;onClose:()=>void}){
  const [catalog,setCatalog]=useState<OsCatalog|null>(null);
  const [form,setForm]=useState({customerId:"",subjectId:"",sectorId:"",message:""});
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<{status:string;detail:string}|null>(null);
  const [error,setError]=useState<string|null>(null);

  useEffect(()=>{if(!open||catalog)return;let active=true;
    fetch("/api/support/service-orders").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:OsCatalog)=>{if(active)setCatalog(payload)})
      .catch(()=>{if(active)setCatalog({available:false,detail:"Não foi possível ler o catálogo do IXC",subjects:[],sectors:[]})});
    return()=>{active=false}},[open,catalog]);

  async function submit(){
    setBusy(true);setError(null);setResult(null);
    try{
      const response=await fetch("/api/support/service-orders",{method:"POST",headers:{"content-type":"application/json"},
        // Chave por tentativa: se a rede oscilar e o clique repetir, o ledger
        // reconhece a repetição e não manda um segundo técnico ao mesmo cliente.
        body:JSON.stringify({...form,idempotencyKey:`os-${form.customerId}-${form.subjectId}-${Date.now()}`})});
      const payload=await response.json() as {status?:string;detail?:string;error?:string};
      if(!response.ok&&payload.error){setError(payload.error);return}
      setResult({status:payload.status??"?",detail:payload.detail??""});
    }catch{setError("O IXC não respondeu.")}
    finally{setBusy(false)}
  }

  function close(){setResult(null);setError(null);onClose()}
  const ready=form.customerId.trim()&&form.subjectId&&form.sectorId&&form.message.trim().length>=10;
  return <Modal open={open} title="Abrir ordem de serviço no IXC" onClose={close} wide
    footer={catalog?.available&&<><button className="button secondary" disabled={busy} onClick={close}>{result?.status==="success"?"Fechar":"Cancelar"}</button>{result?.status!=="success"&&<button className="button" disabled={busy||!ready} onClick={()=>void submit()}>{busy?"Enviando…":"Abrir OS"}</button>}</>}>
    {!catalog&&<Loading rows={2}/>}
    {catalog&&!catalog.available&&<Notice tone="bad" more="Nenhuma lista de exemplo é mostrada: escolher um assunto inventado abriria chamado na fila errada.">Abrir OS pela tela está indisponível: {catalog.detail}.</Notice>}
    {catalog?.available&&<div className="form-grid">
      {!catalog.writeEnabled&&<div className="span-2"><Notice tone="warn">A escrita no IXC está desligada neste ambiente (FEATURE_IXC_WRITE): o pedido será recusado.</Notice></div>}
      <label className="field"><span>Código do cliente no IXC</span><input data-autofocus value={form.customerId} placeholder="ex.: 21857" onChange={e=>setForm(f=>({...f,customerId:e.target.value}))}/></label>
      <label className="field"><span>Setor que vai atender</span>
        <select value={form.sectorId} onChange={e=>setForm(f=>({...f,sectorId:e.target.value}))}><option value="">Escolha o setor…</option>{catalog.sectors.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="field span-2"><span>Assunto ({catalog.subjects.length} do IXC)</span>
        <select value={form.subjectId} onChange={e=>setForm(f=>({...f,subjectId:e.target.value}))}><option value="">Escolha o assunto…</option>{catalog.subjects.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="field span-2"><span>O que o cliente relatou</span><textarea rows={4} value={form.message} placeholder="O técnico chega sabendo só o que estiver escrito aqui." onChange={e=>setForm(f=>({...f,message:e.target.value}))}/></label>
      <p className="field-hint span-2">A filial vem do cadastro do cliente no IXC, não daqui — o grupo tem 21 e o chamado precisa nascer na certa.</p>
      {error&&<p className="form-error span-2">{error}</p>}
      {result&&<div className={`result-box span-2 ${result.status==="success"?"ok":"bad"}`}><strong>{result.status==="success"?"OS aberta no IXC.":result.status==="blocked"?"Bloqueado.":"Falhou."}</strong><p>{result.detail}</p></div>}
    </div>}
  </Modal>;
}

function Tickets(){
  const [page,setPage]=useState(1);
  const {data,state}=useTickets(page);
  const [onlyOpen,setOnlyOpen]=useState(true);
  const [creating,setCreating]=useState(false);
  const fullBase=data?.scope==="full-base";
  // Na base inteira o próprio IXC já devolve só as não fechadas; filtrar de novo
  // aqui esconderia parte da página sem reduzir o total, o que confunde.
  const items=fullBase?(data?.items??[]):(data?.items??[]).filter(t=>!onlyOpen||isOpenTicket(t.status));
  const pageSize=data?.pageSize??25;
  const first=((data?.page??1)-1)*pageSize;
  return <>
    <Toolbar actions={<button className="button" onClick={()=>setCreating(true)}><Icon name="plus" size={16}/>Abrir OS</button>}>
      {state==="ready"&&data?.available&&(fullBase
        ? <span className="muted"><strong className="text-ink">{count(data.total??0)}</strong> OS ainda não fechadas no IXC <InfoTip label="Por que não aparece o nome do cliente">O IXC não devolve o nome do cliente na OS — buscar linha a linha seria uma consulta por item. Por isso a fila mostra o código do cadastro e o endereço do atendimento.</InfoTip></span>
        : <select className="select" value={onlyOpen?"open":"all"} onChange={e=>setOnlyOpen(e.target.value==="open")}><option value="open">Só em aberto</option><option value="all">Todas as OS</option></select>)}
    </Toolbar>
    <NewServiceOrder open={creating} onClose={()=>setCreating(false)}/>
    {state==="loading"&&<Loading rows={6}/>}
    {state==="error"&&<Notice tone="bad">Não foi possível consultar os chamados.</Notice>}
    {state==="ready"&&!data?.available&&<Notice tone="bad">{data?.detail??"Fonte de chamados indisponível"}.</Notice>}
    {state==="ready"&&data?.available&&<>
      {!fullBase&&<Notice tone="warn" more="É trava nossa, de homologação: liberar a base inteira depende de FEATURE_IXC_FULL_BASE.">Mostrando só as OS dos {data.allowlistSize} cadastro(s) liberados na allowlist.{data.unavailableCustomers?` ${data.unavailableCustomers} não responderam.`:""}</Notice>}
      <Card flush>
        {items.length===0
          ? <Empty icon="ticket" title={`Nenhuma OS ${onlyOpen&&!fullBase?"em aberto":"encontrada"}`}/>
          : <div className="table" style={{["--cols" as string]:"minmax(150px,1fr) minmax(0,2.4fr) 110px 100px"}}>
              <div className="tr head hide-sm"><span>OS / {fullBase?"local":"cliente"}</span><span>Assunto</span><span>Situação</span><span>Aberta em</span></div>
              {items.map(t=><div className="tr stack-sm" key={t.id}>
                <span className="cell"><strong>OS {t.id}</strong><small className="clip" title={fullBase?t.address??"":undefined}>{fullBase?`Cadastro ${t.customerId}${t.address?` · ${t.address}`:""}`:`${t.customerName} · ${t.city}`}</small></span>
                {/* O assunto do IXC vem com o processo inteiro descrito e quebrava a linha em
                    seis; truncar na exibição mantém a fila legível e o texto completo no title. */}
                <span className="clip" title={t.subject}>{t.subject}</span>
                <span className={`status ${isOpenTicket(t.status)?"warn":"ok"}`}>{isOpenTicket(t.status)?"Em aberto":"Encerrada"}</span>
                <span className="muted">{dateOnly(t.openedAt)}</span>
              </div>)}
            </div>}
        {fullBase&&items.length>0&&<div className="pagination"><span>{count(first+1)}–{count(first+items.length)} de {count(data.total??0)}</span>
          <button className="icon-button" aria-label="Página anterior" disabled={page<=1} onClick={()=>setPage(page-1)}><Icon name="chevron-left" size={16}/></button>
          <button className="icon-button" aria-label="Próxima página" disabled={first+items.length>=(data.total??0)} onClick={()=>setPage(page+1)}><Icon name="chevron-right" size={16}/></button></div>}
      </Card>
    </>}
  </>;
}

