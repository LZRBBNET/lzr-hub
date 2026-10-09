"use client";
import { useEffect, useState } from "react";
import { RULE_CHANNELS, type RuleStepInput } from "@/lib/platform/collection-rules-shared";
import { Icon, type IconKey } from "@/components/ui/icons";
import { Badge, Bar, Card, Empty, Limits, Loading, Notice, PERIODS_SHORT, Segmented, Stat, Stats, Toolbar, count, money, useToast } from "@/components/ui/kit";

/**
 * Cobrança. "Visão geral" e "Relatórios" eram duas telas lendo o mesmo
 * `/api/billing/overview` com os cartões em outra ordem — viraram uma só. As
 * três operações de escrita (segunda via, renegociação, promessa) saíram de
 * baixo dos gráficos e ganharam aba própria: quem vai renegociar não precisa
 * rolar por indicador, e quem lê indicador não tropeça em formulário de ERP.
 */
export function BillingModule({view}:{view:"cobranca"|"acoes-cobranca"|"regua"}){
  if(view==="regua")return <RuleBuilder/>;
  if(view==="acoes-cobranca")return <BillingActions/>;
  return <BillingOverview/>;
}

type AgingBucket={label:string;minDays:number;maxDays:number|null;invoices:number;value:number};
type BillingSummary={scope:string;customersConsulted:number;customersUnavailable:number;openInvoices:number;openValue:number;overdueInvoices:number;overdueValue:number;upcomingInvoices:number;upcomingValue:number;aging:AgingBucket[];paymentsInPeriod:number;paidInPeriod:number;paymentMethods:Record<string,number>;invoicesWithoutDueDate:number};
type FullBaseSummary={scope:"full-base";openInvoices:number;openValue:null;overdueInvoices:number;overdueValue:number;overdueScanned:number;truncated:boolean;aging:AgingBucket[];invoicesWithoutDueDate:number};
type BillingPayload={available:boolean;detail?:string;period:string;scope?:"allowlist"|"full-base";allowlistSize?:number;summary:BillingSummary|FullBaseSummary|null};
const isFullBase=(summary:BillingSummary|FullBaseSummary|null):summary is FullBaseSummary=>summary?.scope==="full-base";

/** A régua escrevia "1 dias depois do vencimento". Um dia é um dia. */
const offsetLabel=(days:number)=>{
  if(days===0)return "No vencimento";
  const n=Math.abs(days), palavra=n===1?"dia":"dias";
  return days<0?`${n} ${palavra} antes do vencimento`:`${n} ${palavra} depois do vencimento`;
};
const PERIOD_NAMES:Record<string,string>={"24h":"24 horas","7d":"7 dias","30d":"30 dias"};

