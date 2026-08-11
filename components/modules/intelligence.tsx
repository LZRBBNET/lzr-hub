"use client";
import { useEffect, useState } from "react";
import { BarChart } from "./bar-chart";

export function IntelligenceModule({view}:{view:"churn"|"conhecimento"}){
  return view==="conhecimento" ? <Knowledge/> : <Churn/>;
}

/* ---------------------------------------------------------------- churn --- */

type ChurnSummary={cancellations:number;scanned:number;truncated:boolean;activeContracts:number;inactiveContracts:number;churnRate:number|null;netContracts:number|null;monthlyRecurringLost:number;reasonCodes:Array<{code:string;contracts:number}>;byDay:Array<{day:string;contracts:number}>;withoutValue:number};
type ChurnPayload={available:boolean;detail?:string;period:string;summary:ChurnSummary|null};

const money=(value:number)=>`R$ ${value.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const CHURN_PERIODS:[string,string][]=[["30d","30 dias"],["90d","90 dias"],["365d","12 meses"]];

function Churn(){
  const [period,setPeriod]=useState("30d");
  const [data,setData]=useState<ChurnPayload|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  useEffect(()=>{let active=true;
    fetch(`/api/intelligence/churn?period=${period}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:ChurnPayload)=>{if(active){setData(payload);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[period]);
  const summary=data?.summary;

  return <main className="content">
    <Heading title="Churn" text="Contratos que a BBNET perdeu, lidos do IXC."/>
    {/* A distinção importa: perda medida é fato; sinal de risco é indício, e a
        seção de baixo diz explicitamente que não é previsão validada. */}
    <div className="state-card">Os números abaixo são o churn <strong>realizado</strong> — quem já saiu, lido do IXC. A fila de risco, no fim da tela, é outra coisa: sinais observados em quem <em>ainda não</em> saiu.</div>
    <section className="filter-bar"><select value={period} onChange={e=>{setState("loading");setPeriod(e.target.value)}}>{CHURN_PERIODS.map(([v,l])=><option key={v} value={v}>Últimos {l}</option>)}</select></section>
    {state==="loading"&&<div className="state-card">Consultando o IXC…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível consultar os cancelamentos.</div>}
    {state==="ready"&&data&&!data.available&&<div className="state-card error">{data.detail}.</div>}
    {state==="ready"&&summary&&<>
      {summary.truncated&&<div className="state-card">A leitura parou antes do fim: o valor perdido e os motivos abaixo cobrem {summary.scanned.toLocaleString("pt-BR")} dos {summary.cancellations.toLocaleString("pt-BR")} cancelamentos.</div>}
      <section className="metrics">
        <Metric label={`Cancelamentos (${CHURN_PERIODS.find(([v])=>v===period)?.[1]})`} value={summary.cancellations.toLocaleString("pt-BR")} detail="Contratos encerrados no período"/>
        <Metric label="Taxa sobre a base ativa" value={summary.churnRate===null?"—":`${(summary.churnRate*100).toFixed(2).replace(".",",")}%`} detail={`Sobre ${summary.activeContracts.toLocaleString("pt-BR")} contratos ativos`}/>
        <Metric label="Saldo do período" value={summary.netContracts===null?"—":`${summary.netContracts>0?"+":""}${summary.netContracts.toLocaleString("pt-BR")}`} detail="Ativações menos cancelamentos"/>
        <Metric label="Receita recorrente perdida" value={money(summary.monthlyRecurringLost)} detail={summary.withoutValue?`${summary.withoutValue} sem valor legível ficaram de fora`:"Mensalidade dos contratos encerrados"}/>
      </section>
      <div className="dashboard-grid">
        <section className="data-card"><div className="card-header"><strong>Motivo do cancelamento</strong><span className="badge amber">Só o código</span></div>
          <p style={{fontSize:11,color:"var(--muted)",lineHeight:1.6,padding:"6px 0 12px"}}>O IXC devolve o motivo como código numérico e não expõe a tabela que traduz — testei cinco endpoints prováveis, todos recusados. Os códigos abaixo são reais; o significado precisa vir do painel do IXC ou do suporte.</p>
          {summary.reasonCodes.length===0
            ? <p style={{fontSize:12,color:"var(--muted)"}}>Nenhum cancelamento no período.</p>
            : summary.reasonCodes.slice(0,10).map(item=><div className="aging-row" key={item.code}><div><strong>Código {item.code}</strong><span>{item.contracts} contrato(s) • {Math.round(item.contracts/summary.scanned*100)}%</span></div></div>)}
        </section>
        <section className="data-card"><div className="card-header"><strong>Cancelamentos por dia</strong><span className="badge blue">{summary.byDay.length} dia(s)</span></div>
          <BarChart data={summary.byDay} noun="cancelamento(s)"/>
          <div style={{marginTop:18,padding:14,background:"var(--blue-soft)",borderRadius:10,fontSize:11,color:"var(--text-2)",lineHeight:1.6}}><strong style={{display:"block",fontSize:12,color:"var(--blue)",marginBottom:4}}>Base histórica</strong>{summary.inactiveContracts.toLocaleString("pt-BR")} contratos encerrados desde sempre, contra {summary.activeContracts.toLocaleString("pt-BR")} ativos hoje.</div>
        </section>
      </div>
    </>}
    <ChurnRiskQueue/>
  </main>;
}

