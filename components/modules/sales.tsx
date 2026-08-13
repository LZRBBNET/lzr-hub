"use client";
import { useEffect, useState } from "react";
import { BarChart } from "./bar-chart";
import { LEAD_SOURCES, LEAD_STAGES, type FunnelMetrics, type Lead, type LeadActivity } from "@/lib/platform/crm-shared";

export function SalesModule({view}:{view:"comercial"|"funil"|"metas"|"relatorios-comercial"}){
  if(view==="funil")return <Funnel/>;
  if(view==="metas")return <Goals/>;
  if(view==="relatorios-comercial")return <SalesReports/>;
  return <SalesDashboard/>;
}

type PlanMix={plan:string;contracts:number;value:number};
type SalesSummary={activations:number;scanned:number;truncated:boolean;activeContracts:number;monthlyRecurringAdded:number;averageTicket:number|null;planMix:PlanMix[];withoutValue:number;byDay:Array<{day:string;contracts:number}>;alreadyCancelled:number};
type SalesPayload={available:boolean;detail?:string;period:string;summary:SalesSummary|null};

const money=(value:number)=>`R$ ${value.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const PERIODS:[string,string][]=[["7d","7 dias"],["30d","30 dias"],["90d","90 dias"]];

function useSales(period:string){
  const [data,setData]=useState<SalesPayload|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  useEffect(()=>{let active=true;
    fetch(`/api/sales/overview?period=${period}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:SalesPayload)=>{if(active){setData(payload);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[period]);
  return {data,state,setState};
}

function PeriodPicker({period,onChange}:{period:string;onChange:(value:string)=>void}){
  return <section className="filter-bar"><select value={period} onChange={e=>onChange(e.target.value)}>{PERIODS.map(([v,l])=><option key={v} value={v}>Últimos {l}</option>)}</select></section>;
}

function ScanNote({summary}:{summary:SalesSummary}){
  return <div className="state-card">Vendas fechadas no período, lidas do IXC: <strong>{summary.activations.toLocaleString("pt-BR")}</strong> contrato(s) ativado(s).{summary.alreadyCancelled>0&&<> Dessas, <strong>{summary.alreadyCancelled}</strong> já cancelaram — continuam contando como venda do período, e a perda é medida em Churn.</>}{summary.truncated&&<> <strong>A leitura parou antes do fim</strong> — ticket médio e mix cobrem {summary.scanned.toLocaleString("pt-BR")} delas.</>}{summary.withoutValue>0&&` ${summary.withoutValue} contrato(s) sem valor de plano legível ficaram fora do ticket médio, em vez de entrarem como zero.`}</div>;
}

function SalesDashboard(){
  const [period,setPeriod]=useState("30d");
  const {data,state,setState}=useSales(period);
  const summary=data?.summary;
  return <main className="content">
    <Heading title="Comercial" text="Venda fechada, contada nos contratos ativados no IXC."/>
    <PeriodPicker period={period} onChange={(value)=>{setState("loading");setPeriod(value)}}/>
    {state==="loading"&&<div className="state-card">Consultando o IXC…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível consultar as vendas.</div>}
    {state==="ready"&&data&&!data.available&&<div className="state-card error">{data.detail}.</div>}
    {state==="ready"&&summary&&<>
      <ScanNote summary={summary}/>
      <section className="metrics">
        <Metric label={`Vendas (${PERIODS.find(([v])=>v===period)?.[1]})`} value={summary.activations.toLocaleString("pt-BR")} detail="Contratos ativados"/>
        <Metric label="Ticket médio" value={summary.averageTicket===null?"—":money(summary.averageTicket)} detail={summary.averageTicket===null?"Nenhum contrato com valor legível":`Sobre ${summary.scanned-summary.withoutValue} contrato(s)`}/>
        <Metric label="Receita recorrente somada" value={money(summary.monthlyRecurringAdded)} detail="Mensalidade das novas vendas"/>
        <Metric label="Base ativa" value={summary.activeContracts.toLocaleString("pt-BR")} detail="Contratos ativos hoje"/>
      </section>
      <div className="dashboard-grid">
        <section className="data-card"><div className="card-header"><strong>Planos mais vendidos</strong><span className="badge blue">Últimos {PERIODS.find(([v])=>v===period)?.[1]}</span></div>
          {summary.planMix.length===0
            ? <p style={{fontSize:12,color:"var(--muted)",padding:"12px 0"}}>Nenhuma ativação no período.</p>
            : summary.planMix.slice(0,8).map(item=><div className="aging-row" key={item.plan}><div><strong>{item.plan}</strong><span>{item.contracts} venda(s) • {Math.round(item.contracts/summary.scanned*100)}% do período</span></div><b>{money(item.value)}</b></div>)}
        </section>
        <section className="data-card"><div className="card-header"><strong>O que não temos como responder</strong></div>
          <div style={{padding:"4px 0"}}>
            {[
              ["Taxa de conversão","Exige registrar o contato antes da venda. Não existe CRM: a tabela de leads nunca recebeu uma linha."],
              ["Ciclo médio de venda","Mesma razão — sabemos quando o contrato foi ativado, não quando a conversa começou."],
              ["Origem do lead","Ninguém registra de onde veio o cliente."],
              ["Previsão de churn","Quem já saiu está medido em Inteligência › Churn. Prever quem vai sair é outra coisa, e exige sinal que ninguém coleta."],
            ].map(([title,why])=><div className="aging-row" key={title}><div><strong>{title}</strong><span>{why}</span></div></div>)}
          </div>
        </section>
      </div>
    </>}
  </main>;
}