function BillingOverview(){
  const [period,setPeriod]=useState<"24h"|"7d"|"30d">("30d");
  const [data,setData]=useState<BillingPayload|null>(null);
  const [loadedFor,setLoadedFor]=useState<string|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{let active=true;
    fetch(`/api/billing/overview?period=${period}`).then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:BillingPayload)=>{if(active){setData(payload);setFailed(false);setLoadedFor(period)}})
      .catch(()=>{if(active){setFailed(true);setLoadedFor(period)}});
    return()=>{active=false}},[period]);
  const summary=data?.summary;
  const loading=loadedFor!==period;

  return <>
    {/* Na base inteira não há pagamentos por período (ver Limits): o seletor não mudaria nada na tela. */}
    {!(summary&&isFullBase(summary))&&<Toolbar><span className="muted small">Pagamentos recebidos nos últimos</span><Segmented label="Período" value={period} options={PERIODS_SHORT} onChange={setPeriod}/></Toolbar>}
    {loading&&<Loading stats={4} rows={4}/>}
    {!loading&&failed&&<Notice tone="bad">Não foi possível consultar a posição financeira.</Notice>}
    {!loading&&!failed&&data&&!data.available&&<Notice tone="bad" more="Zero aqui seria lido como “ninguém deve nada”.">{data.detail}. Nenhum número é exibido.</Notice>}
    {!loading&&!failed&&summary&&<>
      {isFullBase(summary)
        ? summary.truncated && <Notice tone="warn">A varredura das vencidas parou antes do fim ({count(summary.overdueScanned)} lidas): o valor vencido é parcial.</Notice>
        : <Notice tone="warn" more={`É trava nossa, de homologação.${summary.customersUnavailable>0?` ${summary.customersUnavailable} cadastro(s) não responderam e ficaram de fora da conta.`:""}`}>Recorte da allowlist: {summary.customersConsulted} cadastro(s){data?.allowlistSize&&data.allowlistSize!==summary.customersConsulted?` de ${data.allowlistSize}`:""}. <strong>Não é a carteira inteira.</strong></Notice>}
      <Stats>
        <Stat label="Vencido" icon="alert" tone={summary.overdueInvoices?"warn":"neutral"} value={money(summary.overdueValue)} hint={isFullBase(summary)&&summary.truncated?`Parcial: ${count(summary.overdueScanned)} de ${count(summary.overdueInvoices)} faturas`:`${count(summary.overdueInvoices)} fatura(s) em atraso`}/>
        {isFullBase(summary)
          ? <Stat label="Faturas em aberto" icon="wallet" value={count(summary.openInvoices)} hint="Contagem exata do IXC"/>
          : <Stat label="A vencer" icon="clock" value={money(summary.upcomingValue)} hint={`${summary.upcomingInvoices} fatura(s) no prazo`}/>}
        {isFullBase(summary)
          ? <Stat label="Ticket médio das vencidas" icon="wallet" value={summary.overdueScanned?money(summary.overdueValue/summary.overdueScanned):"—"} hint="Sobre as faturas lidas"/>
          : <Stat label={`Recebido em ${PERIOD_NAMES[period]}`} icon="check" tone="ok" value={money(summary.paidInPeriod)} hint={`${summary.paymentsInPeriod} pagamento(s)`}/>}
        {!isFullBase(summary)&&<Stat label="Total em aberto" icon="wallet" value={money(summary.openValue)} hint={`${summary.openInvoices} fatura(s)`}/>}
      </Stats>
      <div className={isFullBase(summary)?"":"grid-2 even"}>
        <Card title="Faixa de atraso" badge={<Badge>pela data de vencimento</Badge>}>
          {summary.overdueInvoices===0
            ? <Empty icon="check" title="Nenhuma fatura vencida">entre os cadastros consultados.</Empty>
            : <div className="bars">{summary.aging.map(bucket=><Bar key={bucket.label} label={bucket.label} detail={`${count(bucket.invoices)} fatura(s)`} value={bucket.invoices} max={Math.max(...summary.aging.map(b=>b.invoices))} display={money(bucket.value)}/>)}</div>}
          {summary.invoicesWithoutDueDate>0&&<p className="hint" style={{marginTop:12}}>{summary.invoicesWithoutDueDate} fatura(s) sem data de vencimento legível ficaram fora das faixas, em vez de serem chutadas para uma.</p>}
        </Card>
        {!isFullBase(summary)&&<Card title="Como pagaram" badge={<Badge>últimos {PERIOD_NAMES[period]}</Badge>}>
          {summary.paymentsInPeriod===0
            ? <Empty icon="wallet" title="Nenhum pagamento no período"/>
            : <div className="bars">{Object.entries(summary.paymentMethods).sort((a,b)=>b[1]-a[1]).map(([method,total])=><Bar key={method} label={method} detail={`${total} pagamento(s)`} value={total} max={summary.paymentsInPeriod} display={`${Math.round(total/summary.paymentsInPeriod*100)}%`}/>)}</div>}
        </Card>}
      </div>
      <Limits items={isFullBase(summary)?[
        ["Valor total em aberto","São ~74 mil faturas. O IXC devolve a contagem numa consulta, mas não soma valores — só varrendo tudo, o que não cabe numa abertura de tela. Cabe num job noturno."],
        ["Pagamentos do período","A tabela de pagamentos se liga à fatura, não ao cliente. Cruzar isso na base inteira tem o mesmo problema de varredura."],
        ["Recuperação por campanha","Nenhuma campanha foi executada; não há o que atribuir."],
      ]:[
        ["Recuperação por campanha","Conversão e ROI dependem de campanha executada — e campanha não está ligada. Sem isso, qualquer número seria invenção."],
        ["Entregues, lidos e contatos elegíveis","Métricas de disparo de campanha e de opt-out, que ainda não existem."],
      ]}/>
    </>}
  </>;
}

