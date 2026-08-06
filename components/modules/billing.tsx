"use client";
import { useEffect, useState } from "react";
import { RULE_CHANNELS, type RuleStepInput } from "@/lib/platform/collection-rules-shared";

export function BillingModule({view}:{view:"cobranca"|"regua"|"campanhas"|"relatorios-cobranca"}){if(view==="regua")return <RuleBuilder/>;if(view==="campanhas")return <Campaigns/>;if(view==="relatorios-cobranca")return <BillingReports/>;return <BillingDashboard/>}

type AgingBucket={label:string;minDays:number;maxDays:number|null;invoices:number;value:number};
type BillingSummary={scope:string;customersConsulted:number;customersUnavailable:number;openInvoices:number;openValue:number;overdueInvoices:number;overdueValue:number;upcomingInvoices:number;upcomingValue:number;aging:AgingBucket[];paymentsInPeriod:number;paidInPeriod:number;paymentMethods:Record<string,number>;invoicesWithoutDueDate:number};
type FullBaseSummary={scope:"full-base";openInvoices:number;openValue:null;overdueInvoices:number;overdueValue:number;overdueScanned:number;truncated:boolean;aging:AgingBucket[];invoicesWithoutDueDate:number};
type BillingPayload={available:boolean;detail?:string;period:string;scope?:"allowlist"|"full-base";allowlistSize?:number;summary:BillingSummary|FullBaseSummary|null};
const isFullBase=(summary:BillingSummary|FullBaseSummary|null):summary is FullBaseSummary=>summary?.scope==="full-base";

const money=(value:number)=>`R$ ${value.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
/** A régua escrevia "1 dias depois do vencimento". Um dia é um dia. */
const offsetLabel=(days:number)=>{
  if(days===0)return "No vencimento";
  const n=Math.abs(days), palavra=n===1?"dia":"dias";
  return days<0?`${n} ${palavra} antes do vencimento`:`${n} ${palavra} depois do vencimento`;
};
const PERIODS:[string,string][]=[["24h","24 horas"],["7d","7 dias"],["30d","30 dias"]];

function useBilling(period:string){
  const [data,setData]=useState<BillingPayload|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  useEffect(()=>{let active=true;
    fetch(`/api/billing/overview?period=${period}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:BillingPayload)=>{if(active){setData(payload);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[period]);
  return {data,state,setState};
}

/** O leitor precisa saber de qual recorte o número saiu — senão lê tudo como carteira inteira. */
function ScopeNote({summary,allowlistSize}:{summary:BillingSummary|FullBaseSummary;allowlistSize?:number}){
  if(isFullBase(summary))return <div className="state-card">Base inteira do IXC. As vencidas foram somadas uma a uma ({summary.overdueScanned.toLocaleString("pt-BR")} fatura(s) lidas).{summary.truncated&&<> <strong>A varredura parou antes do fim</strong> — o valor abaixo é parcial e está identificado como tal.</>}</div>;
  return <div className="state-card">Recorte: <strong>{summary.customersConsulted} cadastro(s)</strong> da allowlist do IXC{allowlistSize&&allowlistSize!==summary.customersConsulted?` (de ${allowlistSize})`:""} — trava nossa, de homologação. <strong>Isto não é a carteira inteira da BBNET.</strong>{summary.customersUnavailable>0&&` ${summary.customersUnavailable} cadastro(s) não responderam e ficaram de fora da conta.`}</div>;
}

