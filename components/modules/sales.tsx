"use client";
import { useEffect, useState } from "react";
import { BarChart } from "./bar-chart";
import { LEAD_SOURCES, LEAD_STAGES, type FunnelMetrics, type Lead, type LeadActivity } from "@/lib/platform/crm-shared";
import { Icon } from "@/components/ui/icons";
import { Badge, Bar, Card, Empty, Limits, Loading, Modal, Notice, Row, Segmented, Stat, Stats, Toolbar, count, money, useToast } from "@/components/ui/kit";

/**
 * Comercial. "Dashboard" e "Relatórios" liam o mesmo `/api/sales/overview` —
 * viraram uma visão geral só, com o gráfico por dia que só existia no
 * relatório. O cartão "O que não temos como responder" saiu: ele dizia que
 * não existia CRM, e o funil existe desde a issue #17.
 */
export function SalesModule({view}:{view:"comercial"|"funil"|"metas"}){
  if(view==="funil")return <Funnel/>;
  if(view==="metas")return <Goals/>;
  return <SalesOverview/>;
}

type PlanMix={plan:string;contracts:number;value:number};
type SalesSummary={activations:number;scanned:number;truncated:boolean;activeContracts:number;monthlyRecurringAdded:number;averageTicket:number|null;planMix:PlanMix[];withoutValue:number;byDay:Array<{day:string;contracts:number}>;alreadyCancelled:number};
type SalesPayload={available:boolean;detail?:string;period:string;summary:SalesSummary|null};
const PERIODS=[["7d","7 dias"],["30d","30 dias"],["90d","90 dias"]] as const;
type Period=typeof PERIODS[number][0];
const periodName=(period:string)=>PERIODS.find(([v])=>v===period)?.[1]??period;