type ChurnRiskRow={customerId:string;customerName:string|null;score:number;level:string;mainReason:string;suggestedAction:string;factors:Array<{points:number;reason:string}>};
type ChurnRiskPayload={available:boolean;detail?:string;queue:ChurnRiskRow[];missingSignals:string[];caveats?:string[];scope?:{candidatesFromOpenTickets:number;scored:number;unavailable:number;detail:string}};

const RISK_BADGE:Record<string,string>={"crítico":"red","alto":"amber","médio":"amber","baixo":"green"};

/**
 * Fila de ação por risco (issue #19, item 3).
 *
 * Deliberadamente **não** chamada de "previsão": os pesos nunca foram
 * comparados contra quem de fato cancelou. Chamar de previsão antes de medir o
 * acerto (item 5 da issue) seria vender adivinhação como ciência.
 */
function ChurnRiskQueue(){
  const [data,setData]=useState<ChurnRiskPayload|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  useEffect(()=>{let active=true;
    fetch("/api/intelligence/churn-risk").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:ChurnRiskPayload)=>{if(active){setData(payload);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[]);

  return <section className="data-card" style={{marginTop:14}}>
    <div className="card-header"><strong>Fila de risco de cancelamento</strong><span className="badge amber">Sinais, não previsão</span></div>
    <div style={{padding:"14px 18px 0"}}>
      <p style={{margin:0,fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
        Cada cliente abaixo soma sinais que costumam preceder cancelamento, com o peso de cada um visível.
        <strong> Isto não é previsão validada</strong> — os pesos nunca foram comparados contra quem de fato cancelou, então não há taxa de acerto para mostrar ainda.
      </p>
    </div>
    {state==="loading"&&<p className="card-empty">Consultando chamados e faturas…</p>}
    {state==="error"&&<p className="card-empty">Não foi possível montar a fila.</p>}
    {state==="ready"&&data&&!data.available&&<p className="card-empty">{data.detail}.</p>}
    {state==="ready"&&data?.available&&<>
      {data.queue.length===0
        ? <p className="card-empty">Nenhum cliente com sinal de risco entre os avaliados.</p>
        : data.queue.map(row=><div className="team-row" key={row.customerId}>
            <div className="team-head">
              <div>
                <strong>{row.customerName ?? `Cliente ${row.customerId}`}<span className={`badge ${RISK_BADGE[row.level]??"blue"}`} style={{marginLeft:8}}>{row.level}</span></strong>
                <span>{row.mainReason}</span>
              </div>
              <div className="team-load"><b>{row.score}</b><small>de 100</small></div>
            </div>
            <div className="team-tags">{row.factors.map((f,i)=><span key={i}>{f.reason} <b>+{f.points}</b></span>)}</div>
            <div style={{fontSize:11,color:"var(--blue)"}}>➜ {row.suggestedAction}</div>
          </div>)}
      <div className="insight">
        <strong>Como ler estes números.</strong>
        {data.caveats?.map((c,i)=><span key={i} style={{display:"block"}}>• {c}</span>)}
        <span style={{display:"block",marginTop:6}}>{data.scope?.detail} Sinais não coletados: {data.missingSignals.join("; ")}.</span>
      </div>
    </>}
  </section>;
}

// Saúde do Cliente, Upgrade e Customer Intelligence saíram do menu: nenhuma
// tinha modelo calculando nada. Ver `docs/telas-removidas.md`.

/* ----------------------------------------------------------- conhecimento --- */

type Doc={id:string;title:string;category:string;content:string;status:string;version:number;updatedAt:string};
type Hit={document:Doc;score:number;evidence:string};

function Knowledge(){
  const [items,setItems]=useState<Doc[]>([]);
  const [available,setAvailable]=useState(true);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  const [nonce,setNonce]=useState(0);
  const [query,setQuery]=useState("");
  const [results,setResults]=useState<Hit[]|null>(null);
  const [form,setForm]=useState({title:"",category:"Geral",content:""});
  const [message,setMessage]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);

  useEffect(()=>{let active=true;
    fetch("/api/knowledge").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:{available:boolean;items:Doc[]})=>{if(active){setAvailable(payload.available);setItems(payload.items??[]);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[nonce]);

  async function ingest(){
    setBusy(true);setMessage(null);
    const response=await fetch("/api/knowledge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"ingest",...form})});
    const payload=await response.json();
    if(response.ok){setForm({title:"",category:"Geral",content:""});setMessage(`Rascunho "${payload.title}" criado.`);setNonce(n=>n+1)}
    else setMessage(payload.error??"Não foi possível criar o documento.");
    setBusy(false);
  }
  async function publish(id:string){
    setBusy(true);setMessage(null);
    const response=await fetch("/api/knowledge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"publish",id})});
    setMessage(response.ok?"Documento publicado.":"Não foi possível publicar.");
    setNonce(n=>n+1);setBusy(false);
  }
  async function search(){
    if(!query.trim()){setResults(null);return}
    const response=await fetch(`/api/knowledge?q=${encodeURIComponent(query)}`);
    if(response.ok){const payload=await response.json() as {results:Hit[]};setResults(payload.results??[])}
  }

  return <main className="content">
    <Heading title="Base de Conhecimento" text="Fontes internas que a IA pode citar. Só documento publicado vira fonte."/>
    {state==="loading"&&<div className="state-card">Carregando documentos…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível carregar a base.</div>}
    {state==="ready"&&!available&&<div className="state-card error">Base de conhecimento indisponível — sem banco não há onde ler nem gravar.</div>}
    {state==="ready"&&available&&<>
      {message&&<div className="state-card">{message}</div>}
      <div className="support-grid">
        <section className="data-card"><div className="card-header"><strong>Novo documento</strong><span className="badge blue">Nasce como rascunho</span></div>
          <div className="wizard" style={{display:"grid",gap:8}}>
            <input placeholder="Título" value={form.title} onChange={e=>{setForm({...form,title:e.target.value});setMessage(null)}}/>
            <input placeholder="Categoria" value={form.category} onChange={e=>setForm({...form,category:e.target.value})}/>
            <textarea placeholder="Conteúdo que a IA vai citar…" rows={5} value={form.content} onChange={e=>setForm({...form,content:e.target.value})}/>
            <button className="button" disabled={busy} onClick={()=>void ingest()}>{busy?"Salvando…":"Criar rascunho"}</button>
          </div>
        </section>
        <section className="data-card"><div className="card-header"><strong>Buscar na base</strong><span className="badge">Texto, não semântica</span></div>
          <div className="wizard" style={{display:"grid",gap:8}}>
            <input placeholder="Ex.: segunda via boleto" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void search()}}/>
            <button className="button secondary" onClick={()=>void search()}>Buscar</button>
            {results===null
              ? <p style={{fontSize:11,color:"var(--muted)",lineHeight:1.6}}>A busca é por correspondência de texto. Busca semântica dependeria de embeddings (<code>FEATURE_PGVECTOR</code>), que não estão gerados.</p>
              : results.length===0
                ? <p style={{fontSize:12,color:"var(--muted)"}}>Nenhum documento publicado corresponde.</p>
                : results.map(hit=><div className="aging-row" key={hit.document.id}><div><strong>{hit.document.title}</strong><span>{hit.evidence}</span></div><b>{Math.round(hit.score*100)}%</b></div>)}
          </div>
        </section>
      </div>
      <section className="data-card" style={{marginTop:14}}><div className="card-header"><strong>Documentos</strong><span className="badge green">{items.length}</span></div>
        {items.length===0
          ? <p style={{padding:14,lineHeight:1.6,color:"var(--muted)"}}>Nenhum documento cadastrado. A base começa vazia — nada de exemplo é pré-carregado, porque a IA citaria isso como se fosse procedimento da BBNET.</p>
          : items.map(doc=><div className="aging-row" key={doc.id}>
              <div><strong>{doc.title}</strong><span>{doc.category} • versão {doc.version} • {new Date(doc.updatedAt).toLocaleString("pt-BR")}</span></div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <i className={`badge ${doc.status==="published"?"green":""}`}>{doc.status==="published"?"Publicado":"Rascunho"}</i>
                {doc.status!=="published"&&<button disabled={busy} onClick={()=>void publish(doc.id)}>Publicar</button>}
              </div>
            </div>)}
      </section>
    </>}
  </main>;
}

function Heading({title,text}:{title:string;text:string}){return <div className="page-heading"><div><h1>{title}</h1><p>{text}</p></div></div>}
function Metric({label,value,detail}:{label:string;value:string;detail:string}){return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">◈</span></div><strong>{value}</strong><small>{detail}</small></article>}