function SalesReports(){
  const [period,setPeriod]=useState("30d");
  const {data,state,setState}=useSales(period);
  const summary=data?.summary;
  return <main className="content">
    <Heading title="Relatórios comerciais" text="Volume e mix das vendas fechadas. Conversão e origem dependem de CRM, que não existe."/>
    <PeriodPicker period={period} onChange={(value)=>{setState("loading");setPeriod(value)}}/>
    {state==="loading"&&<div className="state-card">Consultando o IXC…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível gerar o relatório.</div>}
    {state==="ready"&&data&&!data.available&&<div className="state-card error">{data.detail}.</div>}
    {state==="ready"&&summary&&<>
      <ScanNote summary={summary}/>
      <section className="metrics">
        <Metric label="Vendas no período" value={summary.activations.toLocaleString("pt-BR")} detail="Contratos ativados"/>
        <Metric label="Planos distintos" value={String(summary.planMix.length)} detail="Vendidos no período"/>
        <Metric label="Plano líder" value={summary.planMix[0]?String(summary.planMix[0].contracts):"—"} detail={summary.planMix[0]?.plan??"Nenhuma venda"}/>
        <Metric label="Receita recorrente" value={money(summary.monthlyRecurringAdded)} detail="Somada das novas vendas"/>
      </section>
      <section className="data-card" style={{marginTop:14}}><div className="card-header"><strong>Vendas por dia</strong><span className="badge blue">{summary.byDay.length} dia(s) com venda</span></div>
        <BarChart data={summary.byDay} noun="venda(s)"/>
      </section>
    </>}
  </main>;
}


/* ------------------------------------------------------------------ funil --- */

type FunnelPayload={available:boolean;detail?:string;period:string;leads:Lead[];activities:LeadActivity[];metrics:FunnelMetrics|null};

const sourceLabel=(value:string)=>value.charAt(0).toUpperCase()+value.slice(1);
const dayLabel=(iso:string)=>{const d=new Date(iso);return Number.isNaN(d.getTime())?"—":d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})};

/**
 * Funil comercial real (issue #17).
 *
 * O que existia aqui antes era um `useState` com dados de demonstração: dava
 * para criar lead e mover cartão, e tudo sumia ao recarregar. Agora grava.
 *
 * O arrastar-e-soltar usa a API nativa do navegador — sem biblioteca. Quem não
 * consegue arrastar (teclado, toque) tem o mesmo caminho pelo seletor dentro do
 * cartão: arrastar é atalho, não a única porta.
 */
