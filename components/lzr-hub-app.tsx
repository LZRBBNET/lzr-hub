"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentResult, ChatMessage } from "@/lib/agent/types";
import { navigation, viewTitles, type View } from "@/lib/platform/navigation";
import { PlatformView } from "@/components/platform-view";
import { Customer360Module } from "@/components/modules/customer360";
import { SupportModule } from "@/components/modules/support";
import { BillingModule } from "@/components/modules/billing";
import { SalesModule } from "@/components/modules/sales";
import { IntelligenceModule } from "@/components/modules/intelligence";
import { AdminModule } from "@/components/modules/admin";

type UiMessage = ChatMessage & { time: string; result?: AgentResult };

function Avatar({ initials = "JP" }: { initials?: string }) { return <div className="avatar">{initials}</div>; }

type SessionState = { authenticated: boolean; authRequired: boolean; user?: { name: string; email: string; role: string } };

function initialsOf(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "??";
}

/**
 * Só redireciona depois que a sessão é consultada no cliente. A primeira
 * renderização é sempre a aplicação normal — o HTML inicial é verificado pelos
 * testes do ambiente de demonstração e não pode virar uma tela de carregamento.
 */
function useSessionRedirect() {
  const [session, setSession] = useState<SessionState | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: SessionState) => {
        if (!active) return;
        setSession(data);
        if (data.authRequired && !data.authenticated) window.location.href = "/login";
      })
      .catch(() => { if (active) setSession(null); });
    return () => { active = false; };
  }, []);
  return session;
}

export function LzrHubApp() {
  const [view, setView] = useState<View>("dashboard");
  const session = useSessionRedirect();
  const user = session?.user;

  function signOut() {
    fetch("/api/auth/logout", { method: "POST" })
      .then(() => { window.location.href = "/login"; })
      .catch(() => { window.location.href = "/login"; });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">L</div><div className="brand-copy"><strong>LZR HUB</strong><small>BBNET Intelligence</small></div></div>
        <div className="nav-scroll">{navigation.map((item) => <div key={item.id}>{item.group ? <div className="nav-label">{item.group}</div> : null}<button className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)}><span className="nav-icon">{item.icon}</span><span>{item.label}</span></button></div>)}</div>
        <div className="sidebar-footer">
          <Avatar initials={user ? initialsOf(user.name) : "AD"} />
          <div><strong>{user ? user.name : "Admin Demonstração"}</strong><span>{user ? user.role : "Usuário sintético"}</span></div>
          {user && <button className="button secondary" onClick={signOut}>Sair</button>}
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar"><div className="topbar-title"><strong>{viewTitles[view][0]}</strong><span>{viewTitles[view][1]}</span></div><div className="live-pill">● Homologação protegida • demo mock</div></header>
        <div className="demo-notice" role="status"><strong>Ambiente de demonstração</strong><span>nenhuma ação real é executada</span></div>
        {view === "dashboard" && <Dashboard onOpen={() => setView("atendimento")} />}
        {view === "atendimento" && <Conversation />}
        {view === "training" && <TrainingMode />}
        {["integracoes","equipes","usuarios","auditoria","configuracoes"].includes(view) && <AdminModule view={view as "integracoes"|"equipes"|"usuarios"|"auditoria"|"configuracoes"} />}
        {view === "clientes" && <Customer360Module />}
        {["monitoramento","mapa-alertas","massivas","chamados"].includes(view) && <SupportModule view={view as "monitoramento"|"mapa-alertas"|"massivas"|"chamados"} />}
        {["cobranca","regua","campanhas","relatorios-cobranca"].includes(view) && <BillingModule view={view as "cobranca"|"regua"|"campanhas"|"relatorios-cobranca"} />}
        {["comercial","leads","funil","kanban","metas","relatorios-comercial"].includes(view) && <SalesModule view={view as "comercial"|"leads"|"funil"|"kanban"|"metas"|"relatorios-comercial"} />}
        {["intelligence","saude","churn","upgrade","conhecimento"].includes(view) && <IntelligenceModule view={view as "intelligence"|"saude"|"churn"|"upgrade"|"conhecimento"} />}
        {!["dashboard","atendimento","training","integracoes","equipes","usuarios","auditoria","configuracoes","clientes","monitoramento","mapa-alertas","massivas","chamados","cobranca","regua","campanhas","relatorios-cobranca","comercial","leads","funil","kanban","metas","relatorios-comercial","intelligence","saude","churn","upgrade","conhecimento"].includes(view) && <PlatformView view={view} />}
      </section>
    </div>
  );
}

