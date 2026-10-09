"use client";
import { useEffect, useState } from "react";
import { BarChart } from "./bar-chart";
import { ReplyTemplates } from "./reply-templates";
import { Icon } from "@/components/ui/icons";
import { Badge, Bar, Card, Empty, InfoTip, Limits, Loading, Modal, Notice, Row, Segmented, Stat, Stats, Toolbar, count, dateTime, money, useToast } from "@/components/ui/kit";

export function IntelligenceModule({view}:{view:"churn"|"conhecimento"|"respostas"}){
  if(view==="respostas")return <ReplyTemplates/>;
  return view==="conhecimento" ? <Knowledge/> : <Churn/>;
}

/* ---------------------------------------------------------------- churn --- */

type ChurnSummary={cancellations:number;scanned:number;truncated:boolean;activeContracts:number;inactiveContracts:number;churnRate:number|null;netContracts:number|null;monthlyRecurringLost:number;reasonCodes:Array<{code:string;contracts:number}>;byDay:Array<{day:string;contracts:number}>;withoutValue:number};
type ChurnPayload={available:boolean;detail?:string;period:string;summary:ChurnSummary|null};
const CHURN_PERIODS=[["30d","30 dias"],["90d","90 dias"],["365d","12 meses"]] as const;

/**
 * Churn realizado (quem já saiu, lido do IXC) em cima; a fila de risco, que é
 * indício e não fato, embaixo e com o nome certo.
 */