/* ------------------------------------------------------------- ações no IXC --- */

type Tool="reissue"|"renegotiation"|"promise";
const TOOLS:Array<[Tool,IconKey,string,string]>=[
  ["reissue","ticket","Segunda via","Gera o boleto de novo no IXC"],
  ["renegotiation","refresh","Renegociar dívida","Junta faturas em atraso num acordo"],
  ["promise","clock","Promessa de pagamento","Registra e confere a data prometida"],
];

function BillingActions(){
  const [tool,setTool]=useState<Tool>("reissue");
  return <>
    <div className="tool-switch" role="tablist" aria-label="Operação">
      {TOOLS.map(([id,icon,title,text])=><button key={id} type="button" role="tab" aria-selected={tool===id} className={`tool-card ${tool===id?"active":""}`} onClick={()=>setTool(id)}>
        <Icon name={icon} size={18}/><span><strong>{title}</strong><span>{text}</span></span>
      </button>)}
    </div>
    {tool==="reissue"&&<InvoiceReissuePanel/>}
    {tool==="renegotiation"&&<RenegotiationPanel/>}
    {tool==="promise"&&<PaymentPromisePanel/>}
  </>;
}

type PaymentPromiseRow={id:string;invoiceId:string;customerId:string;promisedFor:string;status:"pending"|"fulfilled"|"broken"};
const PROMISE_STATUS:Record<string,[string,string]>={pending:["Pendente","warn"],fulfilled:["Cumprida","ok"],broken:["Quebrada — recontatar","bad"]};

/**
 * Promessa de pagamento (issue #16). Registrada só no HUB. "Revisar" confere
 * contra o IXC de verdade; "quebrada" nunca dispara mensagem nenhuma, só
 * sinaliza quem precisa de recontato manual.
 */
