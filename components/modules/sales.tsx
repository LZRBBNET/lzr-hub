"use client";
import { useEffect, useState } from "react";
import { BarChart } from "./bar-chart";

export function SalesModule({view}:{view:"comercial"|"leads"|"funil"|"kanban"|"metas"|"relatorios-comercial"}){
  if(view==="leads")return <NoCrm title="Leads" what="uma lista de leads"/>;
  if(view==="funil"||view==="kanban")return <NoCrm title="Funil e Kanban" what="um funil de vendas"/>;
  if(view==="metas")return <Goals/>;
  if(view==="relatorios-comercial")return <SalesReports/>;
  return <SalesDashboard/>;
}

type PlanMix={plan:string;contracts:number;value:number};
type SalesSummary={activations:number;scanned:number;truncated:boolean;activeContracts:number;monthlyRecurringAdded:number;averageTicket:number|null;planMix:PlanMix[];withoutValue:number;byDay:Array<{day:string;contracts:number}>};
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
  return <div className="state-card">Vendas fechadas no período, lidas do IXC: <strong>{summary.activations.toLocaleString("pt-BR")}</strong> contrato(s) ativado(s).{summary.truncated&&<> <strong>A leitura parou antes do fim</strong> — ticket médio e mix cobrem {summary.scanned.toLocaleString("pt-BR")} delas.</>}{summary.withoutValue>0&&` ${summary.withoutValue} contrato(s) sem valor de plano legível ficaram fora do ticket médio, em vez de entrarem como zero.`}</div>;
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
            ? <p style={{fontSize:12,color:"#64748b",padding:"12px 0"}}>Nenhuma ativação no período.</p>
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

/**
 * Leads, funil e kanban viviam de dados de demonstração num useState: dava para
 * "criar" um lead e "mover de etapa", e tudo sumia ao recarregar. Sem CRM, o
 * honesto é dizer que não existe — e o que seria preciso para existir.
 */
function NoCrm({title,what}:{title:string;what:string}){
  return <main className="content">
    <Heading title={title} text={`Não há ${what} porque não há CRM conectado.`}/>
    <div className="state-card error"><strong>Nenhum lead é registrado hoje — nem aqui, nem no IXC.</strong>
      <p style={{marginTop:8,lineHeight:1.7}}>Esta tela mantinha leads de exemplo em memória: dava para &quot;criar&quot; e &quot;mover de etapa&quot;, e tudo sumia ao recarregar a página. Foi removido, porque parecia um funil de verdade.</p>
    </div>
    <section className="data-card" style={{marginTop:14}}>
      <div className="card-header"><strong>O que falta para existir</strong></div>
      <div style={{padding:"4px 0"}}>
        {[
          ["Captura do contato","Alguém precisa registrar o interessado antes da venda. Hoje o primeiro registro que existe é o contrato já assinado."],
          ["Origem","De onde veio (WhatsApp, indicação, campanha) — sem isso não há como comparar canais."],
          ["Etapas e responsável","Um funil só significa algo se a mudança de etapa for gravada com quem moveu e quando."],
          ["Consulta de cobertura","Qualificar lead sem saber se o endereço tem rede é chute."],
        ].map(([item,why])=><div className="aging-row" key={item}><div><strong>{item}</strong><span>{why}</span></div></div>)}
      </div>
    </section>
    <div className="state-card" style={{marginTop:14}}>O que já dá para acompanhar é a <strong>venda fechada</strong>, no Dashboard e nos Relatórios — essa vem do IXC e é real.</div>
  </main>;
}

function Goals(){
  return <main className="content">
    <Heading title="Metas comerciais" text="Acompanhamento de meta contra realizado."/>
    <div className="state-card error"><strong>Nenhuma meta cadastrada.</strong>
      <p style={{marginTop:8,lineHeight:1.7}}>A tela mostrava &quot;meta 380, realizado 241, projeção 104% da meta&quot; — números fixos no código, que não vinham de lugar nenhum e não mudavam nunca.</p>
    </div>
    <div className="state-card" style={{marginTop:14}}>O <strong>realizado</strong> já é medido de verdade (contratos ativados, no Dashboard). Falta um lugar para registrar a meta: por período, equipe e produto. Enquanto não existir, comparar contra uma meta inventada seria pior do que não comparar.</div>
  </main>;
}

function Heading({title,text}:{title:string;text:string}){return <div className="page-heading"><div><h1>{title}</h1><p>{text}</p></div></div>}
function Metric({label,value,detail}:{label:string;value:string;detail:string}){return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">↗</span></div><strong>{value}</strong><small>{detail}</small></article>}