function BillingDashboard(){
  const [period,setPeriod]=useState("30d");
  const {data,state,setState}=useBilling(period);
  const summary=data?.summary;
  return <main className="content">
    <Heading title="Cobrança" text="Posição financeira lida direto do IXC. Nenhum valor é estimado."/>
    <section className="filter-bar"><select value={period} onChange={e=>{setState("loading");setPeriod(e.target.value)}}>{PERIODS.map(([v,l])=><option key={v} value={v}>Pagamentos: últimos {l}</option>)}</select></section>
    {state==="loading"&&<div className="state-card">Consultando o IXC…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível consultar a posição financeira.</div>}
    {state==="ready"&&data&&!data.available&&<div className="state-card error">{data.detail}. Nenhum número é exibido — zero aqui seria lido como &quot;ninguém deve nada&quot;.</div>}
    {state==="ready"&&summary&&<>
      <ScopeNote summary={summary} allowlistSize={data?.allowlistSize}/>
      <section className="metrics">
        <Metric label="Vencido" value={money(summary.overdueValue)} detail={isFullBase(summary)&&summary.truncated?`Parcial: ${summary.overdueScanned.toLocaleString("pt-BR")} de ${summary.overdueInvoices.toLocaleString("pt-BR")} faturas`:`${summary.overdueInvoices.toLocaleString("pt-BR")} fatura(s) em atraso`}/>
        {isFullBase(summary)
          ? <Metric label="Faturas em aberto" value={summary.openInvoices.toLocaleString("pt-BR")} detail="Contagem exata do IXC"/>
          : <Metric label="A vencer" value={money(summary.upcomingValue)} detail={`${summary.upcomingInvoices} fatura(s) em aberto no prazo`}/>}
        {isFullBase(summary)
          ? <Metric label="Valor total em aberto" value="—" detail="Somar exigiria varrer 74 mil faturas por acesso"/>
          : <Metric label={`Recebido (${PERIODS.find(([v])=>v===period)?.[1]})`} value={money(summary.paidInPeriod)} detail={`${summary.paymentsInPeriod} pagamento(s)`}/>}
        {isFullBase(summary)
          ? <Metric label="Ticket médio das vencidas" value={summary.overdueScanned?money(summary.overdueValue/summary.overdueScanned):"—"} detail="Sobre as faturas efetivamente lidas"/>
          : <Metric label="Total em aberto" value={money(summary.openValue)} detail={`${summary.openInvoices} fatura(s)`}/>}
      </section>
      <div className="dashboard-grid">
        <section className="data-card"><div className="card-header"><strong>Faixa de atraso</strong><span className="badge blue">Calculado da data real de vencimento</span></div>
          {summary.overdueInvoices===0
            ? <p style={{fontSize:12,color:"var(--muted)",padding:"12px 0"}}>Nenhuma fatura vencida entre os cadastros consultados.</p>
            : summary.aging.map(bucket=><div className="aging-row" key={bucket.label}><div><strong>{bucket.label}</strong><span>{bucket.invoices} fatura(s) • {Math.round(bucket.invoices/summary.overdueInvoices*100)}% das vencidas</span></div><b>{money(bucket.value)}</b></div>)}
          {summary.invoicesWithoutDueDate>0&&<div className="state-card" style={{marginTop:12}}>{summary.invoicesWithoutDueDate} fatura(s) em aberto sem data de vencimento legível ficaram fora das faixas, em vez de serem chutadas para uma.</div>}
        </section>
        {isFullBase(summary)
          ? <section className="data-card"><div className="card-header"><strong>O que ainda não dá para responder</strong></div>
              <div style={{padding:"4px 0"}}>
                {[
                  ["Valor total em aberto","São 73.870 faturas. O IXC devolve a contagem numa consulta, mas não soma valores — só varrendo tudo, o que não cabe numa abertura de tela. Cabe num job noturno."],
                  ["Pagamentos do período","A tabela de pagamentos se liga à fatura, não ao cliente. Cruzar isso na base inteira tem o mesmo problema de varredura."],
                  ["Recuperação por campanha","Nenhuma campanha foi executada; não há o que atribuir."],
                ].map(([title,why])=><div className="aging-row" key={title}><div><strong>{title}</strong><span>{why}</span></div></div>)}
              </div>
            </section>
          : <section className="data-card"><div className="card-header"><strong>Como pagaram</strong><span className="badge blue">Últimos {PERIODS.find(([v])=>v===period)?.[1]}</span></div>
          {summary.paymentsInPeriod===0
            ? <p style={{fontSize:12,color:"var(--muted)",padding:"12px 0"}}>Nenhum pagamento registrado no período.</p>
            : Object.entries(summary.paymentMethods).sort((a,b)=>b[1]-a[1]).map(([method,count])=><div className="aging-row" key={method}><div><strong>{method}</strong><span>{count} pagamento(s)</span></div><b>{Math.round(count/summary.paymentsInPeriod*100)}%</b></div>)}
          <div style={{marginTop:18,padding:14,background:"var(--blue-soft)",borderRadius:10,fontSize:11,color:"var(--text-2)",lineHeight:1.6}}><strong style={{display:"block",fontSize:12,color:"var(--blue)",marginBottom:4}}>Ainda não medimos</strong>Recuperação atribuída a campanha, conversão e ROI dependem de campanha executada — e campanha não está ligada. Sem isso, qualquer número seria invenção.</div>
        </section>}
      </div>
      <InvoiceReissuePanel/>
    </>}
  </main>;
}