function PaymentPromisePanel(){
  const [pending,setPending]=useState<PaymentPromiseRow[]>([]);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  const [form,setForm]=useState({invoiceId:"",customerId:"",promisedFor:""});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [reviewResult,setReviewResult]=useState<{fulfilled:string[];broken:string[];stillPending:string[]}|null>(null);
  const [nonce,setNonce]=useState(0);
  const toast=useToast();

  useEffect(()=>{let active=true;
    fetch("/api/billing/promises?period=30d").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:{available:boolean;pending:PaymentPromiseRow[]})=>{if(active){setPending(payload.pending??[]);setState(payload.available?"ready":"error")}})
      .catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[nonce]);

  async function submit(){
    setBusy(true);setError(null);
    const response=await fetch("/api/billing/promises",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"create",...form})});
    const payload=await response.json();
    if(response.ok){setForm({invoiceId:"",customerId:"",promisedFor:""});setNonce(n=>n+1);toast("Promessa registrada.")}
    else setError(payload.error??"Não foi possível registrar.");
    setBusy(false);
  }

  async function review(){
    setBusy(true);setError(null);setReviewResult(null);
    const response=await fetch("/api/billing/promises",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"review"})});
    const payload=await response.json();
    if(response.ok){setReviewResult(payload);setNonce(n=>n+1)}
    else setError(payload.error??"Não foi possível revisar.");
    setBusy(false);
  }

  return <div className="grid-2">
    <Card title="Promessas pendentes" badge={state==="ready"&&<Badge>{pending.length}</Badge>}
      actions={<button className="button secondary small" disabled={busy} onClick={()=>void review()}><Icon name="refresh" size={14}/>Conferir no IXC</button>} flush>
      {reviewResult&&<div className="card-content"><Notice tone={reviewResult.broken.length?"warn":"ok"}>{reviewResult.fulfilled.length} cumprida(s), <strong>{reviewResult.broken.length} quebrada(s)</strong> — essas precisam de recontato manual —, {reviewResult.stillPending.length} ainda pendente(s).</Notice></div>}
      {state==="loading"&&<Loading rows={3}/>}
      {state==="error"&&<div className="card-content"><Notice tone="bad">Promessas indisponíveis.</Notice></div>}
      {state==="ready"&&pending.length===0&&<Empty icon="check" title="Nenhuma promessa pendente"/>}
      {state==="ready"&&<div className="list">{pending.map(p=><div className="row" key={p.id}>
        <div className="row-main"><strong>Fatura {p.invoiceId}</strong><span>Cliente {p.customerId} · promete pagar em {new Date(p.promisedFor+"T00:00:00Z").toLocaleDateString("pt-BR")}</span></div>
        <div className="row-value"><span className={`status ${PROMISE_STATUS[p.status]?.[1]??""}`}>{PROMISE_STATUS[p.status]?.[0]??p.status}</span></div>
      </div>)}</div>}
    </Card>
    <Card title="Registrar promessa">
      <div className="form-grid">
        <label className="field"><span>Fatura (IXC)</span><input placeholder="ex.: 4821" value={form.invoiceId} onChange={e=>setForm(f=>({...f,invoiceId:e.target.value}))}/></label>
        <label className="field"><span>Cliente (IXC)</span><input placeholder="ex.: 21857" value={form.customerId} onChange={e=>setForm(f=>({...f,customerId:e.target.value}))}/></label>
        <label className="field span-2"><span>Promete pagar em</span><input type="date" value={form.promisedFor} onChange={e=>setForm(f=>({...f,promisedFor:e.target.value}))}/></label>
        {error&&<p className="form-error span-2">{error}</p>}
        <div className="form-actions span-2"><button className="button" disabled={busy||!form.invoiceId||!form.customerId||!form.promisedFor} onClick={()=>void submit()}>{busy?"Enviando…":"Registrar promessa"}</button></div>
        <p className="field-hint span-2">Fica só no LZR HUB e na auditoria. Promessa quebrada não dispara mensagem: só aparece aqui para recontato.</p>
      </div>
    </Card>
  </div>;
}

type IxcWriteResult={status:"success"|"blocked"|"failed";detail:string;replay?:boolean};

/**
 * Segunda via (issue #20). O formato exato de uma resposta de sucesso ainda
 * não foi confirmado contra uma fatura real — por isso o resultado mostra a
 * resposta crua do IXC em vez de um resumo que poderia estar errado.
 */
function InvoiceReissuePanel(){
  const [writeEnabled,setWriteEnabled]=useState<boolean|null>(null);
  const [invoiceId,setInvoiceId]=useState("");
  const [customerId,setCustomerId]=useState("");
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<IxcWriteResult|null>(null);
  const [error,setError]=useState<string|null>(null);

  useEffect(()=>{let active=true;
    fetch("/api/billing/invoices/reissue?period=30d").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:{writeEnabled:boolean})=>{if(active)setWriteEnabled(payload.writeEnabled)}).catch(()=>{});
    return()=>{active=false}},[]);

  async function submit(){
    setBusy(true);setError(null);setResult(null);
    const response=await fetch("/api/billing/invoices/reissue",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({invoiceId,customerId,idempotencyKey:`${customerId}:${invoiceId}:${Date.now()}`})});
    const payload=await response.json();
    if(response.ok)setResult(payload);else setError(payload.error??"Não foi possível processar.");
    setBusy(false);
  }

  return <Card title="Segunda via de boleto" badge={<WriteBadge enabled={writeEnabled}/>}>
    <div className="form-grid" style={{maxWidth:560}}>
      <label className="field"><span>Fatura (IXC)</span><input placeholder="ex.: 4821" value={invoiceId} onChange={e=>setInvoiceId(e.target.value)}/></label>
      <label className="field"><span>Cliente (IXC)</span><input placeholder="ex.: 21857" value={customerId} onChange={e=>setCustomerId(e.target.value)}/></label>
      <div className="form-actions span-2"><button className="button" disabled={busy||!invoiceId||!customerId} onClick={()=>void submit()}>{busy?"Verificando…":"Solicitar segunda via"}</button></div>
      {error&&<p className="form-error span-2">{error}</p>}
      {result&&<div className={`result-box span-2 ${result.status==="success"?"ok":"bad"}`}>
        <strong>{result.status==="success"?"Gerado":result.status==="blocked"?"Bloqueado":"Falhou"}</strong>{result.replay?" (mesma solicitação de antes, não repetida)":""}
        <p className="break">{result.detail}</p>
      </div>}
      <p className="field-hint span-2">O resultado mostra a resposta crua do IXC: o formato de sucesso ainda não foi confirmado numa fatura real, e um resumo formatado poderia estar errado.</p>
    </div>
  </Card>;
}

