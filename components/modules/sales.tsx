"use client";
import { useEffect, useState } from "react";
import { BarChart } from "./bar-chart";

// Leads, Funil e Kanban saíram do menu: dependem de um CRM que não existe.
// Ver `docs/telas-removidas.md`.
export function SalesModule({view}:{view:"comercial"|"metas"|"relatorios-comercial"}){
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