type IxcWriteResult={status:"success"|"blocked"|"failed";detail:string;replay?:boolean};
type IxcWriteCatalogEntry={operation:string;label:string;implemented:boolean};

/**
 * Escrita real no IXC (issue #20). Política, idempotência e auditoria
 * funcionam de ponta a ponta; o formato exato de uma resposta de sucesso
 * ainda não foi confirmado contra uma fatura real (o único cliente da
 * allowlist não tem nenhuma) — por isso o resultado mostra a resposta crua do
 * IXC em vez de um resumo formatado que poderia estar errado.
 */
function InvoiceReissuePanel(){
  const [catalog,setCatalog]=useState<IxcWriteCatalogEntry[]>([]);
  const [writeEnabled,setWriteEnabled]=useState<boolean|null>(null);
  const [invoiceId,setInvoiceId]=useState("");
  const [customerId,setCustomerId]=useState("");
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<IxcWriteResult|null>(null);
  const [error,setError]=useState<string|null>(null);

  useEffect(()=>{let active=true;
    fetch("/api/billing/invoices/reissue?period=30d").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:{catalog:IxcWriteCatalogEntry[];writeEnabled:boolean})=>{if(active){setCatalog(payload.catalog??[]);setWriteEnabled(payload.writeEnabled)}}).catch(()=>{});
    return()=>{active=false}},[]);

  async function submit(){
    setBusy(true);setError(null);setResult(null);
    const response=await fetch("/api/billing/invoices/reissue",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({invoiceId,customerId,idempotencyKey:`${customerId}:${invoiceId}:${Date.now()}`})});
    const payload=await response.json();
    if(response.ok)setResult(payload);else setError(payload.error??"Não foi possível processar.");
    setBusy(false);
  }

  return <section className="data-card" style={{marginTop:14}}>
    <div className="card-header"><strong>Escrita no IXC</strong><span className={`badge ${writeEnabled?"green":"amber"}`}>{writeEnabled===null?"consultando…":writeEnabled?"● ligada":"desligada"}</span></div>
    <div style={{padding:16,display:"grid",gap:12}}>
      <p style={{margin:0,fontSize:12,color:"var(--muted)",lineHeight:1.6}}>
        Catálogo de operações de escrita no ERP (issue #20). Só a segunda via de boleto está desenhada; as outras três seguem o mesmo padrão quando chegar a vez delas.
        O endpoint real (<code>get_boleto</code>) foi confirmado na documentação do provedor — o que ainda não foi confirmado é o formato de uma resposta de <strong>sucesso</strong>,
        porque não existe fatura real para testar. Por isso o resultado abaixo mostra a resposta crua do IXC, não um resumo.
      </p>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
        {catalog.map(item=><span key={item.operation} className="badge" style={{background:item.implemented?"var(--blue-soft)":"var(--surface-3)",color:item.implemented?"var(--blue)":"var(--text-3)"}}>{item.label}{item.implemented?"":" (não desenhado)"}</span>)}
      </div>
      <div style={{display:"grid",gap:10,maxWidth:420}}>
        <label className="field"><span>ID da fatura (IXC)</span><input placeholder="ex.: 4821" value={invoiceId} onChange={e=>setInvoiceId(e.target.value)}/></label>
        <label className="field"><span>ID do cliente (IXC)</span><input placeholder="ex.: 21857" value={customerId} onChange={e=>setCustomerId(e.target.value)}/></label>
        <button className="button secondary" disabled={busy||!invoiceId||!customerId} onClick={()=>void submit()}>{busy?"Verificando…":"Solicitar segunda via"}</button>
      </div>
      {error&&<p className="form-error">{error}</p>}
      {result&&<div className="state-card">
        <strong>{result.status==="success"?"Gerado":result.status==="blocked"?"Bloqueado":"Falhou"}</strong>{result.replay?" (mesma solicitação de antes, não repetida)":""}
        <p style={{margin:"6px 0 0",lineHeight:1.6,wordBreak:"break-all"}}>{result.detail}</p>
      </div>}
    </div>
  </section>;
}

const EMPTY_STEP:RuleStepInput={offsetDays:1,channel:"WhatsApp",templateId:"",attempts:1,active:false};