function WriteBadge({enabled}:{enabled:boolean|null|undefined}){
  if(enabled===null||enabled===undefined)return <Badge>consultando…</Badge>;
  return enabled?<Badge tone="ok" dot>escrita ligada</Badge>:<Badge tone="warn">escrita desligada</Badge>;
}

type RenegotiationData={available:boolean;detail?:string;invoices:{id:string;dueAt:string|null;value:number}[];wallets:{id:string;name:string}[];paymentTerms:{id:string;name:string;installments?:number}[];customer?:{id:string;name:string;hasAccount:boolean;hasBranch:boolean};contractId?:string|null;writeEnabled?:boolean};

/**
 * Renegociação de dívida (issue #20, operação `negotiation.register`).
 *
 * 1. O total exibido é reenviado ao servidor, que o compara com o que o IXC
 *    devolve naquele instante. Tela com dado velho não renegocia.
 * 2. O aviso de que o passo 1 já grava no ERP fica visível **antes** do botão,
 *    porque falhar no meio deixa renegociação pela metade nas faturas do cliente.
 * 3. Não há campo de desconto. Conceder desconto é decisão que o projeto se
 *    recusa a automatizar — quem precisa fazer isso faz no IXC, com nome e rosto.
 */
/** Fora do componente: gerar a chave é efeito, e dentro do corpo o compilador o trata como impureza em render. */
const renegotiationKey=(customer:string,ids:string[])=>`reneg-${customer}-${[...ids].sort().join("_")}-${Date.now()}`;