function Funnel(){
  const [period,setPeriod]=useState("30d");
  const [data,setData]=useState<FunnelPayload|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  const [nonce,setNonce]=useState(0);
  const [creating,setCreating]=useState(false);
  const [form,setForm]=useState({name:"",phone:"",city:"",neighborhood:"",source:"whatsapp",note:""});
  const [openId,setOpenId]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [dragging,setDragging]=useState<string|null>(null);

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
      return false;
    }catch{setError("Não foi possível salvar.");return false}
    finally{setBusy(false)}
  }

  async function move(leadId:string,toStage:string){
    if(toStage==="perdido"){
      // Perder sem motivo deixa um número que ninguém sabe explicar depois.
      const reason=window.prompt("Por que o lead foi perdido?");
      if(!reason||reason.trim().length<3)return;
      await post({action:"move",leadId,toStage,detail:reason.trim()});
      return;
    }
    await post({action:"move",leadId,toStage,detail:`Movido para ${toStage}`});
  }

  const leads=data?.leads??[];
  const metrics=data?.metrics??null;
  const open=leads.find(lead=>lead.id===openId)??null;
  const history=(data?.activities??[]).filter(item=>item.leadId===openId);
  const percent=(value:number|null)=>value===null?"—":`${Math.round(value*100)}%`;

  return <main className="content">
    <div className="page-heading">
      <div><h1>Funil comercial</h1><p>Leads gravados de verdade. Contato desconhecido no WhatsApp entra sozinho aqui.</p></div>
      {state==="ready"&&data?.available&&<button className="button" onClick={()=>{setCreating(true);setError("")}}>Novo lead</button>}
    </div>
    <PeriodPicker period={period} onChange={(value)=>{setState("loading");setPeriod(value)}}/>

    {state==="loading"&&<div className="state-card">Carregando o funil…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível carregar o funil.</div>}
    {state==="ready"&&data&&!data.available&&<div className="state-card error">{data.detail}.</div>}

    {state==="ready"&&data?.available&&<>
      {metrics&&<section className="metrics">
        <Metric label={`Leads (${PERIODS.find(([v])=>v===period)?.[1]})`} value={metrics.created.toLocaleString("pt-BR")} detail={`${metrics.open} em andamento agora`}/>
        <Metric label="Conversão" value={percent(metrics.conversionRate)} detail={metrics.conversionRate===null?"Nenhum lead encerrado ainda":`${metrics.won} ganho(s) de ${metrics.won+metrics.lost} encerrado(s)`}/>
        {/* "0,0 dias" se lê como defeito; venda fechada no mesmo dia é venda
            rápida, e é isso que a tela deve dizer. */}
        <Metric label="Ciclo médio" value={metrics.averageCycleDays===null?"—":metrics.averageCycleDays<0.5?"menos de 1 dia":`${metrics.averageCycleDays.toFixed(1)} dias`} detail={metrics.averageCycleDays===null?"Nenhum lead ganho no período":"Do primeiro contato ao ganho"}/>
        <Metric label="Origem principal" value={metrics.bySource[0]?String(metrics.bySource[0].leads):"—"} detail={metrics.bySource[0]?sourceLabel(metrics.bySource[0].source):"Nenhum lead no período"}/>
      </section>}

      {creating&&<section className="data-card" style={{marginTop:14}}>
        <div className="card-header"><strong>Novo lead</strong><span className="badge blue">Entra em “Novo contato”</span></div>
        <div style={{padding:16,display:"grid",gap:10,maxWidth:520}}>
          <label className="field"><span>Nome</span><input value={form.name} placeholder="quem entrou em contato" onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></label>
          <label className="field"><span>Telefone</span><input value={form.phone} placeholder="(79) 99999-9999" onChange={e=>setForm(f=>({...f,phone:e.target.value}))}/></label>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <label className="field"><span>Cidade</span><input value={form.city} onChange={e=>setForm(f=>({...f,city:e.target.value}))}/></label>
            <label className="field"><span>Bairro</span><input value={form.neighborhood} onChange={e=>setForm(f=>({...f,neighborhood:e.target.value}))}/></label>
          </div>
          <label className="field"><span>Origem</span>
            <select value={form.source} onChange={e=>setForm(f=>({...f,source:e.target.value}))}>{LEAD_SOURCES.map(s=><option key={s} value={s}>{sourceLabel(s)}</option>)}</select></label>
          <label className="field"><span>Observação (opcional)</span><input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))}/></label>
          {error&&<p className="form-error">{error}</p>}
          <div style={{display:"flex",gap:8}}>
            <button className="button" disabled={busy||form.name.trim().length<2} onClick={()=>{void post({action:"create",...form}).then(ok=>{if(ok){setCreating(false);setForm({name:"",phone:"",city:"",neighborhood:"",source:"whatsapp",note:""})}})}}>{busy?"Salvando…":"Registrar lead"}</button>
            <button className="button secondary" disabled={busy} onClick={()=>{setCreating(false);setError("")}}>Cancelar</button>
          </div>
        </div>
      </section>}

      {leads.length===0
        ? <div className="state-card" style={{marginTop:14}}><strong>Nenhum lead ainda.</strong><p style={{marginTop:6,lineHeight:1.6}}>Registre o primeiro acima, ou espere alguém sem cadastro escrever no WhatsApp — esse contato entra aqui sozinho.</p></div>
        : <section className="kanban">
            {LEAD_STAGES.map(stage=>{
              const cards=leads.filter(lead=>lead.stage===stage.id);
              return <div className="kanban-column" key={stage.id}
                onDragOver={e=>{e.preventDefault()}}
                onDrop={e=>{e.preventDefault();const id=e.dataTransfer.getData("text/plain")||dragging;setDragging(null);if(id)void move(id,stage.id)}}>
                <header><strong>{stage.label}</strong><span>{cards.length}</span></header>
                <p className="kanban-hint">{stage.hint}</p>
                {cards.map(lead=><article className="kanban-card" key={lead.id} draggable
                  onDragStart={e=>{e.dataTransfer.setData("text/plain",lead.id);setDragging(lead.id)}}
                  onDragEnd={()=>setDragging(null)}>
                  <button className="kanban-card-open" onClick={()=>setOpenId(lead.id===openId?null:lead.id)}>
                    <strong>{lead.name}</strong>
                    <span>{lead.maskedPhone} • {sourceLabel(lead.source)}</span>
                    <small>{lead.city}{lead.neighborhood!=="não informado"?` • ${lead.neighborhood}`:""} • desde {dayLabel(lead.createdAt)}</small>
                  </button>
                  <select value={lead.stage} disabled={busy} onChange={e=>void move(lead.id,e.target.value)} aria-label={`Mover ${lead.name} de etapa`}>
                    {LEAD_STAGES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </article>)}
              </div>;
            })}
          </section>}

      {error&&!creating&&<p className="form-error" style={{marginTop:10}}>{error}</p>}

      {open&&<section className="data-card" style={{marginTop:14}}>
        <div className="card-header"><strong>{open.name}</strong><button className="link-button" onClick={()=>setOpenId(null)}>fechar</button></div>
        <div style={{padding:16,display:"grid",gap:12,maxWidth:640}}>
          <div className="aging-row"><div><strong>{open.maskedPhone}</strong><span>{sourceLabel(open.source)} • {open.city} • {open.neighborhood}</span></div></div>
          {open.note&&<div className="aging-row"><div><strong>Observação</strong><span>{open.note}</span></div></div>}
          {open.lostReason&&<div className="aging-row"><div><strong>Motivo da perda</strong><span>{open.lostReason}</span></div></div>}
          <div>
            <h4 style={{margin:"0 0 8px",fontSize:11,textTransform:"uppercase",letterSpacing:".1em",color:"var(--text-3)"}}>Histórico</h4>
            {history.length===0
              ? <p style={{fontSize:12,color:"var(--muted)"}}>Sem registro ainda.</p>
              : history.map(item=><div className="aging-row" key={item.id}>
                  <div><strong>{item.kind==="stage_change"?`${item.fromStage??"criado"} → ${item.toStage}`:item.kind==="contact"?"Contato":"Nota"}</strong><span>{item.detail}</span></div>
                  <b style={{fontSize:11,color:"var(--muted)"}}>{dayLabel(item.createdAt)} • {item.actorId}</b>
                </div>)}
          </div>
          <LeadActivityForm leadId={open.id} busy={busy} onSubmit={(kind,detail)=>void post({action:"activity",leadId:open.id,kind,detail})}/>
          {open.stage==="ganho"&&<CreateCustomerForm key={open.id} lead={open} onDone={()=>setNonce(n=>n+1)}/>}
        </div>
      </section>}

      <div className="insight" style={{marginTop:14}}>
        <strong>O que estes números medem, e o que não.</strong>
        Conversão é ganhos ÷ encerrados — leads em andamento ficam de fora do cálculo, senão a taxa cairia toda vez que a operação captasse contato novo. Ciclo médio conta do primeiro registro ao ganho, e só existe depois que algum lead foi ganho. Valor de pipeline **não é mostrado**: exigiria um valor estimado por lead, que ninguém preenche hoje — e somar plano suposto daria um número bonito e falso.
      </div>
    </>}
  </main>;
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

  if(lead.ixcCustomerId)return <div className="state-card"><strong>Já é cliente no IXC.</strong> Cadastro <strong>{lead.ixcCustomerId}</strong>, criado a partir deste lead.</div>;
  if(!catalog)return null;
  if(!catalog.available)return <div className="state-card">Cadastrar no IXC está indisponível: {catalog.detail}.</div>;

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

  return <div style={{display:"grid",gap:10,borderTop:"1px solid var(--line)",paddingTop:12}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
      <strong style={{fontSize:12}}>Cadastrar no IXC</strong>
      <span className={`badge ${catalog.writeEnabled?"green":"amber"}`}>{catalog.writeEnabled?"● escrita ligada":"FEATURE_IXC_WRITE desligada"}</span>
    </div>
    <p style={{margin:0,fontSize:11,color:"var(--muted)",lineHeight:1.55}}>Cria o cadastro real no ERP. O documento é conferido pelos dígitos e o IXC é consultado antes, para não duplicar cliente que já existe.</p>
    <label className="field"><span>CPF ou CNPJ</span><input value={form.document} placeholder="000.000.000-00" onChange={e=>setForm(f=>({...f,document:e.target.value}))}/></label>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      <label className="field"><span>Estado</span>
        <select value={ufId} onChange={e=>{setUfId(e.target.value);setForm(f=>({...f,cityId:""}))}}>
          <option value="">Escolha…</option>{catalog.ufs.map(u=><option key={u.id} value={u.id}>{u.initials} — {u.name}</option>)}
        </select></label>
      <label className="field"><span>Cidade{catalog.cities.length?` (${catalog.cities.length})`:""}</span>
        <select value={form.cityId} disabled={!ufId} onChange={e=>setForm(f=>({...f,cityId:e.target.value}))}>
          <option value="">{ufId?"Escolha…":"Escolha o estado antes"}</option>{catalog.cities.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:10}}>
      <label className="field"><span>Rua</span><input value={form.street} onChange={e=>setForm(f=>({...f,street:e.target.value}))}/></label>
      <label className="field"><span>Número</span><input value={form.number} onChange={e=>setForm(f=>({...f,number:e.target.value}))}/></label>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      <label className="field"><span>Bairro</span><input value={form.neighborhood} onChange={e=>setForm(f=>({...f,neighborhood:e.target.value}))}/></label>
      <label className="field"><span>CEP</span><input value={form.cep} placeholder="49000-000" onChange={e=>setForm(f=>({...f,cep:e.target.value}))}/></label>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      <label className="field"><span>Telefone</span><input value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))}/></label>
      <label className="field"><span>E-mail</span><input value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))}/></label>
    </div>
    {error&&<p className="form-error">{error}</p>}
    {result&&<div className={`state-card ${result.status==="success"?"":"error"}`}>
      <strong>{result.status==="success"?"Cadastro criado no IXC":result.status==="blocked"?"Bloqueado":"Falhou"}</strong>
      <p style={{margin:"6px 0 0",lineHeight:1.6,wordBreak:"break-word"}}>{result.detail}</p>
    </div>}
    <button className="button" disabled={busy||!ready} onClick={()=>void submit()}>{busy?"Cadastrando…":"Cadastrar cliente no IXC"}</button>
  </div>;
}