function Dashboard({ onOpen }: { onOpen: () => void }) {
  return <main className="content">
    <div className="page-heading"><div><h1>Olá, equipe BBNET.</h1><p>Dados sintéticos para navegação segura. Nenhuma integração real está habilitada.</p></div><button className="button" onClick={onOpen}>Abrir central de atendimento</button></div>
    <section className="metrics">
      <Metric label="Conversas ativas" value="18" detail="↑ 12% desde ontem" icon="◫" />
      <Metric label="Resolvidas pela IA" value="74%" detail="↑ 6,4% esta semana" icon="✦" />
      <Metric label="Tempo médio" value="1m 42s" detail="↓ 18s esta semana" icon="◷" />
      <Metric label="Qualidade média" value="9,4" detail="35 avaliações aprovadas" icon="✓" />
    </section>
    <section className="dashboard-grid">
      <div className="card"><div className="card-header"><strong>Fila de atendimento</strong><span className="badge green">● Operação normal</span></div><div className="card-body">
        {[["JP","João Pereira","Sem internet • IA diagnosticando","Agora","blue"],["MS","Maria Souza","Segunda via entregue","2 min","green"],["RC","Rafael Costa","Lentidão no Wi-Fi","4 min","amber"],["AC","Ana Carvalho","Upgrade de plano","7 min",""]].map(([a,n,s,t,c]) => <div className="queue-row" key={n}><Avatar initials={a} /><div><p>{n}</p><span>{s}</span></div><span className={`badge ${c}`}>{t}</span></div>)}
      </div></div>
      <div className="card"><div className="card-header"><strong>Resolução por tema</strong><span className="badge blue">Hoje</span></div><div className="card-body">
        <Progress label="Financeiro" value={91} /><Progress label="Suporte técnico" value={76} /><Progress label="Comercial" value={68} /><Progress label="Retenção" value={54} />
        <div style={{marginTop:22,padding:14,background:"#f2f7ff",borderRadius:10,fontSize:11,color:"#40566d",lineHeight:1.6}}><strong style={{display:"block",fontSize:12,color:"#1267e8",marginBottom:4}}>Regra de segurança ativa</strong>Nenhuma ação é confirmada sem comprovante técnico de execução.</div>
      </div></div>
    </section>
  </main>;
}

function Metric({ label, value, detail, icon }: { label:string; value:string; detail:string; icon:string }) { return <article className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><small>{detail}</small></article>; }
function Progress({ label, value }: { label:string; value:number }) { return <div className="bar-row"><div className="bar-label"><span>{label}</span><strong>{value}%</strong></div><div className="bar"><span style={{width:`${value}%`}} /></div></div>; }

function Conversation() {
  const initial: UiMessage[] = [
    { role:"customer", content:"Oi, estou sem internet e trabalho de casa. Preciso resolver isso rápido.", time:"16:42" },
    { role:"agent", content:"Demonstração com dados fictícios: a ONU simulada está online e o PPPoE simulado está offline. Nenhuma consulta ou ação real foi executada. Para continuar o diagnóstico de exemplo, consegue desligar o roteador da tomada por 20 segundos?", time:"16:43" },
  ];
  return <main className="content" style={{paddingTop:18}}><ConversationWorkspace initial={initial} training={false} /></main>;
}