function Churn(){
  const [period,setPeriod]=useState<typeof CHURN_PERIODS[number][0]>("30d");
  const [data,setData]=useState<ChurnPayload|null>(null);
  const [loadedFor,setLoadedFor]=useState<string|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{let active=true;
    fetch(`/api/intelligence/churn?period=${period}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:ChurnPayload)=>{if(active){setData(payload);setFailed(false);setLoadedFor(period)}})
      .catch(()=>{if(active){setFailed(true);setLoadedFor(period)}});
    return()=>{active=false}},[period]);
  const summary=data?.summary;
  const loading=loadedFor!==period;

  return <>
    <Toolbar><Segmented label="Período" value={period} options={CHURN_PERIODS} onChange={setPeriod}/></Toolbar>
    {loading&&<Loading stats={4} rows={3}/>}
    {!loading&&failed&&<Notice tone="bad">Não foi possível consultar os cancelamentos.</Notice>}
    {!loading&&!failed&&data&&!data.available&&<Notice tone="bad">{data.detail}.</Notice>}
    {!loading&&!failed&&summary&&<>
      {summary.truncated&&<Notice tone="warn">A leitura parou antes do fim: valor perdido e motivos cobrem {count(summary.scanned)} dos {count(summary.cancellations)} cancelamentos.</Notice>}
      <Stats>
        <Stat label="Cancelamentos" icon="churn" tone={summary.cancellations?"warn":"neutral"} value={count(summary.cancellations)} hint={`Contratos encerrados em ${CHURN_PERIODS.find(([v])=>v===period)?.[1]}`}/>
        <Stat label="Taxa sobre a base ativa" icon="users" value={summary.churnRate===null?"—":`${(summary.churnRate*100).toFixed(2).replace(".",",")}%`} hint={`Sobre ${count(summary.activeContracts)} contratos ativos`}/>
        <Stat label="Saldo do período" icon="trending" tone={summary.netContracts!==null&&summary.netContracts<0?"bad":summary.netContracts?"ok":"neutral"} value={summary.netContracts===null?"—":`${summary.netContracts>0?"+":""}${count(summary.netContracts)}`} hint="Ativações menos cancelamentos"/>
        <Stat label="Receita recorrente perdida" icon="wallet" value={money(summary.monthlyRecurringLost)} hint={summary.withoutValue?`${summary.withoutValue} sem valor legível ficaram de fora`:"Mensalidade dos contratos encerrados"}/>
      </Stats>
      <div className="grid-2">
        <Card title="Cancelamentos por dia" badge={<Badge>{summary.byDay.length} dia(s)</Badge>} flush>
          <BarChart data={summary.byDay} noun="cancelamento(s)"/>
        </Card>
        <Card title={<>Motivo do cancelamento <InfoTip label="Por que só o código">O IXC devolve o motivo como código numérico e não expõe a tabela que traduz — cinco endpoints prováveis foram testados, todos recusados. Os códigos são reais; o significado precisa vir do painel do IXC.</InfoTip></>} badge={<Badge tone="warn">só o código</Badge>}>
          {summary.reasonCodes.length===0
            ? <Empty icon="check" title="Nenhum cancelamento no período"/>
            : <div className="bars">{summary.reasonCodes.slice(0,8).map(item=><Bar key={item.code} label={`Código ${item.code}`} value={item.contracts} max={summary.reasonCodes[0].contracts} display={`${Math.round(item.contracts/Math.max(summary.scanned,1)*100)}%`}/>)}</div>}
          <p className="hint" style={{marginTop:14}}>Base histórica: {count(summary.inactiveContracts)} contratos encerrados desde sempre, contra {count(summary.activeContracts)} ativos hoje.</p>
        </Card>
      </div>
    </>}
    <ChurnRiskQueue/>
  </>;
}

type ChurnRiskRow={customerId:string;customerName:string|null;score:number;level:string;mainReason:string;suggestedAction:string;factors:Array<{points:number;reason:string}>};
type ChurnRiskPayload={available:boolean;detail?:string;queue:ChurnRiskRow[];missingSignals:string[];caveats?:string[];scope?:{candidatesFromOpenTickets:number;scored:number;unavailable:number;detail:string}};
const RISK_TONE:Record<string,"bad"|"warn"|"ok"|"info">={"crítico":"bad","alto":"warn","médio":"warn","baixo":"ok"};

/**
 * Fila de ação por risco (issue #19, item 3).
 *
 * Deliberadamente **não** chamada de "previsão": os pesos nunca foram
 * comparados contra quem de fato cancelou. Chamar de previsão antes de medir o
 * acerto seria vender adivinhação como ciência.
 */
function ChurnRiskQueue(){
  const [data,setData]=useState<ChurnRiskPayload|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  useEffect(()=>{let active=true;
    fetch("/api/intelligence/churn-risk").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:ChurnRiskPayload)=>{if(active){setData(payload);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[]);

  return <>
    <h3 className="section-title" style={{marginTop:28}}>Clientes com sinal de risco</h3>
    <Card title={<>Fila de risco <InfoTip label="Como ler a fila">Cada cliente soma sinais que costumam preceder cancelamento, com o peso de cada um visível. <strong>Não é previsão validada</strong>: os pesos nunca foram comparados contra quem de fato cancelou.</InfoTip></>} badge={<Badge tone="warn">sinais, não previsão</Badge>} flush>
      {state==="loading"&&<Loading rows={3}/>}
      {state==="error"&&<div className="card-content"><Notice tone="bad">Não foi possível montar a fila.</Notice></div>}
      {state==="ready"&&data&&!data.available&&<Empty icon="churn" title="Fila indisponível">{data.detail}.</Empty>}
      {state==="ready"&&data?.available&&(data.queue.length===0
        ? <Empty icon="check" title="Nenhum cliente com sinal de risco entre os avaliados"/>
        : data.queue.map(row=><div className="team-row" key={row.customerId}>
            <div className="team-head">
              <div><strong>{row.customerName ?? `Cliente ${row.customerId}`}<Badge tone={RISK_TONE[row.level]??"info"}>{row.level}</Badge></strong><span>{row.mainReason}</span></div>
              <div className="team-load"><b>{row.score}</b><small>de 100</small></div>
            </div>
            <div className="chips">{row.factors.map((f,i)=><span className="chip" key={i}>{f.reason} <b>+{f.points}</b></span>)}</div>
            <div className="risk-action"><Icon name="chevron-right" size={14}/>{row.suggestedAction}</div>
          </div>))}
    </Card>
    {state==="ready"&&data?.available&&<Limits title="Como ler estes números" items={[
      ...(data.caveats?.length?[["Ressalvas",<ul key="c" className="plain-list">{data.caveats.map((c,i)=><li key={i}>{c}</li>)}</ul>] as [string,React.ReactNode]]:[]),
      ...(data.scope?.detail?[["Quem foi avaliado",data.scope.detail] as [string,string]]:[]),
      ...(data.missingSignals.length?[["Sinais não coletados",data.missingSignals.join("; ")] as [string,string]]:[]),
    ]}/>}
  </>;
}

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
  const [searching,setSearching]=useState(false);
  const [creating,setCreating]=useState(false);
  const [viewing,setViewing]=useState<Doc|null>(null);
  const [form,setForm]=useState({title:"",category:"Geral",content:""});
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [statusFilter,setStatusFilter]=useState<"all"|"published"|"draft">("all");
  const toast=useToast();

  useEffect(()=>{let active=true;
    fetch("/api/knowledge").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:{available:boolean;items:Doc[]})=>{if(active){setAvailable(payload.available);setItems(payload.items??[]);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[nonce]);

  async function ingest(){
    setBusy(true);setError(null);
    const response=await fetch("/api/knowledge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"ingest",...form})});
    const payload=await response.json();
    if(response.ok){setForm({title:"",category:"Geral",content:""});setCreating(false);toast(`Rascunho "${payload.title}" criado.`);setNonce(n=>n+1)}
    else setError(payload.error??"Não foi possível criar o documento.");
    setBusy(false);
  }
  async function publish(id:string){
    setBusy(true);
    const response=await fetch("/api/knowledge",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"publish",id})});
    toast(response.ok?"Documento publicado — já pode ser citado.":"Não foi possível publicar.",response.ok?"ok":"bad");
    setNonce(n=>n+1);setBusy(false);
  }
  async function search(){
    if(!query.trim()){setResults(null);return}
    setSearching(true);
    const response=await fetch(`/api/knowledge?q=${encodeURIComponent(query)}`);
    if(response.ok){const payload=await response.json() as {results:Hit[]};setResults(payload.results??[])}
    setSearching(false);
  }

  if(state==="loading")return <Loading rows={5}/>;
  if(state==="error")return <Notice tone="bad">Não foi possível carregar a base.</Notice>;
  if(!available)return <Notice tone="bad">Base de conhecimento indisponível — sem banco não há onde ler nem gravar.</Notice>;
  const published=items.filter(doc=>doc.status==="published").length;
  const shown=items.filter(doc=>statusFilter==="all"||(statusFilter==="published"?doc.status==="published":doc.status!=="published"));
  return <>
    <Toolbar actions={<button className="button" onClick={()=>{setCreating(true);setError(null)}}><Icon name="plus" size={16}/>Novo documento</button>}>
      <form className="search-field" onSubmit={e=>{e.preventDefault();void search()}}>
        <Icon name="search" size={16}/><input placeholder="Testar a busca da IA: ex. segunda via boleto" value={query} onChange={e=>{setQuery(e.target.value);if(!e.target.value.trim())setResults(null)}} aria-label="Buscar na base"/>
        {query&&<button type="button" className="icon-button" style={{width:24,height:24}} aria-label="Limpar busca" onClick={()=>{setQuery("");setResults(null)}}><Icon name="x" size={14}/></button>}
      </form>
      <InfoTip label="Como a busca funciona">A busca é por correspondência de texto, a mesma que o copiloto usa. Busca semântica dependeria de embeddings (<code>FEATURE_PGVECTOR</code>), que não estão gerados. Só documento publicado vira fonte.</InfoTip>
    </Toolbar>

    {results!==null&&<Card title={`Resultado para “${query}”`} badge={<Badge>{results.length}</Badge>} actions={<button className="link-button" onClick={()=>{setResults(null);setQuery("")}}>limpar</button>} flush>
      {searching?<Loading rows={2}/>:results.length===0
        ? <Empty icon="search" title="Nenhum documento publicado corresponde"/>
        : <div className="list">{results.map(hit=><Row key={hit.document.id} title={hit.document.title} detail={hit.evidence} value={`${Math.round(hit.score*100)}%`} onClick={()=>setViewing(hit.document)}/>)}</div>}
    </Card>}

    <Card title="Documentos" badge={<Badge>{published} publicado(s) de {items.length}</Badge>}
      actions={items.length>0&&<Segmented label="Filtrar documentos" value={statusFilter} options={[["all","Todos"],["published","Publicados"],["draft","Rascunhos"]]} onChange={setStatusFilter}/>} flush>
      {items.length===0
        ? <Empty icon="book" title="Nenhum documento cadastrado" action={<button className="button secondary" onClick={()=>setCreating(true)}>Criar o primeiro</button>}>A base começa vazia — nada de exemplo é pré-carregado, porque a IA citaria isso como se fosse procedimento da BBNET.</Empty>
        : <div className="list">{shown.map(doc=><div className="row" key={doc.id}>
            <button type="button" className="row-main link-like" onClick={()=>setViewing(doc)}><strong>{doc.title}</strong><span>{doc.category} · versão {doc.version} · {dateTime(doc.updatedAt)}</span></button>
            <div className="row-value">
              {doc.status==="published"?<Badge tone="ok">Publicado</Badge>:<><Badge>Rascunho</Badge><button className="button secondary small" disabled={busy} onClick={()=>void publish(doc.id)}>Publicar</button></>}
            </div>
          </div>)}</div>}
    </Card>

    <Modal open={creating} title="Novo documento" wide onClose={()=>setCreating(false)}
      footer={<><button className="button secondary" onClick={()=>setCreating(false)}>Cancelar</button><button className="button" disabled={busy||!form.title.trim()||!form.content.trim()} onClick={()=>void ingest()}>{busy?"Salvando…":"Criar rascunho"}</button></>}>
      <div className="form-grid">
        <label className="field"><span>Título</span><input data-autofocus value={form.title} placeholder="ex.: Cliente sem conexão em fibra" onChange={e=>setForm({...form,title:e.target.value})}/></label>
        <label className="field"><span>Categoria</span><input value={form.category} onChange={e=>setForm({...form,category:e.target.value})}/></label>
        <label className="field span-2"><span>Conteúdo que a IA vai citar</span><textarea rows={10} value={form.content} onChange={e=>setForm({...form,content:e.target.value})}/></label>
        {error&&<p className="form-error span-2">{error}</p>}
        <p className="field-hint span-2">Nasce como rascunho: só vira fonte da IA e do copiloto depois de publicado.</p>
      </div>
    </Modal>

    <Modal side open={!!viewing} title={viewing?.title??""} onClose={()=>setViewing(null)}>
      {viewing&&<div className="stack">
        <div className="chips">{viewing.status==="published"?<Badge tone="ok">Publicado</Badge>:<Badge>Rascunho</Badge>}<Badge>{viewing.category}</Badge><Badge>versão {viewing.version}</Badge></div>
        <p className="doc-content">{viewing.content}</p>
        <p className="hint">Atualizado em {dateTime(viewing.updatedAt)}</p>
      </div>}
    </Modal>
  </>;
}