/** Fora do componente: `Date.now()` no corpo é tratado como impureza em render. */
const customerKey=(leadId:string)=>`cadastro-${leadId}-${Date.now()}`;

function LeadActivityForm({leadId,busy,onSubmit}:{leadId:string;busy:boolean;onSubmit:(kind:string,detail:string)=>void}){
  const [detail,setDetail]=useState("");
  const [kind,setKind]=useState("contact");
  return <div style={{display:"grid",gap:8}} key={leadId}>
    <label className="field"><span>Registrar no cartão</span>
      <input value={detail} placeholder="ex.: liguei, pediu para retornar quinta" onChange={e=>setDetail(e.target.value)}/></label>
    <div style={{display:"flex",gap:8}}>
      <select value={kind} onChange={e=>setKind(e.target.value)}><option value="contact">Contato feito</option><option value="note">Nota</option></select>
      <button className="button secondary" disabled={busy||detail.trim().length<3} onClick={()=>{onSubmit(kind,detail.trim());setDetail("")}}>Registrar</button>
    </div>
  </div>;
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
 * Meta contra realizado.
 *
 * A meta é registrada aqui e fica auditada; o realizado vem do IXC na hora.
 * Antes esta tela mostrava "meta 380, realizado 241, projeção 104%" — três
 * números fixos no código que nunca mudavam.
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
    if(response.ok){setForm({targetContracts:"",targetRevenue:"",note:""});setNonce(n=>n+1)}
    else{const payload=await response.json().catch(()=>({}));setError(payload.error??"Não foi possível salvar a meta")}
    setBusy(false);
  }
  async function remove(){
    setBusy(true);setError("");
    const response=await fetch(`/api/sales/goals?period=${data?.period}`,{method:"DELETE"});
    if(response.ok)setNonce(n=>n+1);
    else setError("Não foi possível remover a meta");
    setBusy(false);
  }

  const showForm=editing||!goal;
  return <main className="content">
    <Heading title="Metas comerciais" text="Meta registrada por uma pessoa, realizado lido do IXC. Nada aqui é estimado."/>
    {state==="loading"&&<div className="state-card">Carregando…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível consultar as metas.</div>}
    {state==="ready"&&data&&!data.available&&<div className="state-card error">{data.detail}.</div>}
    {state==="ready"&&data?.available&&<>
      <section className="filter-bar">
        <select value={data.period} onChange={e=>{setState("loading");setPeriod(e.target.value)}}>
          {periodOptions(data.currentPeriod).map(value=><option key={value} value={value}>{monthLabel(value)}{value===data.currentPeriod?" (mês corrente)":""}</option>)}
        </select>
      </section>

      {goal&&<section className="metrics">
        <Metric label="Meta do mês" value={goal.targetContracts.toLocaleString("pt-BR")} detail={goal.targetRevenue===null?"Sem meta de receita":`e ${money(goal.targetRevenue)} de receita`}/>
        <Metric label="Realizado" value={realized?realized.contracts.toLocaleString("pt-BR"):"—"} detail={realized?`${percent(progress?.contractsPercent??0)} da meta`:"IXC indisponível"}/>
        <Metric label="Receita somada" value={realized?money(realized.revenue):"—"} detail={realized&&progress?.revenuePercent!=null?`${percent(progress.revenuePercent)} da meta de receita`:realized?"Sem meta de receita definida":"IXC indisponível"}/>
        {/* Sem realizado a projeção não existe por falta de dado, não por ser
            mês fechado — dizer "só para o mês corrente" em pleno mês corrente
            manda a pessoa procurar o erro no lugar errado. */}
        <Metric label="Projeção pelo ritmo" value={progress?.projectedContracts==null?"—":progress.projectedContracts.toLocaleString("pt-BR")} detail={!realized?"Depende do realizado, que está indisponível":progress?.projectedContracts==null?"Mês fechado não é projetado":`${percent(progress.elapsed)} do mês decorrido`}/>
      </section>}

      {goal&&realized&&progress&&<div className="state-card">
        <strong>{progress.behind?"Abaixo do ritmo necessário.":"No ritmo ou acima da meta."}</strong>
        {progress.projectedContracts!=null&&<> Mantido o ritmo atual, o mês fecha em <strong>{progress.projectedContracts.toLocaleString("pt-BR")}</strong> contra a meta de {goal.targetContracts.toLocaleString("pt-BR")}. A projeção é regra de três sobre dias corridos — não pondera dia útil nem sazonalidade.</>}
        {realized.alreadyCancelled>0&&<> {realized.alreadyCancelled} dessas venda(s) já cancelaram; elas continuam contando como venda do mês, e a perda aparece em Churn.</>}
        {realized.truncated&&<> <strong>A leitura do IXC parou antes do fim</strong> — a receita somada cobre parte das vendas.</>}
      </div>}

      {!goal&&<div className="state-card">Nenhuma meta registrada para {monthLabel(data.period)}. Registre abaixo para começar a comparar.{realized&&<> O realizado desta competência já é <strong>{realized.contracts.toLocaleString("pt-BR")}</strong> contrato(s).</>}</div>}

      <div className="dashboard-grid">
        <section className="data-card">
          <div className="card-header"><strong>{showForm?(goal?"Alterar meta":"Registrar meta"):"Meta registrada"}</strong><span className="badge blue">Fica auditado</span></div>
          {showForm
            ? <div style={{padding:16,display:"grid",gap:10}}>
                <label className="field"><span>Contratos a vender em {monthLabel(data.period)}</span>
                  <input inputMode="numeric" placeholder="ex.: 260" value={form.targetContracts} onChange={e=>setForm(f=>({...f,targetContracts:e.target.value}))}/></label>
                <label className="field"><span>Meta de receita recorrente (opcional)</span>
                  <input inputMode="decimal" placeholder="ex.: 32000,00" value={form.targetRevenue} onChange={e=>setForm(f=>({...f,targetRevenue:e.target.value}))}/></label>
                <label className="field"><span>Observação (opcional)</span>
                  <input placeholder="ex.: inclui a campanha de fibra no anel norte" value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))}/></label>
                {error&&<p className="form-error">{error}</p>}
                <div style={{display:"flex",gap:8}}>
                  <button className="button" disabled={busy} onClick={()=>void save()}>{busy?"Salvando…":goal?"Salvar alteração":"Registrar meta"}</button>
                  {goal&&<button className="button secondary" disabled={busy} onClick={()=>{setEditing(false);setError("")}}>Cancelar</button>}
                </div>
                <p className="field-hint">Deixar a receita em branco significa <strong>sem meta de receita</strong> — não zero.</p>
              </div>
            : goal&&<div style={{padding:16,display:"grid",gap:10}}>
                <div className="aging-row"><div><strong>{goal.targetContracts.toLocaleString("pt-BR")} contratos</strong><span>{goal.targetRevenue===null?"Sem meta de receita":`e ${money(goal.targetRevenue)} de receita recorrente`}</span></div></div>
                {goal.note&&<div className="aging-row"><div><strong>Observação</strong><span>{goal.note}</span></div></div>}
                <div className="aging-row"><div><strong>Registrada por</strong><span>{goal.createdBy} • atualizada em {new Date(goal.updatedAt).toLocaleString("pt-BR")}</span></div></div>
                {error&&<p className="form-error">{error}</p>}
                <div style={{display:"flex",gap:8}}>
                  <button className="button secondary" disabled={busy} onClick={()=>{setForm({targetContracts:String(goal.targetContracts),targetRevenue:goal.targetRevenue===null?"":String(goal.targetRevenue),note:goal.note??""});setEditing(true)}}>Alterar</button>
                  <button className="button secondary" disabled={busy} onClick={()=>void remove()}>Remover</button>
                </div>
              </div>}
        </section>

        <section className="data-card">
          <div className="card-header"><strong>Histórico de metas</strong><span className="badge blue">{data.goals.length} competência(s)</span></div>
          {data.goals.length===0
            ? <p className="card-empty">Nenhuma meta registrada ainda.</p>
            : <div style={{padding:"4px 0"}}>{data.goals.map(item=><div className="aging-row" key={item.id}>
                <div><strong>{monthLabel(item.period)}</strong><span>{item.targetContracts.toLocaleString("pt-BR")} contratos{item.targetRevenue===null?"":` • ${money(item.targetRevenue)}`}</span></div>
                <button className="link-button" onClick={()=>{setState("loading");setPeriod(item.period)}}>ver</button>
              </div>)}</div>}
          <div className="insight">
            <strong>Meta é da empresa, não por equipe.</strong>
            Atribuir contrato a vendedor exigiria um campo do IXC que ainda não foi confirmado. Meta por equipe calculada em cima de atribuição inventada não mede nada — quando o campo existir, esta tela ganha o recorte.
          </div>
        </section>
      </div>
    </>}
  </main>;
}

function Heading({title,text}:{title:string;text:string}){return <div className="page-heading"><div><h1>{title}</h1><p>{text}</p></div></div>}
function Metric({label,value,detail}:{label:string;value:string;detail:string}){return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">↗</span></div><strong>{value}</strong><small>{detail}</small></article>}