function ConversationWorkspace({ initial, training, onResult }: { initial: UiMessage[]; training: boolean; onResult?: (result: AgentResult) => void }) {
  const [messages, setMessages] = useState<UiMessage[]>(initial);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior:"smooth" }), [messages, busy]);
  async function send() {
    const value = input.trim(); if (!value || busy) return;
    const customer: UiMessage = { role:"customer", content:value, time:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) };
    const updated = [...messages, customer]; setMessages(updated); setInput(""); setBusy(true);
    try {
      const response = await fetch("/api/agent", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({message:value,history:updated.map(({role,content})=>({role,content}))}) });
      const result = await response.json() as AgentResult;
      if (!response.ok) throw new Error("Falha na análise");
      setMessages((current) => [...current, { role:"agent", content:result.response, time:new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}), result }]);
      onResult?.(result);
    } catch { setMessages((current) => [...current,{role:"agent",content:"Tive uma falha ao consultar as ferramentas. Registrei o contexto e não vou confirmar nenhuma ação que não tenha sido concluída.",time:"agora"}]); }
    finally { setBusy(false); }
  }
  const chat = <>
    <div className={training ? "training-messages" : "messages"}>
      {messages.map((message,index) => <Message key={index} message={message} />)}
      {busy && <div className="message agent">Estou consultando isso aqui para você…</div>}
      <div ref={endRef} />
    </div>
    <div className="composer"><textarea value={input} onChange={(e)=>setInput(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send();}}} placeholder={training?"Digite qualquer mensagem como um cliente…":"Responder ao cliente…"}/><button aria-label="Enviar" onClick={()=>void send()}>➤</button></div>
  </>;
  if (training) return chat;
  return <div className="conversation-layout">
    <aside className="conversation-list"><input className="search" placeholder="Buscar conversa…" />{[["JP","João Pereira","Sem internet e trabalho de casa","agora"],["MS","Maria Souza","Obrigada, recebi a fatura","2m"],["RC","Rafael Costa","A internet está muito lenta","4m"],["AC","Ana Carvalho","Quero melhorar meu plano","7m"]].map(([a,n,m,t],i)=><div className={`contact ${i===0?"active":""}`} key={n}><Avatar initials={a}/><div><p>{n}</p><span>{m}</span></div><time>{t}</time></div>)}</aside>
    <section className="conversation-main"><div className="chat-header"><div className="person"><Avatar/><div><strong>João Pereira</strong><span>● Canal demonstrativo</span></div></div><span className="badge blue">IA em modo mock</span></div>{chat}</section>
    <aside className="customer-panel"><div className="customer-head"><Avatar/><h3>João Pereira</h3><p>Cliente fictício • dados sintéticos</p></div><Info title="Contrato demo" rows={[["Plano","600 Mega"],["Status","Ativo fictício"],["Vencimento","Dia 10"],["Cidade","Itabaiana/SE"]]}/><Info title="Conexão simulada" rows={[["ONU","Online"],["PPPoE","Offline"],["Potência","-19,8 dBm"],["Atualizado","agora"]]}/><Info title="Contexto demo" rows={[["Sentimento","Preocupado"],["Prioridade","Alta"],["Motivo","Home office"]]}/></aside>
  </div>;
}

function Message({ message }: { message: UiMessage }) { const artifacts=message.result?.tools.flatMap(t=>t.artifact?[t.artifact]:[])??[]; return <div className={`message ${message.role==="agent"?"agent":""}`}>{message.content}{artifacts.map((a,i)=><div className="artifact" key={i}><strong>✓ {a.label}</strong><code>{a.value}</code></div>)}<time>{message.time} {message.role==="agent"?"✓✓":""}</time></div>; }
function Info({ title, rows }: { title:string; rows:string[][] }) { return <div className="info-section"><h4>{title}</h4>{rows.map(([a,b])=><div className="info-line" key={a}><span>{a}</span><strong>{b}</strong></div>)}</div>; }

