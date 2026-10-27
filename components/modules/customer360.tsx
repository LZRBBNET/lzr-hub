"use client";
import { useEffect, useRef, useState } from "react";
import type { Customer360 } from "@/lib/platform/customer360-service";
import type { CustomerSummary } from "@/lib/platform/types";
import { Icon } from "@/components/ui/icons";
import { Avatar, Badge, Card, Empty, InfoTip, Loading, Modal, Notice, Toolbar, count } from "@/components/ui/kit";
import { useMediaQuery } from "@/components/ui/preferences";

/**
 * O IXC devolve a situação como letra: "A" ativo, "I" encerrado, "P" pré-contrato.
 * Mostrar a letra crua obriga quem atende a decorar código de ERP. Código
 * desconhecido é exibido como veio, em vez de ser traduzido por chute.
 */
const STATUS_LABELS:Record<string,[string,string]>={A:["Ativo","ok"],I:["Encerrado","bad"],P:["Pré-contrato","warn"],S:["Ativo","ok"],N:["Inativo","bad"]};
function statusOf(raw:string):[string,string]{
  const value=(raw??"").trim();
  if(STATUS_LABELS[value.toUpperCase()])return STATUS_LABELS[value.toUpperCase()];
  if(/^ativo$/i.test(value))return ["Ativo","ok"];
  if(/^inativo|encerrad/i.test(value))return ["Inativo","bad"];
  return [value||"—","warn"];
}