function SalesOverview(){
  const [period,setPeriod]=useState<Period>("30d");
  const [data,setData]=useState<SalesPayload|null>(null);
  const [loadedFor,setLoadedFor]=useState<string|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{let active=true;
    fetch(`/api/sales/overview?period=${period}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:SalesPayload)=>{if(active){setData(payload);setFailed(false);setLoadedFor(period)}})
      .catch(()=>{if(active){setFailed(true);setLoadedFor(period)}});
    return()=>{active=false}},[period]);
  const summary=data?.summary;
  const loading=loadedFor!==period;
  return <>
    <Toolbar><Segmented label="Período" value={period} options={PERIODS} onChange={setPeriod}/></Toolbar>
    {loading&&<Loading stats={4} rows={4}/>}
    {!loading&&failed&&<Notice tone="bad">Não foi possível consultar as vendas.</Notice>}
    {!loading&&!failed&&data&&!data.available&&<Notice tone="bad">{data.detail}.</Notice>}
    {!loading&&!failed&&summary&&<>
      {summary.truncated&&<Notice tone="warn">A leitura do IXC parou antes do fim: ticket médio e mix cobrem {count(summary.scanned)} das vendas.</Notice>}
      <Stats>
        <Stat label={`Vendas em ${periodName(period)}`} icon="trending" tone="ok" value={count(summary.activations)} hint={summary.alreadyCancelled?`${summary.alreadyCancelled} já cancelaram (medido em Churn)`:"Contratos ativados"}/>
        <Stat label="Ticket médio" icon="wallet" value={summary.averageTicket===null?"—":money(summary.averageTicket)} hint={summary.averageTicket===null?"Nenhum contrato com valor legível":`Sobre ${summary.scanned-summary.withoutValue} contrato(s)`}
          info={summary.withoutValue?`${summary.withoutValue} contrato(s) sem valor de plano legível ficaram de fora, em vez de entrarem como zero.`:undefined}/>
        <Stat label="Receita recorrente somada" icon="sparkles" value={money(summary.monthlyRecurringAdded)} hint="Mensalidade das novas vendas"/>
        <Stat label="Base ativa" icon="users" value={count(summary.activeContracts)} hint="Contratos ativos hoje"/>
      </Stats>
      <div className="grid-2">
        <Card title="Vendas por dia" badge={<Badge>{summary.byDay.length} dia(s) com venda</Badge>} flush>
          <BarChart data={summary.byDay} noun="venda(s)"/>
        </Card>
        <Card title="Planos mais vendidos">
          {summary.planMix.length===0
            ? <Empty icon="trending" title="Nenhuma ativação no período"/>
            : <div className="bars">{summary.planMix.slice(0,8).map(item=><Bar key={item.plan} label={item.plan} detail={`${item.contracts} venda(s) · ${money(item.value)}`} value={item.contracts} max={summary.planMix[0].contracts} display={`${Math.round(item.contracts/Math.max(summary.scanned,1)*100)}%`}/>)}</div>}
        </Card>
      </div>
      <Limits items={[
        ["Conversão e ciclo de venda","Estão no Funil, calculados dos leads registrados — não dos contratos do IXC, que não sabem quando a conversa começou."],
        ["Previsão de churn","Quem já saiu está em Churn. Prever quem vai sair exige sinais que ninguém coleta."],
      ]}/>
    </>}
  </>;
}

/* ------------------------------------------------------------------ funil --- */

type FunnelPayload={available:boolean;detail?:string;period:string;leads:Lead[];activities:LeadActivity[];metrics:FunnelMetrics|null};

const SOURCE_LABELS:Record<string,string>={whatsapp:"WhatsApp",indicacao:"Indicação","porta-a-porta":"Porta a porta"};
const sourceLabel=(value:string)=>SOURCE_LABELS[value]??value.charAt(0).toUpperCase()+value.slice(1);
const dayLabel=(iso:string)=>{const d=new Date(iso);return Number.isNaN(d.getTime())?"—":d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})};
const EMPTY_LEAD={name:"",phone:"",city:"",neighborhood:"",source:"whatsapp",note:""};

/**
 * Funil comercial real (issue #17).
 *
 * O arrastar-e-soltar usa a API nativa do navegador — sem biblioteca. Quem não
 * consegue arrastar (teclado, toque) tem o mesmo caminho pelo seletor dentro do
 * cartão: arrastar é atalho, não a única porta.
 */
function Funnel(){
  const [period,setPeriod]=useState<Period>("30d");
  const [data,setData]=useState<FunnelPayload|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  const [nonce,setNonce]=useState(0);
  const [creating,setCreating]=useState(false);
  const [form,setForm]=useState(EMPTY_LEAD);
  const [openId,setOpenId]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [dragging,setDragging]=useState<string|null>(null);
  const [over,setOver]=useState<string|null>(null);
  const [losing,setLosing]=useState<{leadId:string;reason:string}|null>(null);
  const toast=useToast();

  useEffect(()=>{let active=true;
    fetch(`/api/sales/leads?period=${period}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:FunnelPayload)=>{if(active){setData(payload);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[period,nonce]);

  async function post(body:Record<string,unknown>){
    setBusy(true);setError("");
    try{
      const response=await fetch("/api/sales/leads",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      if(response.ok){setNonce(n=>n+1);return true}
      const payload=await response.json().catch(()=>({}));
      setError(payload.error??"Não foi possível salvar.");
      toast(payload.error??"Não foi possível salvar.","bad");
      return false;
    }catch{setError("Não foi possível salvar.");return false}
    finally{setBusy(false)}
  }

  async function move(leadId:string,toStage:string){
    // Perder sem motivo deixa um número que ninguém sabe explicar depois.
    if(toStage==="perdido"){setLosing({leadId,reason:""});return}
    await post({action:"move",leadId,toStage,detail:`Movido para ${toStage}`});
  }

  const leads=data?.leads??[];
  const metrics=data?.metrics??null;
  const open=leads.find(lead=>lead.id===openId)??null;
  const history=(data?.activities??[]).filter(item=>item.leadId===openId);
  const percent=(value:number|null)=>value===null?"—":`${Math.round(value*100)}%`;

  return <>
    <Toolbar actions={state==="ready"&&data?.available&&<button className="button" onClick={()=>{setCreating(true);setError("")}}><Icon name="plus" size={16}/>Novo lead</button>}>
      <Segmented label="Período" value={period} options={PERIODS} onChange={(value)=>{setState("loading");setPeriod(value)}}/>
    </Toolbar>

    {state==="loading"&&<Loading stats={4} rows={3}/>}
    {state==="error"&&<Notice tone="bad">Não foi possível carregar o funil.</Notice>}
    {state==="ready"&&data&&!data.available&&<Notice tone="bad">{data.detail}.</Notice>}

    {state==="ready"&&data?.available&&<>
      {metrics&&<Stats>
        <Stat label={`Leads em ${periodName(period)}`} icon="users" value={count(metrics.created)} hint={`${metrics.open} em andamento agora`}/>
        <Stat label="Conversão" icon="trending" value={percent(metrics.conversionRate)} hint={metrics.conversionRate===null?"Nenhum lead encerrado ainda":`${metrics.won} ganho(s) de ${metrics.won+metrics.lost} encerrado(s)`}
          info="Ganhos ÷ encerrados. Leads em andamento ficam de fora, senão a taxa cairia toda vez que a operação captasse contato novo."/>
        {/* "0,0 dias" se lê como defeito; venda fechada no mesmo dia é venda rápida. */}
        <Stat label="Ciclo médio" icon="clock" value={metrics.averageCycleDays===null?"—":metrics.averageCycleDays<0.5?"< 1 dia":`${metrics.averageCycleDays.toFixed(1).replace(".",",")} dias`} hint={metrics.averageCycleDays===null?"Nenhum lead ganho no período":"Do primeiro contato ao ganho"}/>
        <Stat label="Origem principal" icon="chat" value={metrics.bySource[0]?sourceLabel(metrics.bySource[0].source):"—"} hint={metrics.bySource[0]?`${metrics.bySource[0].leads} lead(s)`:"Nenhum lead no período"}/>
      </Stats>}

      {error&&!creating&&!losing&&<Notice tone="bad">{error}</Notice>}

      {leads.length===0
        ? <Card><Empty icon="users" title="Nenhum lead ainda" action={<button className="button" onClick={()=>setCreating(true)}>Registrar o primeiro</button>}>Ou espere alguém sem cadastro escrever no WhatsApp — esse contato entra aqui sozinho.</Empty></Card>
        : <section className="kanban" style={{["--stages" as string]:LEAD_STAGES.length}}>
            {LEAD_STAGES.map(stage=>{
              const cards=leads.filter(lead=>lead.stage===stage.id);
              return <div className={`kanban-column ${over===stage.id?"drop":""}`} key={stage.id}
                onDragOver={e=>{e.preventDefault();if(over!==stage.id)setOver(stage.id)}}
                onDragLeave={()=>setOver(null)}
                onDrop={e=>{e.preventDefault();setOver(null);const id=e.dataTransfer.getData("text/plain")||dragging;setDragging(null);if(id&&leads.find(l=>l.id===id)?.stage!==stage.id)void move(id,stage.id)}}>
                <header><strong>{stage.label}</strong><span>{cards.length}</span></header>
                <p className="kanban-hint">{stage.hint}</p>
                {cards.map(lead=><article className="kanban-card" key={lead.id} draggable
                  onDragStart={e=>{e.dataTransfer.setData("text/plain",lead.id);setDragging(lead.id)}}
                  onDragEnd={()=>{setDragging(null);setOver(null)}}>
                  <button className="kanban-card-open" onClick={()=>setOpenId(lead.id)}>
                    <strong>{lead.name}</strong>
                    <span>{lead.maskedPhone} · {sourceLabel(lead.source)}</span>
                    <small>{lead.city}{lead.neighborhood!=="não informado"?` · ${lead.neighborhood}`:""} · desde {dayLabel(lead.createdAt)}</small>
                  </button>
                  <select value={lead.stage} disabled={busy} onChange={e=>void move(lead.id,e.target.value)} aria-label={`Mover ${lead.name} de etapa`}>
                    {LEAD_STAGES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </article>)}
              </div>;
            })}
          </section>}

      <Limits items={[["Valor de pipeline","Exigiria um valor estimado por lead, que ninguém preenche hoje — e somar plano suposto daria um número bonito e falso."]]}/>
    </>}

    <Modal open={creating} title="Novo lead" onClose={()=>{setCreating(false);setError("")}}
      footer={<><button className="button secondary" disabled={busy} onClick={()=>{setCreating(false);setError("")}}>Cancelar</button>
        <button className="button" disabled={busy||form.name.trim().length<2} onClick={()=>{void post({action:"create",...form}).then(ok=>{if(ok){setCreating(false);setForm(EMPTY_LEAD);toast("Lead registrado em “Novo contato”.")}})}}>{busy?"Salvando…":"Registrar lead"}</button></>}>
      <div className="form-grid">
        <label className="field span-2"><span>Nome</span><input data-autofocus value={form.name} placeholder="quem entrou em contato" onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></label>
        <label className="field"><span>Telefone</span><input value={form.phone} placeholder="(79) 99999-9999" onChange={e=>setForm(f=>({...f,phone:e.target.value}))}/></label>
        <label className="field"><span>Origem</span><select value={form.source} onChange={e=>setForm(f=>({...f,source:e.target.value}))}>{LEAD_SOURCES.map(s=><option key={s} value={s}>{sourceLabel(s)}</option>)}</select></label>
        <label className="field"><span>Cidade</span><input value={form.city} onChange={e=>setForm(f=>({...f,city:e.target.value}))}/></label>
        <label className="field"><span>Bairro</span><input value={form.neighborhood} onChange={e=>setForm(f=>({...f,neighborhood:e.target.value}))}/></label>
        <label className="field span-2"><span>Observação (opcional)</span><input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))}/></label>
        {error&&<p className="form-error span-2">{error}</p>}
      </div>
    </Modal>

    <Modal open={!!losing} title="Por que o lead foi perdido?" onClose={()=>setLosing(null)}
      footer={<><button className="button secondary" onClick={()=>setLosing(null)}>Cancelar</button>
        <button className="button danger" disabled={busy||(losing?.reason.trim().length??0)<3} onClick={()=>{if(!losing)return;void post({action:"move",leadId:losing.leadId,toStage:"perdido",detail:losing.reason.trim()}).then(ok=>{if(ok)setLosing(null)})}}>Marcar como perdido</button></>}>
      <label className="field"><span>Motivo</span><input data-autofocus value={losing?.reason??""} placeholder="ex.: achou mais barato no concorrente" onChange={e=>setLosing(current=>current&&{...current,reason:e.target.value})}/></label>
      <p className="field-hint" style={{marginTop:8}}>Perder sem motivo deixa um número que ninguém sabe explicar depois.</p>
    </Modal>

    <Modal side open={!!open} title={open?.name??""} onClose={()=>setOpenId(null)}>
      {open&&<div className="stack">
        <div className="chips"><Badge tone="info">{LEAD_STAGES.find(s=>s.id===open.stage)?.label??open.stage}</Badge><Badge>{sourceLabel(open.source)}</Badge></div>
        <dl className="facts">
          <div><dt>Telefone</dt><dd>{open.maskedPhone}</dd></div>
          <div><dt>Local</dt><dd>{open.city} · {open.neighborhood}</dd></div>
          <div><dt>Desde</dt><dd>{dayLabel(open.createdAt)}</dd></div>
          {open.note&&<div className="stacked"><dt>Observação</dt><dd>{open.note}</dd></div>}
          {open.lostReason&&<div className="stacked"><dt>Motivo da perda</dt><dd>{open.lostReason}</dd></div>}
        </dl>
        <LeadActivityForm leadId={open.id} busy={busy} onSubmit={(kind,detail)=>void post({action:"activity",leadId:open.id,kind,detail})}/>
        <div>
          <h4 className="section-title" style={{marginTop:4}}>Histórico</h4>
          {history.length===0
            ? <p className="muted small">Sem registro ainda.</p>
            : <ol className="timeline" style={{padding:0}}>{history.map(item=><li key={item.id}>
                <i className={item.kind==="stage_change"?"ok":""}/>
                <div><strong>{item.kind==="stage_change"?`${item.fromStage??"criado"} → ${item.toStage}`:item.kind==="contact"?"Contato":"Nota"}</strong><span>{item.detail} · {item.actorId}</span></div>
                <time>{dayLabel(item.createdAt)}</time>
              </li>)}</ol>}
        </div>
        {open.stage==="ganho"&&<CreateCustomerForm key={open.id} lead={open} onDone={()=>setNonce(n=>n+1)}/>}
      </div>}
    </Modal>
  </>;
}

/**
 * Cadastra no IXC o cliente que o lead ganho virou (issue #20, `customer.create`).
 *
 * Só aparece em lead **ganho** e some depois que o cadastro existe: o botão de
 * cadastrar num lead que já virou cliente é o caminho mais curto para duplicata.
 *
 * ⚠️ Cidade é o **código interno do IXC**, por isso vem de lista, nunca digitada.
 */
function CreateCustomerForm({lead,onDone}:{lead:Lead;onDone:()=>void}){
  const [catalog,setCatalog]=useState<{available:boolean;detail?:string;ufs:{id:string;name:string;initials:string}[];cities:{id:string;name:string}[];writeEnabled?:boolean}|null>(null);
  const [ufId,setUfId]=useState("");
  const [form,setForm]=useState({document:"",cep:"",street:"",number:"",neighborhood:lead.neighborhood==="não informado"?"":lead.neighborhood,cityId:"",phone:"",email:""});
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<{status:string;detail:string}|null>(null);
  const [error,setError]=useState("");

  useEffect(()=>{let active=true;
    fetch(`/api/sales/leads/customer${ufId?`?uf=${encodeURIComponent(ufId)}`:""}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then(payload=>{if(active)setCatalog(payload)})
      .catch(()=>{if(active)setCatalog({available:false,detail:"Não foi possível ler o catálogo de cidades",ufs:[],cities:[]})});
    return()=>{active=false}},[ufId]);

  if(lead.ixcCustomerId)return <Notice tone="ok" title="Já é cliente no IXC.">Cadastro <strong>{lead.ixcCustomerId}</strong>, criado a partir deste lead.</Notice>;
  if(!catalog)return null;
  if(!catalog.available)return <Notice tone="bad">Cadastrar no IXC está indisponível: {catalog.detail}.</Notice>;

  const ready=form.document.trim()&&ufId&&form.cityId&&form.street.trim().length>2&&form.number.trim()&&form.cep.replace(/\D/g,"").length===8;

  async function submit(){
    setBusy(true);setError("");setResult(null);
    try{
      const response=await fetch("/api/sales/leads/customer",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({...form,leadId:lead.id,ufId,name:lead.name,idempotencyKey:customerKey(lead.id)})});
      const payload=await response.json();
      if(!response.ok&&payload.error){setError(payload.error);return}
      setResult({status:payload.status,detail:payload.detail});
      if(payload.status==="success")onDone();
    }catch{setError("O IXC não respondeu.")}
    finally{setBusy(false)}
  }

  return <section className="stack" style={{borderTop:"1px solid var(--line)",paddingTop:16}}>
    <div className="template-head"><strong>Cadastrar no IXC</strong>{catalog.writeEnabled?<Badge tone="ok" dot>escrita ligada</Badge>:<Badge tone="warn">escrita desligada</Badge>}</div>
    <p className="hint">Cria o cadastro real no ERP. O documento é conferido pelos dígitos e o IXC é consultado antes, para não duplicar cliente que já existe.</p>
    <div className="form-grid">
      <label className="field span-2"><span>CPF ou CNPJ</span><input value={form.document} placeholder="000.000.000-00" onChange={e=>setForm(f=>({...f,document:e.target.value}))}/></label>
      <label className="field"><span>Estado</span>
        <select value={ufId} onChange={e=>{setUfId(e.target.value);setForm(f=>({...f,cityId:""}))}}><option value="">Escolha…</option>{catalog.ufs.map(u=><option key={u.id} value={u.id}>{u.initials} — {u.name}</option>)}</select></label>
      <label className="field"><span>Cidade{catalog.cities.length?` (${catalog.cities.length})`:""}</span>
        <select value={form.cityId} disabled={!ufId} onChange={e=>setForm(f=>({...f,cityId:e.target.value}))}><option value="">{ufId?"Escolha…":"Escolha o estado antes"}</option>{catalog.cities.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="field"><span>Rua</span><input value={form.street} onChange={e=>setForm(f=>({...f,street:e.target.value}))}/></label>
      <label className="field"><span>Número</span><input value={form.number} placeholder="ou SN" onChange={e=>setForm(f=>({...f,number:e.target.value}))}/></label>
      <label className="field"><span>Bairro</span><input value={form.neighborhood} onChange={e=>setForm(f=>({...f,neighborhood:e.target.value}))}/></label>
      <label className="field"><span>CEP</span><input value={form.cep} placeholder="49000-000" onChange={e=>setForm(f=>({...f,cep:e.target.value}))}/></label>
      <label className="field"><span>Telefone</span><input value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))}/></label>
      <label className="field"><span>E-mail</span><input value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))}/></label>
    </div>
    {error&&<p className="form-error">{error}</p>}
    {result&&<div className={`result-box ${result.status==="success"?"ok":"bad"}`}><strong>{result.status==="success"?"Cadastro criado no IXC":result.status==="blocked"?"Bloqueado":"Falhou"}</strong><p>{result.detail}</p></div>}
    <button className="button" disabled={busy||!ready} onClick={()=>void submit()}>{busy?"Cadastrando…":"Cadastrar cliente no IXC"}</button>
  </section>;
}

/** Fora do componente: `Date.now()` no corpo é tratado como impureza em render. */
const customerKey=(leadId:string)=>`cadastro-${leadId}-${Date.now()}`;

function LeadActivityForm({leadId,busy,onSubmit}:{leadId:string;busy:boolean;onSubmit:(kind:string,detail:string)=>void}){
  const [detail,setDetail]=useState("");
  const [kind,setKind]=useState("contact");
  return <form className="stack" key={leadId} onSubmit={e=>{e.preventDefault();if(detail.trim().length>=3){onSubmit(kind,detail.trim());setDetail("")}}}>
    <label className="field"><span>Registrar no cartão</span>
      <input value={detail} placeholder="ex.: liguei, pediu para retornar quinta" onChange={e=>setDetail(e.target.value)}/></label>
    <div className="form-actions">
      <Segmented label="Tipo de registro" value={kind} options={[["contact","Contato feito"],["note","Nota"]]} onChange={setKind}/>
      <button type="submit" className="button secondary small" disabled={busy||detail.trim().length<3}>Registrar</button>
    </div>
  </form>;
}

/* ------------------------------------------------------------------ metas --- */

type Goal={id:string;period:string;targetContracts:number;targetRevenue:number|null;note:string|null;createdBy:string;updatedAt:string};
type Realized={contracts:number;revenue:number;alreadyCancelled:number;truncated:boolean;withoutValue:number};
type Progress={contractsPercent:number;revenuePercent:number|null;elapsed:number;projectedContracts:number|null;behind:boolean};
type GoalsPayload={available:boolean;detail?:string;period:string;currentPeriod:string;goals:Goal[];realized:Realized|null;progress:Progress|null};

const monthLabel=(period:string)=>{const [y,m]=period.split("-");return `${["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"][Number(m)-1]} de ${y}`};
const percent=(value:number)=>`${Math.round(value*100)}%`;
/** Últimas 6 competências mais as 2 seguintes: meta se define antes do mês começar. */
function periodOptions(current:string){
  const [y,m]=current.split("-").map(Number);
  return Array.from({length:9},(_,i)=>{const date=new Date(Date.UTC(y,m-1-6+i,1));return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}`});
}

/**
 * Meta contra realizado. A meta é registrada aqui e fica auditada; o realizado
 * vem do IXC na hora.
 */
function Goals(){
  const [period,setPeriod]=useState("");
  const [data,setData]=useState<GoalsPayload|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  const [nonce,setNonce]=useState(0);
  const [form,setForm]=useState({targetContracts:"",targetRevenue:"",note:""});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [editing,setEditing]=useState(false);
  const toast=useToast();

  useEffect(()=>{let active=true;
    fetch(`/api/sales/goals${period?`?period=${period}`:""}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:GoalsPayload)=>{if(active){setData(payload);setState("ready");if(!period)setPeriod(payload.period);setEditing(false)}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[period,nonce]);

  const goal=data?.goals.find(item=>item.period===data.period)??null;
  const realized=data?.realized??null;
  const progress=data?.progress??null;

  async function save(){
    setBusy(true);setError("");
    const response=await fetch("/api/sales/goals",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({period:data?.period,targetContracts:Number(form.targetContracts),targetRevenue:form.targetRevenue,note:form.note})});
    if(response.ok){setForm({targetContracts:"",targetRevenue:"",note:""});setNonce(n=>n+1);toast("Meta salva.")}
    else{const payload=await response.json().catch(()=>({}));setError(payload.error??"Não foi possível salvar a meta")}
    setBusy(false);
  }
  async function remove(){
    setBusy(true);setError("");
    const response=await fetch(`/api/sales/goals?period=${data?.period}`,{method:"DELETE"});
    if(response.ok){setNonce(n=>n+1);toast("Meta removida.")}
    else setError("Não foi possível remover a meta");
    setBusy(false);
  }

  if(state==="loading")return <Loading stats={4} rows={3}/>;
  if(state==="error")return <Notice tone="bad">Não foi possível consultar as metas.</Notice>;
  if(!data?.available)return <Notice tone="bad">{data?.detail}.</Notice>;
  const showForm=editing||!goal;
  const progressValue=Math.min(100,Math.round((progress?.contractsPercent??0)*100));
  return <>
    <Toolbar>
      <select className="select" value={data.period} aria-label="Competência" onChange={e=>{setState("loading");setPeriod(e.target.value)}}>
        {periodOptions(data.currentPeriod).map(value=><option key={value} value={value}>{monthLabel(value)}{value===data.currentPeriod?" (mês corrente)":""}</option>)}
      </select>
    </Toolbar>

    {goal&&<Stats>
      <Stat label="Meta do mês" icon="trending" value={count(goal.targetContracts)} hint={goal.targetRevenue===null?"Sem meta de receita":`e ${money(goal.targetRevenue)} de receita`}/>
      <Stat label="Realizado" icon="check" tone={progress&&!progress.behind?"ok":"neutral"} value={realized?count(realized.contracts):"—"} hint={realized?`${percent(progress?.contractsPercent??0)} da meta`:"IXC indisponível"}/>
      <Stat label="Receita somada" icon="wallet" value={realized?money(realized.revenue):"—"} hint={realized&&progress?.revenuePercent!=null?`${percent(progress.revenuePercent)} da meta de receita`:realized?"Sem meta de receita":"IXC indisponível"}/>
      {/* Sem realizado a projeção não existe por falta de dado, não por ser mês fechado. */}
      <Stat label="Projeção pelo ritmo" icon="sparkles" tone={progress?.behind?"warn":"neutral"} value={progress?.projectedContracts==null?"—":count(progress.projectedContracts)} hint={!realized?"Depende do realizado":progress?.projectedContracts==null?"Mês fechado não é projetado":`${percent(progress.elapsed)} do mês decorrido`}
        info="Regra de três sobre dias corridos — não pondera dia útil nem sazonalidade."/>
    </Stats>}

    {goal&&realized&&progress&&<Card>
      <div className="stack">
        <div className="template-head"><strong>{progress.behind?"Abaixo do ritmo necessário":"No ritmo ou acima da meta"}</strong><span className="muted small">{count(realized.contracts)} de {count(goal.targetContracts)}</span></div>
        <div className="bar-track" style={{height:10}}><span style={{width:`${progressValue}%`}}/></div>
        <p className="hint">
          {progress.projectedContracts!=null&&<>Mantido o ritmo, o mês fecha em <strong>{count(progress.projectedContracts)}</strong>. </>}
          {realized.alreadyCancelled>0&&<>{realized.alreadyCancelled} venda(s) já cancelaram; continuam contando como venda do mês, e a perda aparece em Churn. </>}
          {realized.truncated&&<strong>A leitura do IXC parou antes do fim — a receita cobre parte das vendas.</strong>}
        </p>
      </div>
    </Card>}

    {!goal&&<Notice tone="neutral">Nenhuma meta para {monthLabel(data.period)}.{realized&&<> O realizado já é <strong>{count(realized.contracts)}</strong> contrato(s).</>}</Notice>}

    <div className="grid-2 even">
      <Card title={showForm?(goal?"Alterar meta":"Registrar meta"):"Meta registrada"} badge={<Badge>fica na auditoria</Badge>}>
        {showForm
          ? <div className="form-grid">
              <label className="field"><span>Contratos a vender</span><input inputMode="numeric" placeholder="ex.: 260" value={form.targetContracts} onChange={e=>setForm(f=>({...f,targetContracts:e.target.value}))}/></label>
              <label className="field"><span>Receita recorrente (opcional)</span><input inputMode="decimal" placeholder="ex.: 32000,00" value={form.targetRevenue} onChange={e=>setForm(f=>({...f,targetRevenue:e.target.value}))}/></label>
              <label className="field span-2"><span>Observação (opcional)</span><input placeholder="ex.: inclui a campanha de fibra no anel norte" value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))}/></label>
              {error&&<p className="form-error span-2">{error}</p>}
              <div className="form-actions span-2">
                <button className="button" disabled={busy} onClick={()=>void save()}>{busy?"Salvando…":goal?"Salvar alteração":"Registrar meta"}</button>
                {goal&&<button className="button secondary" disabled={busy} onClick={()=>{setEditing(false);setError("")}}>Cancelar</button>}
              </div>
              <p className="field-hint span-2">Receita em branco significa <strong>sem meta de receita</strong> — não zero.</p>
            </div>
          : goal&&<div className="stack">
              <dl className="facts">
                <div><dt>Contratos</dt><dd>{count(goal.targetContracts)}</dd></div>
                <div><dt>Receita</dt><dd>{goal.targetRevenue===null?"sem meta":money(goal.targetRevenue)}</dd></div>
                {goal.note&&<div className="stacked"><dt>Observação</dt><dd>{goal.note}</dd></div>}
                <div><dt>Registrada por</dt><dd>{goal.createdBy} · {new Date(goal.updatedAt).toLocaleDateString("pt-BR")}</dd></div>
              </dl>
              {error&&<p className="form-error">{error}</p>}
              <div className="form-actions">
                <button className="button secondary" disabled={busy} onClick={()=>{setForm({targetContracts:String(goal.targetContracts),targetRevenue:goal.targetRevenue===null?"":String(goal.targetRevenue),note:goal.note??""});setEditing(true)}}>Alterar</button>
                <button className="button danger" disabled={busy} onClick={()=>void remove()}>Remover</button>
              </div>
            </div>}
      </Card>
      <Card title="Histórico de metas" badge={<Badge>{data.goals.length}</Badge>} flush>
        {data.goals.length===0
          ? <Empty icon="trending" title="Nenhuma meta registrada ainda"/>
          : <div className="list">{data.goals.map(item=><Row key={item.id} active={item.period===data.period} onClick={()=>{setState("loading");setPeriod(item.period)}}
              title={monthLabel(item.period)} detail={`${count(item.targetContracts)} contratos${item.targetRevenue===null?"":` · ${money(item.targetRevenue)}`}`} value={<Icon name="chevron-right" size={16}/>}/>)}</div>}
      </Card>
    </div>
    <Limits items={[["Meta por equipe ou vendedor","Atribuir contrato a vendedor exigiria um campo do IXC que ainda não foi confirmado. Meta calculada em cima de atribuição inventada não mede nada."]]}/>
  </>;
}