function TrainingMode() {
  const [result,setResult]=useState<AgentResult|null>(null);
  const [accepted,setAccepted]=useState(false);
  return <main className="content"><div className="page-heading"><div><h1>AI Training Mode</h1><p>Converse livremente. A análise é posterior e não muda o pipeline operacional.</p></div><span className="badge blue">Mesmo pipeline da produção</span></div><div className="training-grid">
    <section className="training-chat"><div className="training-header"><div><strong>Cliente de treinamento</strong><p>Gírias, erros, ironia e mudança de assunto são aceitos.</p></div><button className="button secondary" onClick={()=>location.reload()}>Nova conversa</button></div><ConversationWorkspace training initial={[]} onResult={(r)=>{setResult(r);setAccepted(false)}} /></section>
    <aside className="analysis-panel"><div className="card-header"><strong>Supervisor de Qualidade</strong><span className="badge green">Automático</span></div>{!result?<div className="analysis-empty">Envie uma mensagem para visualizar intenção, execução, qualidade e a melhor resposta possível.</div>:<Analysis result={result} accepted={accepted} onAccept={()=>setAccepted(true)} />}</aside>
  </div></main>;
}

function Analysis({result,accepted,onAccept}:{result:AgentResult;accepted:boolean;onAccept:()=>void}) { const e=result.evaluation; const scores=[["Naturalidade",e.naturalness],["Precisão",e.precision],["Empatia",e.empathy],["Segurança",e.safety],["Continuidade",e.continuity],["Memória",e.memory],["Novidade",e.noveltyScore*10],["Progresso",e.progressScore*10]] as const; return <>
  <div className="analysis-block"><div className="analysis-main"><div><h4>Intenção detectada</h4><strong>{result.intent}</strong><div style={{fontSize:11,color:"#64748b",marginTop:4}}>{result.goal} • confiança {Math.round(result.confidence*100)}%</div></div><div className="score"><span>{e.score}</span></div></div></div>
  <div className="analysis-block"><h4>Estado e execução</h4><div className="analysis-status"><span className="badge blue">{result.state}</span><span className={`badge ${result.actionExecuted?"amber":"green"}`}>{result.actionExecuted?"Ação externa":"Zero ação real"}</span><span className="badge">{result.finalStatus}</span></div><div className="correlation">{result.correlationId}</div></div>
  <div className="analysis-block"><h4>Ferramentas</h4><div className="tool-list">{result.tools.length?result.tools.map(t=><span className="tool-chip" key={t.tool}>{t.status==="completed"?"✓":"!"} {t.tool} • {t.outcome}</span>):<span className="analysis-muted">Nenhuma ferramenta necessária.</span>}</div></div>
  <div className="analysis-block"><h4>Evidências</h4>{result.evidence.length?<div className="evidence-list">{result.evidence.map((evidence)=><div className="evidence-item" key={evidence.id}><strong>{evidence.kind} • {evidence.source}</strong><span>{evidence.summary}</span><small>{evidence.simulated?"Evidência simulada e identificada":"Evidência validada"}</small></div>)}</div>:<p className="analysis-muted">Nenhuma evidência foi produzida; o agente não pode alegar sucesso.</p>}</div>
  <div className="analysis-block"><h4>Transbordo</h4><div className={`handoff-card ${result.handoff.required?"required":""}`}><strong>{result.handoff.required?"Necessário":"Não necessário"}</strong><span>{result.handoff.reason??"O fluxo demonstrativo pode continuar com segurança."}</span>{result.handoff.summary&&<small>{result.handoff.summary}</small>}</div></div>
  <div className="analysis-block"><h4>Avaliação</h4>{scores.map(([label,value])=><div className="score-row" key={label}><div><div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><span>{label}</span><strong>{value}</strong></div><div className="mini-bar"><span style={{width:`${value*10}%`}} /></div></div><span>/10</span></div>)}</div>
  <div className="analysis-block"><h4>Resumo e próximo passo</h4><p style={{fontSize:11,lineHeight:1.55,color:"#536478"}}>{result.conversationSummary}</p><p style={{fontSize:11,lineHeight:1.55}}><strong>Próximo:</strong> {result.nextStep}</p></div>
  <div className="analysis-block"><h4>Resposta considerada perfeita</h4><div className="ideal">{e.idealResponse}</div><p style={{fontSize:10,color:"#64748b",lineHeight:1.5}}>{e.suggestion}</p><button className={`button ${accepted?"success":""}`} style={{width:"100%"}} onClick={onAccept}>{accepted?"✓ Melhoria salva como caso aprovado":"Aceitar melhoria"}</button></div>
  </>; }