export function Customer360Module(){
  const [query,setQuery]=useState(""); const [term,setTerm]=useState(""); const [risk,setRisk]=useState("all"); const [page,setPage]=useState(1);
  const [items,setItems]=useState<CustomerSummary[]>([]); const [total,setTotal]=useState(0); const [pageSize,setPageSize]=useState(10);
  const [scope,setScope]=useState<"allowlist"|"full-base">("allowlist"); const [mode,setMode]=useState<"demo"|"staging-readonly">("demo");
  const [selectedId,setSelectedId]=useState<string|null>(null); const [selected,setSelected]=useState<Customer360|null>(null); const [detailError,setDetailError]=useState(false);
  const [loadedKey,setLoadedKey]=useState<string|null>(null); const [failed,setFailed]=useState(false); const [refreshing,setRefreshing]=useState(false);
  const detailRequest=useRef(0);
  useEffect(()=>()=>{detailRequest.current++},[]);
  const wide=useMediaQuery("(min-width: 1101px)");
  // Com a base inteira liberada, cada tecla digitada seria uma consulta ao IXC.
  // O termo só vira busca depois que a pessoa para de digitar.
  useEffect(()=>{const timer=setTimeout(()=>{setTerm(query);setPage(1)},350);return()=>clearTimeout(timer)},[query]);
  const key=`${term}|${risk}|${page}`;
  useEffect(()=>{let active=true;
    fetch(`/api/customers?q=${encodeURIComponent(term)}&risk=${risk}&page=${page}`).then(r=>r.ok?r.json():Promise.reject())
      .then(data=>{if(active){setItems(data.items);setTotal(data.total??data.items.length);setPageSize(data.pageSize??10);setScope(data.scope??"allowlist");setMode(data.mode);setFailed(false);setLoadedKey(`${term}|${risk}|${page}`)}})
      .catch(()=>{if(active){setFailed(true);setLoadedKey(`${term}|${risk}|${page}`)}});
    return()=>{active=false}},[term,risk,page]);
  function closeDetail(){detailRequest.current++;setSelectedId(null);setSelected(null);setRefreshing(false);setDetailError(false)}
  async function open(id:string){
    const request=++detailRequest.current;
    setSelectedId(id);setSelected(null);setDetailError(false);setRefreshing(false);
    try{
      const response=await fetch(`/api/customers?id=${encodeURIComponent(id)}`);
      if(!response.ok)throw new Error("indisponível");
      const payload=await response.json() as Customer360;
      if(request===detailRequest.current){if(payload.customer.id!==id)throw new Error("cadastro incorreto");setSelected(payload)}
    }catch{if(request===detailRequest.current)setDetailError(true)}
  }
  async function refresh(){
    if(!selected)return;const id=selected.customer.id;const request=++detailRequest.current;setRefreshing(true);
    try{
      const response=await fetch("/api/customers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"refresh",id})});
      if(!response.ok)throw new Error("indisponível");
      const payload=await response.json() as Customer360;
      if(request===detailRequest.current){if(payload.customer.id!==id)throw new Error("cadastro incorreto");setSelected(payload);setDetailError(false)}
    }catch{if(request===detailRequest.current){setSelected(null);setDetailError(true)}}
    finally{if(request===detailRequest.current)setRefreshing(false)}
  }
  const live=mode==="staging-readonly";
  const loading=loadedKey!==key;
  const first=total===0?0:(page-1)*pageSize+1;
  const last=(page-1)*pageSize+items.length;
  // Na listagem do IXC o plano não vem — todas as linhas diriam "Abrir para consultar". Coluna repetida é ruído.
  const showPlan=items.some(c=>c.plan&&!/abrir para consultar/i.test(c.plan));
  const cols=showPlan?"minmax(0,2fr) minmax(0,1.3fr) 110px minmax(0,.9fr)":"minmax(0,2.4fr) 120px minmax(0,1fr)";
  const detail=<CustomerDetail data={selected} loading={!!selectedId&&!selected&&!detailError} error={detailError} refreshing={refreshing} onRefresh={live?()=>void refresh():undefined} onClose={closeDetail}/>;

  return <>
    <Toolbar>
      <label className="search-field"><Icon name="search" size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={scope==="full-base"?"Buscar por nome, CPF/CNPJ ou código…":"Buscar por nome, código, cidade ou bairro…"} aria-label="Buscar cliente"/></label>
      {!live&&<select className="select" value={risk} aria-label="Risco" onChange={e=>{setRisk(e.target.value);setPage(1)}}><option value="all">Todos os riscos</option><option value="low">Baixo</option><option value="medium">Médio</option><option value="high">Alto</option><option value="critical">Crítico</option></select>}
      {scope==="full-base"&&!loading&&<span className="muted small">{count(total)} cadastro(s){term?" no filtro":""} <InfoTip label="Como a busca funciona">Base completa do IXC. A busca por nome é parcial; CPF/CNPJ e código são exatos.</InfoTip></span>}
    </Toolbar>
    {live&&scope==="allowlist"&&!loading&&<Notice tone="warn" more="É trava nossa, de homologação: liberar a base inteira depende de FEATURE_IXC_FULL_BASE.">Só os cadastros liberados na allowlist do IXC aparecem aqui.</Notice>}
    <div className={selectedId&&wide?"customer-layout":""}>
      <Card flush>
        {loading&&<Loading rows={8}/>}
        {!loading&&failed&&<div className="card-content"><Notice tone="bad">Não foi possível carregar os clientes. Tente de novo.</Notice></div>}
        {!loading&&!failed&&items.length===0&&<Empty icon="users" title="Nenhum cliente encontrado">{term?"Tente outro nome, CPF ou código.":undefined}</Empty>}
        {!loading&&!failed&&items.length>0&&<div className="table" style={{["--cols" as string]:cols}}>
          <div className="tr head hide-sm"><span>Cliente</span>{showPlan&&<span>Plano</span>}<span>{live?"Cadastro":"Situação"}</span><span>{live?"Cidade":"Risco"}</span></div>
          {items.map(c=><button type="button" className={`tr stack-sm ${selectedId===c.id?"active":""}`} key={c.id} onClick={()=>void open(c.id)}>
            <span className="cell"><strong>{c.name}</strong><small>{c.id} · {c.maskedDocument}</small></span>
            {showPlan&&<span className="clip" title={c.plan}>{c.plan||"—"}</span>}
            <span className={`status ${statusOf(c.status)[1]}`}>{statusOf(c.status)[0]}</span>
            <span className="muted clip">{live?c.city||"—":c.churnRisk?<i className={`severity ${c.churnRisk}`}>{c.churnRisk}</i>:"não calculado"}</span>
          </button>)}
        </div>}
        {!loading&&!failed&&total>0&&<div className="pagination"><span>{count(first)}–{count(last)} de {count(total)}</span>
          <button className="icon-button" aria-label="Página anterior" disabled={page<=1} onClick={()=>setPage(page-1)}><Icon name="chevron-left" size={16}/></button>
          <button className="icon-button" aria-label="Próxima página" disabled={last>=total} onClick={()=>setPage(page+1)}><Icon name="chevron-right" size={16}/></button></div>}
      </Card>
      {selectedId&&wide&&<aside className="card customer-detail">{detail}</aside>}
    </div>
    {!wide&&<Modal side open={!!selectedId} title="Cliente" onClose={closeDetail}>{detail}</Modal>}
  </>;
}

function CustomerDetail({data,loading,error,refreshing,onRefresh,onClose}:{data:Customer360|null;loading:boolean;error:boolean;refreshing:boolean;onRefresh?:()=>void;onClose:()=>void}){
  if(error)return <div className="card-content"><Notice tone="bad">Não foi possível abrir este cadastro.</Notice><button type="button" className="button ghost small" onClick={onClose}>Fechar</button></div>;
  if(loading||!data)return <><button type="button" className="button ghost small" onClick={onClose}>Fechar</button><Loading rows={6}/></>;
  // A situação do cadastro, a mesma da lista: o contrato pode estar encerrado com o cliente ativo em outro.
  const [statusText,statusTone]=statusOf(data.customer.status);
  const live=data.mode==="staging-readonly";
  const reading=data.reading;
  const currency=(value:number|null)=>value===null?"Não confirmado":`R$ ${value.toFixed(2).replace(".",",")}`;
  const coverageLabel=(key:"contracts"|"invoices"|"payments"|"serviceOrders")=>{const c=reading?.coverage[key];return c?`${c.read} lidos${c.total===null?"; total não confirmado":` de ${c.total}`}${c.complete?"; leitura completa":"; recorte parcial ou não confirmado"}`:"Recorte limitado; total não confirmado"};
  const observedAt=reading?.observedAt??data.sources[0]?.updatedAt;
  const observed=observedAt&&Number.isFinite(new Date(observedAt).getTime())?new Date(observedAt).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"}):"Horário não confirmado";
  return <>
    <div className="details-head">
      <Avatar size="lg" name={data.customer.name}/>
      <h2>{data.customer.name}</h2><p>Código {data.customer.id} · {data.customer.maskedDocument}</p>
      <div className="chips" style={{justifyContent:"center",marginTop:6}}><Badge tone={statusTone==="ok"?"ok":statusTone==="bad"?"bad":"warn"}>{live?"Cadastro: ":""}{statusText}</Badge><Badge tone={live?"info":"neutral"}>{live?"IXC":"Demonstração"}</Badge></div>
      <button type="button" className="icon-button details-close" onClick={onClose} aria-label="Fechar"><Icon name="x"/></button>
    </div>
    <div className="details-body">
      {data.partial&&<Notice tone="warn">Leitura parcial ou com dados não confirmados. Os recortes abaixo não representam necessariamente todo o histórico.</Notice>}
      <Section title="Contato" rows={[["Telefone",data.contact.phone],["E-mail",data.contact.email],["Endereço",data.contact.address],["Cliente desde",data.contact.customerSince]]}/>
      {(!live||reading?.contractSelection==="single")&&<Section title={live?"Contrato único na leitura":"Contrato"} rows={[["Código",data.contract.id],["Situação do contrato",statusOf(data.contract.status)[0]],["Plano",data.contract.plan],["Mensalidade",currency(data.contract.monthlyValue)],["Vencimento",data.contract.dueDay?`Dia ${data.contract.dueDay}`:"Indisponível"]]}/>}
      {live&&reading?.contractSelection!=="single"&&<section className="details-section">
        <h3>Contratos consultados</h3>
        <p className="hint">{reading?.contractSelection==="none"?"Nenhum contrato encontrado na leitura completa.":reading?.contractSelection==="unavailable"?"Fonte de contratos indisponível.":"Nenhum contrato escolhido automaticamente como atual. Situação do cadastro e do contrato são informações diferentes."}</p>
        {reading?.contracts.map(contract=><p className="small" key={contract.id}>Contrato {contract.id} · {statusOf(contract.status)[0]} · {contract.plan}</p>)}
      </section>}
      {live&&<p className="hint">Contratos: {coverageLabel("contracts")}</p>}
      <Section title="Financeiro consultado" rows={[[live?(reading?.financeComplete?"Saldo vencido na leitura":"Subtotal vencido conhecido (parcial)"):"Em atraso",currency(data.finance.overdueAmount)],[live?"Data de pagamento mais recente no recorte":"Último pagamento",data.finance.lastPayment]]}/>
      {live&&<section className="details-section">
        <p className="hint">Faturas: {coverageLabel("invoices")}. Referência de vencimento: {reading?.referenceDate??"não confirmada"} (Brasília).</p>
        {reading&&!reading.financeAvailable&&<Notice tone="bad">Fonte financeira indisponível. Nenhum saldo foi confirmado.</Notice>}
        {reading&&!reading.financeComplete&&<Notice tone="warn">Não é o saldo total confirmado do cliente. Valor ausente ou parcial não significa ausência de dívida.</Notice>}
        {!!reading?.excludedInvoices&&<p className="hint">{reading.excludedInvoices} fatura(s) excluída(s) por identidade, status, vencimento ou valor não confirmados.</p>}
        {!!reading?.nominalValueInvoices&&<p className="hint">{reading.nominalValueInvoices} valor(es) nominal(is) ou sem origem confirmada excluído(s) do subtotal; pagamentos parciais podem não estar descontados.</p>}
        <p className="hint">Pagamentos: {coverageLabel("payments")}. Consulta limitada a até 10 faturas; não afirma qual foi o último pagamento do cliente.</p>
      </section>}
      <Section title="Conexão" rows={[["Status",data.network.onuStatus],["PPPoE (login)",data.network.pppoe],["Equipamento/OLT",data.network.equipmentDescriptor],["Tipo de conexão",data.network.connectionType],["ONU",data.network.onu],["Potência",data.network.opticalPower],["Última conexão",data.network.uptime]]}/>
      {data.details&&<Section title={live?"Registros consultados (não totais históricos)":"Histórico"} rows={[["Contratos",String(data.details.contracts)],["Faturas",String(data.details.invoices)],["Pagamentos",String(data.details.payments)],["Ordens de serviço",String(data.details.serviceOrders)]]}/>}
      {live&&<p className="hint">Ordens de serviço: {coverageLabel("serviceOrders")}</p>}
      {/* Saúde e risco só existem na demonstração: com o IXC real nada os calcula, e a seção seria quatro linhas de "não calculado". */}
      {!live&&<Section title="Inteligência (demonstração)" rows={[["Saúde",data.intelligence.health?`${data.intelligence.health}/100`:"Não calculada"],["Risco",data.intelligence.churnRisk],["Upgrade",data.intelligence.upgradeEligible?data.intelligence.recommendedPlan:"Não elegível"],["Motivo",data.intelligence.reason]]}/>}
      <section className="details-section">
        <h3>Fontes {typeof data.totalLatencyMs==="number"&&<span className="muted" style={{fontWeight:400}}>· {data.totalLatencyMs} ms</span>}{onRefresh&&<button className="button ghost small" style={{marginLeft:"auto"}} disabled={refreshing} onClick={onRefresh}><Icon name="refresh" size={14}/>{refreshing?"Atualizando…":"Ler de novo"}</button>}</h3>
        {live&&<p className="hint">Leitura em {observed} (Brasília). {data.sources.some(s=>s.cache==="hit")?"Dados em cache; a hora é da consulta original.":"Consulta ao IXC, sem cache indicado."}</p>}
        <div className="chips">{data.sources.map((s,i)=><span key={i} className={`chip ${s.state==="error"?"warn":"ok"}`} title={`${s.masked?"mascarado":"real"} · ${s.latencyMs??0} ms`}>{s.provider} · {s.state==="ready"?(s.cache==="hit"?"cache":"ok"):"indisponível"}</span>)}</div>
      </section>
    </div>
  </>;
}

function Section({title,rows}:{title:string;rows:[string,string][]}){
  return <section className="details-section"><h3>{title}</h3><dl className="facts">{rows.map(([a,b])=><div key={a} className={a.length>25?"stacked":undefined}><dt>{a}</dt><dd>{b||"—"}</dd></div>)}</dl></section>;
}