function RuleBuilder(){
  const [steps,setSteps]=useState<RuleStepInput[]>([]);
  const [name,setName]=useState("Régua padrão BBNET");
  const [meta,setMeta]=useState<{version:number;updatedAt:string;authorId:string}|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState<string|null>(null);

  useEffect(()=>{let active=true;
    fetch("/api/billing/rules").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:{available:boolean;rule:{name:string;version:number;updatedAt:string;authorId:string;steps:RuleStepInput[]}|null})=>{
        if(!active)return;
        if(payload.rule){setName(payload.rule.name);setSteps(payload.rule.steps);setMeta({version:payload.rule.version,updatedAt:payload.rule.updatedAt,authorId:payload.rule.authorId})}
        setState(payload.available?"ready":"error");
      }).catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[]);

  function update(index:number,patch:Partial<RuleStepInput>){setSteps(current=>current.map((step,i)=>i===index?{...step,...patch}:step));setMessage(null)}
  function remove(index:number){setSteps(current=>current.filter((_,i)=>i!==index));setMessage(null)}
  async function save(){
    setSaving(true);setMessage(null);
    const response=await fetch("/api/billing/rules",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,steps})});
    const payload=await response.json();
    if(response.ok){setMeta({version:payload.version,updatedAt:payload.updatedAt,authorId:payload.authorId});setSteps(payload.steps);setMessage(`Versão ${payload.version} salva.`)}
    else setMessage(payload.error??"Não foi possível salvar.");
    setSaving(false);
  }

  return <main className="content">
    <Heading title="Régua de cobrança" text="Define quando e por onde falar com quem está em atraso. Salvar não envia nada."/>
    {state==="loading"&&<div className="state-card">Carregando régua…</div>}
    {state==="error"&&<div className="state-card error">Régua indisponível: sem banco não há o que ler nem onde salvar.</div>}
    {state==="ready"&&<>
      <div className="rule-toolbar">
        <div><input value={name} onChange={e=>{setName(e.target.value);setMessage(null)}} style={{fontWeight:600,border:"none",background:"transparent",fontSize:14,width:"100%"}}/><span>{meta?`Versão ${meta.version} • ${meta.authorId} • ${new Date(meta.updatedAt).toLocaleString("pt-BR")}`:"Nenhuma versão salva ainda"}</span></div>
        <button className="button secondary" onClick={()=>{setSteps(c=>[...c,{...EMPTY_STEP}]);setMessage(null)}}>+ Adicionar etapa</button>
        <button className="button" disabled={saving||steps.length===0} onClick={()=>void save()}>{saving?"Salvando…":"Salvar nova versão"}</button>
      </div>
      {message&&<div className="state-card">{message}</div>}
      {steps.length===0
        ? <div className="state-card">Nenhuma etapa configurada. A régua começa vazia — nada de exemplo é pré-carregado.</div>
        : <section className="rule-timeline">{steps.map((step,index)=><article className={`rule-step ${step.active?"":"disabled"}`} key={index}>
            <div className="rule-index">{index+1}</div>
            <div style={{display:"grid",gap:6}}>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                <label style={{fontSize:11}}>Dias<input type="number" value={step.offsetDays} onChange={e=>update(index,{offsetDays:Number(e.target.value)})} style={{width:70,marginLeft:6}}/></label>
                <select value={step.channel} onChange={e=>update(index,{channel:e.target.value})}>{RULE_CHANNELS.map(channel=><option key={channel} value={channel}>{channel}</option>)}</select>
                <label style={{fontSize:11}}>Tentativas<input type="number" min={1} max={5} value={step.attempts} onChange={e=>update(index,{attempts:Number(e.target.value)})} style={{width:56,marginLeft:6}}/></label>
              </div>
              <input placeholder="Identificador do template" value={step.templateId} onChange={e=>update(index,{templateId:e.target.value})}/>
              <small>{offsetLabel(step.offsetDays)}</small>
            </div>
            <div style={{display:"grid",gap:6}}>
              <button onClick={()=>update(index,{active:!step.active})}>{step.active?"Ativa":"Inativa"}</button>
              <button onClick={()=>remove(index)}>Remover</button>
            </div>
          </article>)}</section>}
      <DispatchPanel hasRule={steps.length>0}/>
    </>}
  </main>;
}

