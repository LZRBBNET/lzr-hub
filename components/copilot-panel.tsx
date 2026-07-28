"use client";

import { useEffect, useState } from "react";
import type { CopilotAction, CopilotResult } from "@/lib/copilot/types";

interface CopilotPanelProps {
  conversationId:string;
  onUseSuggestion:(text:string,suggestionId:string)=>void;
}

export function CopilotPanel({conversationId,onUseSuggestion}:CopilotPanelProps) {
  const [enabled,setEnabled]=useState<boolean|null>(null);
  const [question,setQuestion]=useState("");
  const [result,setResult]=useState<CopilotResult|null>(null);
  const [busy,setBusy]=useState<CopilotAction|null>(null);
  const [error,setError]=useState("");
  const [inserted,setInserted]=useState(false);

  useEffect(()=>{
    let active=true;
    fetch("/api/copilot",{cache:"no-store"})
      .then(async(response)=>{
        const data=await response.json() as {enabled?:boolean};
        if(active)setEnabled(response.ok&&data.enabled===true);
      })
      .catch(()=>{if(active)setEnabled(false)});
    return()=>{active=false};
  },[]);

  async function execute(action:CopilotAction) {
    if(!enabled||busy)return;
    const value=question.trim();
    if(action==="ask"&&!value)return;
    setBusy(action);
    setError("");
    setInserted(false);
    try {
      const response=await fetch("/api/copilot",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({
          action,
          conversationId,
          ...(action==="ask"?{question:value}:{}),
        }),
      });
      const data=await response.json() as CopilotResult&{error?:string};
      if(!response.ok)throw new Error(data.error??"Copiloto indisponível");
      setResult(data);
    } catch(cause) {
      setResult(null);
      setError(cause instanceof Error?cause.message:"Copiloto indisponível");
    } finally {
      setBusy(null);
    }
  }

  async function insertSuggestion() {
    if(!result?.suggestionId)return;
    setError("");
    try {
      const response=await fetch("/api/copilot",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({
          action:"use_suggestion",
          conversationId,
          suggestionId:result.suggestionId,
        }),
      });
      const data=await response.json() as {used?:boolean;error?:string};
      if(!response.ok||!data.used)throw new Error(data.error??"Não foi possível registrar o uso");
      onUseSuggestion(result.answer,result.suggestionId);
      setInserted(true);
    } catch(cause) {
      setError(cause instanceof Error?cause.message:"Não foi possível registrar o uso");
    }
  }

  return <section className="copilot-panel" aria-label="Copiloto LZR">
    <div className="copilot-heading">
      <div className="copilot-mark">✦</div>
      <div><strong>Copiloto LZR</strong><span>Assistente interno do atendente</span></div>
      <span className={`copilot-status ${enabled?"on":""}`}>
        {enabled?"Ativo":enabled===null?"Verificando":"Desligado"}
      </span>
    </div>

    {enabled===false&&<div className="copilot-disabled">
      <strong>Recurso desabilitado</strong>
      <span>Ative somente com <code>FEATURE_INTERNAL_COPILOT=true</code>.</span>
    </div>}

    {enabled!==false&&<>
      <div className="copilot-actions">
        <button disabled={!enabled||Boolean(busy)} onClick={()=>void execute("suggest_reply")}>
          <span>✦</span><div><strong>Sugerir resposta</strong><small>Baseada na conversa e na KB</small></div>
        </button>
        <button disabled={!enabled||Boolean(busy)} onClick={()=>void execute("summarize")}>
          <span>≡</span><div><strong>Resumir conversa</strong><small>Para transferência interna</small></div>
        </button>
      </div>

      <form className="copilot-question" onSubmit={(event)=>{event.preventDefault();void execute("ask")}}>
        <label htmlFor="copilot-question">Pergunte sobre um procedimento</label>
        <div><input id="copilot-question" value={question} maxLength={1000} onChange={(event)=>setQuestion(event.target.value)} placeholder="Ex.: qual é o procedimento?" /><button disabled={!enabled||Boolean(busy)||!question.trim()} aria-label="Perguntar ao copiloto">➤</button></div>
      </form>

      {busy&&<div className="copilot-loading">Consultando fontes internas vigentes…</div>}
      {error&&<div className="copilot-error" role="alert">{error}</div>}

      {result&&!busy&&<div className="copilot-result">
        <div className="copilot-result-label">
          <strong>{result.action==="summarize"?"Resumo para transferência":result.action==="ask"?"Resposta interna":"Sugestão de resposta"}</strong>
          {result.simulationOnly&&<span>simulationOnly</span>}
        </div>
        <p>{result.answer}</p>

        {result.sources.length>0?<div className="copilot-sources">
          <h4>Fontes utilizadas</h4>
          {result.sources.map((source)=><article key={`${source.id}-${source.version}`}>
            <strong>{source.id} • {source.title}</strong>
            <span>Versão {source.version}</span>
            <p>“{source.excerpt}”</p>
          </article>)}
        </div>:result.action!=="summarize"&&<div className="copilot-no-source">Nenhuma fonte elegível foi encontrada.</div>}

        {result.action==="suggest_reply"&&result.suggestionId&&<button className="button copilot-use" disabled={inserted} onClick={()=>void insertSuggestion()}>
          {inserted?"✓ Inserida para revisão":"Usar sugestão"}
        </button>}
        {inserted&&<small className="copilot-review-note">O texto foi apenas inserido. Revise e envie manualmente.</small>}
      </div>}
    </>}
  </section>;
}
