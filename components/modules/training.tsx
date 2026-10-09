"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentResult, ChatMessage } from "@/lib/agent/types";
import { Icon } from "@/components/ui/icons";
import { Badge, Empty } from "@/components/ui/kit";

type UiMessage = ChatMessage & { time: string; result?: AgentResult };
const clock = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/**
 * AI Training Mode: conversa de treino, sem cliente real do outro lado. Usa o
 * mesmo pipeline da produção; a análise ao lado é posterior e não muda o
 * pipeline operacional.
 */
export function TrainingModule() {
  const [result, setResult] = useState<AgentResult | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [session, setSession] = useState(0);
  return <div className="training">
    <section className="training-chat">
      <header className="chat-head">
        <span className="avatar md hue-2" aria-hidden="true"><Icon name="flask" size={16} /></span>
        <div className="chat-who"><strong>AI Training Mode</strong><span>Converse como um cliente: gírias, erros, ironia e mudança de assunto valem.</span></div>
        <div className="chat-badges"><Badge tone="info">Mesmo pipeline da produção</Badge>
          <button type="button" className="button secondary small" onClick={() => { setSession((value) => value + 1); setResult(null); }}><Icon name="refresh" size={14} />Nova conversa</button></div>
      </header>
      <TrainingConversation key={session} onResult={(next) => { setResult(next); setAccepted(false); }} />
    </section>
    <aside className="training-analysis" aria-label="Análise da resposta">
      <header className="card-head"><div className="card-title"><h3>Supervisor de qualidade</h3><Badge tone="ok">Automático</Badge></div></header>
      {!result
        ? <Empty icon="sparkles" title="Nenhuma resposta analisada ainda">Envie uma mensagem para ver intenção, execução, qualidade e a melhor resposta possível.</Empty>
        : <Analysis result={result} accepted={accepted} onAccept={() => setAccepted(true)} />}
    </aside>
  </div>;
}

function TrainingConversation({ onResult }: { onResult: (result: AgentResult) => void }) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [messages, busy]);

  async function send() {
    const value = input.trim(); if (!value || busy) return;
    const customer: UiMessage = { role: "customer", content: value, time: clock() };
    const updated = [...messages, customer]; setMessages(updated); setInput(""); setBusy(true);
    try {
      const response = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: value, history: updated.map(({ role, content }) => ({ role, content })) }) });
      const result = await response.json() as AgentResult;
      if (!response.ok) throw new Error("Falha na análise");
      setMessages((current) => [...current, { role: "agent", content: result.response, time: clock(), result }]);
      onResult(result);
    } catch { setMessages((current) => [...current, { role: "agent", content: "Tive uma falha ao consultar as ferramentas. Registrei o contexto e não vou confirmar nenhuma ação que não tenha sido concluída.", time: "agora" }]); }
    finally { setBusy(false); }
  }

  return <>
    <div className="messages">
      {messages.length === 0 && <p className="messages-note">Comece escrevendo como um cliente, por exemplo: “minha net caiu de novo”.</p>}
      {messages.map((message, index) => {
        const artifacts = message.result?.tools.flatMap((tool) => tool.artifact ? [tool.artifact] : []) ?? [];
        return <div key={index} className={`bubble ${message.role === "agent" ? "agent" : "customer"}`}>
          <div className="bubble-text">{message.content}</div>
          {artifacts.map((artifact, i) => <div className="artifact" key={i}><strong><Icon name="check" size={13} />{artifact.label}</strong><code>{artifact.value}</code></div>)}
          <footer><time>{message.time}</time></footer>
        </div>;
      })}
      {busy && <div className="bubble agent typing" aria-label="A IA está respondendo"><span /><span /><span /></div>}
      <div ref={endRef} />
    </div>
    <div className="composer">
      <textarea value={input} rows={1} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder="Digite qualquer mensagem como um cliente…" aria-label="Mensagem de treino" />
      <div className="composer-bar"><span className="composer-count" /><button type="button" className="button send" disabled={busy || !input.trim()} onClick={() => void send()}>Enviar<Icon name="send" size={15} /></button></div>
    </div>
  </>;
}

function Analysis({ result, accepted, onAccept }: { result: AgentResult; accepted: boolean; onAccept: () => void }) {
  const e = result.evaluation;
  const scores = [["Naturalidade", e.naturalness], ["Precisão", e.precision], ["Empatia", e.empathy], ["Segurança", e.safety], ["Continuidade", e.continuity], ["Memória", e.memory], ["Novidade", e.noveltyScore * 10], ["Progresso", e.progressScore * 10]] as const;
  return <div className="analysis">
    <section className="analysis-block analysis-main">
      <div><h4>Intenção detectada</h4><strong>{result.intent}</strong><small>{result.goal} · confiança {Math.round(result.confidence * 100)}%</small></div>
      <div className="score" style={{ ["--score" as string]: `${Math.max(0, Math.min(100, e.score * 10))}%` }}><span>{e.score}</span></div>
    </section>
    <section className="analysis-block"><h4>Estado e execução</h4>
      <div className="chips"><Badge tone="info">{result.state}</Badge><Badge tone={result.actionExecuted ? "warn" : "ok"}>{result.actionExecuted ? "Ação externa" : "Zero ação real"}</Badge><Badge>{result.finalStatus}</Badge></div>
      <code className="correlation">{result.correlationId}</code>
    </section>
    <section className="analysis-block"><h4>Ferramentas</h4>
      {result.tools.length ? <div className="chips">{result.tools.map((tool) => <span className={`chip ${tool.status === "completed" ? "ok" : "warn"}`} key={tool.tool}>{tool.status === "completed" ? "✓" : "!"} {tool.tool} · {tool.outcome}</span>)}</div> : <p className="muted small">Nenhuma ferramenta necessária.</p>}
    </section>
    <section className="analysis-block"><h4>Evidências</h4>
      {result.evidence.length ? <div className="evidence-list">{result.evidence.map((evidence) => <div className="evidence-item" key={evidence.id}><strong>{evidence.kind} · {evidence.source}</strong><span>{evidence.summary}</span><small>{evidence.simulated ? "Evidência simulada e identificada" : "Evidência validada"}</small></div>)}</div> : <p className="muted small">Nenhuma evidência foi produzida; o agente não pode alegar sucesso.</p>}
    </section>
    <section className="analysis-block"><h4>Transbordo</h4>
      <div className={`handoff-card ${result.handoff.required ? "required" : ""}`}><strong>{result.handoff.required ? "Necessário" : "Não necessário"}</strong><span>{result.handoff.reason ?? "O fluxo demonstrativo pode continuar com segurança."}</span>{result.handoff.summary && <small>{result.handoff.summary}</small>}</div>
    </section>
    <section className="analysis-block"><h4>Avaliação</h4>
      {scores.map(([label, value]) => <div className="score-row" key={label}><span>{label}</span><div className="mini-bar"><span style={{ width: `${Math.max(0, Math.min(100, value * 10))}%` }} /></div><b>{value}</b></div>)}
    </section>
    <section className="analysis-block"><h4>Resumo e próximo passo</h4><p className="small">{result.conversationSummary}</p><p className="small"><strong>Próximo:</strong> {result.nextStep}</p></section>
    <section className="analysis-block"><h4>Resposta considerada perfeita</h4>
      <div className="ideal">{e.idealResponse}</div><p className="muted small">{e.suggestion}</p>
      <button type="button" className={`button block ${accepted ? "success" : ""}`} onClick={onAccept}>{accepted ? "✓ Melhoria salva como caso aprovado" : "Aceitar melhoria"}</button>
    </section>
  </div>;
}