type DispatchPreview={available:boolean;detail?:string;period:string;scope?:"allowlist"|"unavailable";today:{scheduledFor:string;candidates:number}|null;indicators:{total:number;byStep:Record<string,number>}|null};
type DispatchRun={scheduledFor:string;businessHour:boolean;candidates:number;recorded:number;duplicates:number;enqueued:number;queueEnabled:boolean};

/**
 * Disparo real (issue #15), no limite do que existe hoje: calcula quem
 * receberia contato agora, revalidando pagamento, sem duplicar — e registra
 * isso no ledger mesmo que a fila de envio esteja desligada. É o mesmo espírito
 * do modo observação do canal de entrada, só que para a saída.
 */
function DispatchPanel({hasRule}:{hasRule:boolean}){
  const [preview,setPreview]=useState<DispatchPreview|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  const [running,setRunning]=useState(false);
  const [result,setResult]=useState<DispatchRun|null>(null);
  const [runError,setRunError]=useState<string|null>(null);

  useEffect(()=>{let active=true;
    fetch("/api/billing/collections/dispatch?period=30d").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:DispatchPreview)=>{if(active){setPreview(payload);setState("ready")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[]);

  async function run(){
    setRunning(true);setRunError(null);
    const response=await fetch("/api/billing/collections/dispatch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"run"})});
    const payload=await response.json();
    if(response.ok)setResult(payload);else setRunError(payload.error??"Não foi possível rodar o disparo.");
    setRunning(false);
  }

  if(!hasRule)return null;
  return <section className="data-card" style={{marginTop:14}}>
    <div className="card-header"><strong>Disparo real</strong><span className="badge blue">Fica auditado</span></div>
    {state==="loading"&&<p className="card-empty">Consultando faturas no IXC…</p>}
    {state==="error"&&<p className="card-empty">Não foi possível consultar o disparo.</p>}
    {state==="ready"&&preview&&!preview.available&&<p className="card-empty">{preview.detail}.</p>}
    {state==="ready"&&preview?.available&&<div style={{padding:"14px 18px",display:"grid",gap:12}}>
      <p style={{margin:0,color:"var(--muted)",fontSize:12,lineHeight:1.6}}>
        Hoje ({preview.today?.scheduledFor}), <strong>{preview.today?.candidates??0}</strong> fatura(s) casam com alguma etapa ativa da régua,
        revalidando pagamento na hora — quem já pagou não entra. Nos últimos {preview.period}, {preview.indicators?.total??0} disparo(s) foram registrados no ledger.
      </p>
      <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
        <button className="button" disabled={running} onClick={()=>void run()}>{running?"Rodando…":"Rodar disparo de hoje"}</button>
        <a className="button secondary" href="/api/billing/collections/dispatch?format=csv" download>Exportar CSV</a>
      </div>
      {runError&&<p className="form-error">{runError}</p>}
      {result&&<div className="state-card">
        {result.businessHour
          ? <>Rodado: {result.candidates} candidato(s), <strong>{result.recorded}</strong> novo(s) registrado(s){result.duplicates>0?`, ${result.duplicates} já tinha(m) sido registrado(s) hoje`:""}.
              {result.queueEnabled?` ${result.enqueued} enfileirado(s) para envio.`:" A fila de envio está desligada (FEATURE_QUEUES) — ficou registrado, mas nada foi enfileirado."}</>
          : <>Fora do horário comercial: {result.candidates} candidato(s) seriam contatados, mas nada foi registrado. Rode novamente entre 8h e 20h, dia de semana.</>}
      </div>}
      <p style={{margin:0,color:"var(--text-3)",fontSize:11}}>
        Sem ponte de envio ligada ao WhatsApp, o registro aqui prova a decisão — não a entrega. Quando o worker de fila mandar a mensagem de verdade, ele consome do que fica enfileirado aqui.
      </p>
    </div>}
  </section>;
}

function Campaigns(){
  return <main className="content">
    <Heading title="Campanhas de cobrança" text="Disparo em massa para clientes em atraso."/>
    <div className="state-card error"><strong>Campanhas não estão ligadas — e não há campanha nenhuma para mostrar.</strong>
      <p style={{marginTop:8,lineHeight:1.7}}>Esta tela simulava criar campanha e enfileirar job, com público inventado. Foi removido: enfileirar uma campanha de verdade manda mensagem para cliente de verdade, e isso não pode ser demonstrado como se fosse real.</p>
    </div>
    <section className="data-card" style={{marginTop:14}}>
      <div className="card-header"><strong>O que falta antes de ligar</strong></div>
      <div style={{padding:"4px 0"}}>
        {[
          ["Login obrigatório (FEATURE_AUTH)","Hoje nenhuma rota sabe quem disparou a campanha."],
          ["Opt-out respeitado","Não existe registro de quem pediu para não ser contatado."],
          ["Idempotência no disparo","Sem isso, um retry cobra o mesmo cliente duas vezes."],
          ["Auditoria por destinatário","Precisa registrar o que foi enviado, para quem e por qual etapa da régua."],
          ["Janela de envio","Cobrança fora de horário permitido é problema jurídico, não de produto."],
        ].map(([title,why])=><div className="aging-row" key={title}><div><strong>{title}</strong><span>{why}</span></div></div>)}
      </div>
    </section>
    <div className="state-card" style={{marginTop:14}}>A régua de cobrança já pode ser configurada e versionada — ela define as etapas, sem disparar nada.</div>
  </main>;
}

function BillingReports(){
  const [period,setPeriod]=useState("30d");
  const {data,state,setState}=useBilling(period);
  const summary=data?.summary;
  return <main className="content">
    <Heading title="Relatórios de cobrança" text="Faturas e pagamentos reais no período. Entrega e leitura dependem de campanha, que não existe."/>
    <section className="filter-bar"><select value={period} onChange={e=>{setState("loading");setPeriod(e.target.value)}}>{PERIODS.map(([v,l])=><option key={v} value={v}>Últimos {l}</option>)}</select></section>
    {state==="loading"&&<div className="state-card">Consultando o IXC…</div>}
    {state==="error"&&<div className="state-card error">Não foi possível gerar o relatório.</div>}
    {state==="ready"&&data&&!data.available&&<div className="state-card error">{data.detail}.</div>}
    {state==="ready"&&summary&&<>
      <ScopeNote summary={summary} allowlistSize={data?.allowlistSize}/>
      <section className="metrics">
        {isFullBase(summary)?<>
          <Metric label="Faturas em aberto" value={summary.openInvoices.toLocaleString("pt-BR")} detail="Contagem exata do IXC"/>
          <Metric label="Vencidas" value={summary.overdueInvoices.toLocaleString("pt-BR")} detail={money(summary.overdueValue)+(summary.truncated?" (parcial)":"")}/>
          <Metric label="Faturas lidas" value={summary.overdueScanned.toLocaleString("pt-BR")} detail="Base da soma acima"/>
          <Metric label="Pagamentos recebidos" value="—" detail="Exigiria varrer a base; ver ressalva abaixo"/>
        </>:<>
          <Metric label="Pagamentos recebidos" value={String(summary.paymentsInPeriod)} detail={money(summary.paidInPeriod)}/>
          <Metric label="Faturas em aberto" value={String(summary.openInvoices)} detail={money(summary.openValue)}/>
          <Metric label="Vencidas" value={String(summary.overdueInvoices)} detail={money(summary.overdueValue)}/>
          <Metric label="Cadastros consultados" value={String(summary.customersConsulted)} detail={summary.customersUnavailable?`${summary.customersUnavailable} indisponível(is)`:"Todos responderam"}/>
        </>}
      </section>
      <section className="data-card" style={{marginTop:14}}><div className="card-header"><strong>Não está aqui, e por quê</strong></div>
        <div style={{padding:"4px 0"}}>
          {[
            ["Entregues, lidos e promessas","São métricas de disparo de campanha. Nenhuma campanha foi executada."],
            ["Receita recuperada por campanha","Sem campanha não há o que atribuir; somar pagamento espontâneo aqui seria mentira."],
            ["Contatos elegíveis","Depende do registro de opt-out, que ainda não existe."],
          ].map(([title,why])=><div className="aging-row" key={title}><div><strong>{title}</strong><span>{why}</span></div></div>)}
        </div>
      </section>
    </>}
  </main>;
}

function Heading({title,text}:{title:string;text:string}){return <div className="page-heading"><div><h1>{title}</h1><p>{text}</p></div></div>}
function Metric({label,value,detail}:{label:string;value:string;detail:string}){return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">$</span></div><strong>{value}</strong><small>{detail}</small></article>}