function RenegotiationPanel(){
  const [customerId,setCustomerId]=useState("");
  const [query,setQuery]=useState("");
  const [data,setData]=useState<RenegotiationData|null>(null);
  // Carregando é derivado, não estado próprio: marcar loading dentro do efeito
  // seria setState síncrono ali, o que dispara renderização em cascata.
  const [loadedQuery,setLoadedQuery]=useState<string|null>(null);
  const [selected,setSelected]=useState<string[]>([]);
  const [walletId,setWalletId]=useState("");
  const [termId,setTermId]=useState("");
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<IxcWriteResult|null>(null);
  const [error,setError]=useState<string|null>(null);

  useEffect(()=>{let active=true;
    fetch(`/api/billing/renegotiations${query?`?customerId=${encodeURIComponent(query)}`:""}`)
      .then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:RenegotiationData)=>{if(active){setData(payload);setLoadedQuery(query)}})
      .catch(()=>{if(active){setData({available:false,detail:"Não foi possível consultar o IXC",invoices:[],wallets:[],paymentTerms:[]});setLoadedQuery(query)}});
    return()=>{active=false}},[query]);
  const loading=loadedQuery!==query;

  const total=(data?.invoices??[]).filter(i=>selected.includes(i.id)).reduce((sum,i)=>sum+i.value,0);
  const blocked=data?.customer&&(!data.customer.hasAccount||!data.customer.hasBranch||!data.contractId);

  async function submit(){
    setBusy(true);setError(null);setResult(null);
    try{
      const response=await fetch("/api/billing/renegotiations",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({customerId:query,invoiceIds:selected,walletId,paymentTermId:termId,expectedTotal:total,
          idempotencyKey:renegotiationKey(query,selected)})});
      const payload=await response.json();
      if(response.ok)setResult(payload);else setError(payload.error??"Não foi possível renegociar.");
    }catch{setError("O IXC não respondeu.")}
    finally{setBusy(false)}
  }

  return <Card title="Renegociar dívida no IXC" badge={<WriteBadge enabled={data?.writeEnabled}/>}>
    <div className="stack" style={{maxWidth:640}}>
      <Notice tone="warn" title="Isto altera o financeiro do cliente."
        more="O IXC cria a renegociação já no primeiro passo, antes de calcular juro e multa. Se a sequência falhar no meio, fica um registro pela metade preso às faturas — e o ledger mostra o número dele para conferência manual.">Não há campo de desconto: isso não se automatiza.</Notice>
      <form className="form-actions" onSubmit={e=>{e.preventDefault();if(customerId.trim()){setQuery(customerId.trim());setSelected([]);setResult(null);setError(null)}}}>
        <label className="field" style={{width:220}}><span>Código do cliente no IXC</span><input value={customerId} placeholder="ex.: 21857" onChange={e=>setCustomerId(e.target.value)}/></label>
        <button type="submit" className="button secondary" style={{alignSelf:"flex-end"}} disabled={!customerId.trim()||loading}>{loading?"Consultando…":"Buscar faturas"}</button>
      </form>

      {data&&!data.available&&<p className="form-error">{data.detail}.</p>}
      {data?.available&&query&&<>
        {blocked&&<p className="form-error">Este cadastro não pode ser renegociado: {[!data.customer?.hasBranch&&"não tem filial",!data.customer?.hasAccount&&"não tem conta (id_conta)",!data.contractId&&"não tem contrato"].filter(Boolean).join(", ")}.</p>}
        {data.invoices.length===0
          ? <p className="muted">Nenhuma fatura em aberto neste cadastro.</p>
          : <>
              <fieldset className="checks">
                <legend>Faturas em aberto de {data.customer?.name}</legend>
                {data.invoices.map(invoice=><label key={invoice.id}>
                  <input type="checkbox" checked={selected.includes(invoice.id)} onChange={()=>setSelected(current=>current.includes(invoice.id)?current.filter(id=>id!==invoice.id):[...current,invoice.id])}/>
                  <span>Fatura {invoice.id} · vence {invoice.dueAt??"—"} · <strong>{money(invoice.value)}</strong></span>
                </label>)}
              </fieldset>
              <div className="form-grid">
                <label className="field"><span>Carteira de cobrança <small className="muted">(define juro e multa)</small></span>
                  <select value={walletId} onChange={e=>setWalletId(e.target.value)}><option value="">Escolha…</option>{data.wallets.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
                <label className="field"><span>Condição de pagamento <small className="muted">(parcelamento)</small></span>
                  <select value={termId} onChange={e=>setTermId(e.target.value)}><option value="">Escolha…</option>{data.paymentTerms.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
              </div>
              <div className="form-actions">
                <button className="button" disabled={busy||!!blocked||selected.length===0||!walletId||!termId} onClick={()=>void submit()}>{busy?"Renegociando…":`Renegociar ${selected.length} fatura(s)`}</button>
                <span className="muted small">Total escolhido: <strong className="text-ink">{money(total)}</strong> — juro e multa quem calcula é o IXC.</span>
              </div>
            </>}
      </>}

      {error&&<p className="form-error">{error}</p>}
      {result&&<div className={`result-box ${result.status==="success"?"ok":"bad"}`}>
        <strong>{result.status==="success"?"Renegociação concluída no IXC":result.status==="blocked"?"Bloqueado":"Falhou"}</strong>{result.replay?" (mesma solicitação de antes, não repetida)":""}
        <p>{result.detail}</p>
      </div>}
    </div>
  </Card>;
}

/* -------------------------------------------------------------------- régua --- */

const EMPTY_STEP:RuleStepInput={offsetDays:1,channel:"WhatsApp",templateId:"",attempts:1,active:false};

function RuleBuilder(){
  const [steps,setSteps]=useState<RuleStepInput[]>([]);
  const [name,setName]=useState("Régua padrão BBNET");
  const [meta,setMeta]=useState<{version:number;updatedAt:string;authorId:string}|null>(null);
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  const [saving,setSaving]=useState(false);
  const [dirty,setDirty]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const toast=useToast();

  useEffect(()=>{let active=true;
    fetch("/api/billing/rules").then(r=>r.ok?r.json():Promise.reject(new Error("falhou")))
      .then((payload:{available:boolean;rule:{name:string;version:number;updatedAt:string;authorId:string;steps:RuleStepInput[]}|null})=>{
        if(!active)return;
        if(payload.rule){setName(payload.rule.name);setSteps(payload.rule.steps);setMeta({version:payload.rule.version,updatedAt:payload.rule.updatedAt,authorId:payload.rule.authorId})}
        setState(payload.available?"ready":"error");
      }).catch(()=>{if(active)setState("error")});
    return()=>{active=false}},[]);

  function update(index:number,patch:Partial<RuleStepInput>){setSteps(current=>current.map((step,i)=>i===index?{...step,...patch}:step));setDirty(true);setError(null)}
  function remove(index:number){setSteps(current=>current.filter((_,i)=>i!==index));setDirty(true);setError(null)}
  async function save(){
    setSaving(true);setError(null);
    const response=await fetch("/api/billing/rules",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,steps})});
    const payload=await response.json();
    if(response.ok){setMeta({version:payload.version,updatedAt:payload.updatedAt,authorId:payload.authorId});setSteps(payload.steps);setDirty(false);toast(`Versão ${payload.version} salva.`)}
    else setError(payload.error??"Não foi possível salvar.");
    setSaving(false);
  }

  if(state==="loading")return <Loading rows={4}/>;
  if(state==="error")return <Notice tone="bad">Régua indisponível: sem banco não há o que ler nem onde salvar.</Notice>;
  return <>
    <Toolbar actions={<>
      <button className="button secondary" onClick={()=>{setSteps(c=>[...c,{...EMPTY_STEP}]);setDirty(true)}}><Icon name="plus" size={16}/>Adicionar etapa</button>
      <button className="button" disabled={saving||steps.length===0||!dirty} onClick={()=>void save()}>{saving?"Salvando…":"Salvar nova versão"}</button>
    </>}>
      <div className="rule-name">
        <input value={name} aria-label="Nome da régua" onChange={e=>{setName(e.target.value);setDirty(true)}}/>
        <span>{meta?`Versão ${meta.version} · ${meta.authorId} · ${new Date(meta.updatedAt).toLocaleString("pt-BR")}`:"Nenhuma versão salva ainda"}{dirty?" · alterações não salvas":""}</span>
      </div>
    </Toolbar>
    {error&&<Notice tone="bad">{error}</Notice>}
    <Notice tone="neutral">Salvar a régua não envia nada a ninguém: ela define as etapas. O disparo é o passo abaixo.</Notice>
    <Card flush>
      {steps.length===0
        ? <Empty icon="clock" title="Nenhuma etapa configurada" action={<button className="button secondary" onClick={()=>{setSteps([{...EMPTY_STEP}]);setDirty(true)}}>Adicionar a primeira etapa</button>}>A régua começa vazia — nada de exemplo é pré-carregado.</Empty>
        : <ol className="rule-steps">{steps.map((step,index)=><li className={`rule-step ${step.active?"":"disabled"}`} key={index}>
            <div className="rule-index">{index+1}</div>
            <div>
              <div className="rule-fields">
                <label className="field"><span>Dias</span><input type="number" value={step.offsetDays} onChange={e=>update(index,{offsetDays:Number(e.target.value)})}/></label>
                <label className="field"><span>Canal</span><select value={step.channel} onChange={e=>update(index,{channel:e.target.value})}>{RULE_CHANNELS.map(channel=><option key={channel} value={channel}>{channel}</option>)}</select></label>
                <label className="field"><span>Tentativas</span><input type="number" min={1} max={5} value={step.attempts} onChange={e=>update(index,{attempts:Number(e.target.value)})}/></label>
                <label className="field"><span>Template</span><input placeholder="Identificador do template" value={step.templateId} onChange={e=>update(index,{templateId:e.target.value})}/></label>
              </div>
              <small>{offsetLabel(step.offsetDays)}</small>
            </div>
            <div className="rule-step-actions">
              <button type="button" role="switch" className="switch" aria-checked={step.active} aria-label={step.active?"Etapa ativa — desativar":"Etapa inativa — ativar"} onClick={()=>update(index,{active:!step.active})}/>
              <button type="button" className="icon-button" aria-label={`Remover etapa ${index+1}`} onClick={()=>remove(index)}><Icon name="x" size={16}/></button>
            </div>
          </li>)}</ol>}
    </Card>
    <DispatchPanel hasRule={steps.length>0}/>
  </>;
}

type DispatchPreview={available:boolean;detail?:string;period:string;scope?:"allowlist"|"unavailable";today:{scheduledFor:string;candidates:number}|null;indicators:{total:number;byStep:Record<string,number>}|null};
type DispatchRun={scheduledFor:string;businessHour:boolean;candidates:number;recorded:number;duplicates:number;enqueued:number;queueEnabled:boolean};

/**
 * Disparo real (issue #15), no limite do que existe hoje: calcula quem
 * receberia contato agora, revalidando pagamento, sem duplicar — e registra
 * isso no ledger mesmo que a fila de envio esteja desligada.
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
  return <Card title="Disparo de hoje" badge={<Badge>fica na auditoria</Badge>}
    actions={state==="ready"&&preview?.available&&<><a className="button secondary small" href="/api/billing/collections/dispatch?format=csv" download><Icon name="download" size={14}/>CSV</a><button className="button small" disabled={running} onClick={()=>void run()}>{running?"Rodando…":"Rodar disparo"}</button></>}>
    {state==="loading"&&<Loading rows={1} stats={0}/>}
    {state==="error"&&<Notice tone="bad">Não foi possível consultar o disparo.</Notice>}
    {state==="ready"&&preview&&!preview.available&&<Notice tone="bad">{preview.detail}.</Notice>}
    {state==="ready"&&preview?.available&&<div className="stack">
      <Stats>
        <Stat label={`Faturas para hoje (${preview.today?.scheduledFor??"—"})`} value={count(preview.today?.candidates??0)} hint="Casam com alguma etapa ativa; quem já pagou não entra"/>
        <Stat label={`Disparos registrados (${preview.period})`} value={count(preview.indicators?.total??0)} hint="No ledger"/>
      </Stats>
      {runError&&<p className="form-error">{runError}</p>}
      {result&&<div className="dispatch-result">
        {result.businessHour
          ? <>Rodado: {result.candidates} candidato(s), <strong>{result.recorded}</strong> novo(s) registrado(s){result.duplicates>0?`, ${result.duplicates} já tinha(m) sido registrado(s) hoje`:""}.
              {result.queueEnabled?` ${result.enqueued} enfileirado(s) para envio.`:" A fila de envio está desligada (FEATURE_QUEUES) — ficou registrado, mas nada foi enfileirado."}</>
          : <>Fora do horário comercial: {result.candidates} candidato(s) seriam contatados, mas nada foi registrado. Rode entre 8h e 20h, em dia de semana.</>}
      </div>}
      <p className="hint">Sem ponte de envio ligada ao WhatsApp, o registro prova a decisão — não a entrega. Quando o worker de fila mandar a mensagem de verdade, ele consome o que fica enfileirado aqui.</p>
    </div>}
  </Card>;
}
