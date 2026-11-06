"use client";
import { useEffect, useRef, useState } from "react";

type Delivery = { reservationId:string; status:"pending"|"uncertain"; eligible:boolean; acceptedMessageId:string|null };
export function DeliveryReconciliation({conversationId,refreshKey,onBlocked}:{conversationId:string;refreshKey:boolean;onBlocked:(blocked:boolean)=>void}) {
  const [delivery,setDelivery]=useState<Delivery|null>(null),[canReconcile,setCanReconcile]=useState(false),[error,setError]=useState<string|null>(null);
  const [outcome,setOutcome]=useState(""),[evidence,setEvidence]=useState(""),[messageId,setMessageId]=useState(""),[busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  const [revision,setRevision]=useState(0);
  const [editingReservation,setEditingReservation]=useState<string|null>(null);
  const reservationRef=useRef<string|null>(null);
  useEffect(()=>{
    let disposed=false;const controller=new AbortController();
    onBlocked(true);
    const refresh=async()=>{try{
      const response=await fetch(`/api/conversations/reconcile?conversationId=${encodeURIComponent(conversationId)}`,{signal:controller.signal,cache:"no-store"});
      const body=await response.json();if(!response.ok)throw Error(body.error??"Estado do envio indisponível. Não reenvie.");
      if(disposed)return;
      const nextReservation=body.delivery?.reservationId??null;
      if(reservationRef.current!==nextReservation){reservationRef.current=nextReservation;setEditingReservation(null);setOutcome("");setEvidence("");setMessageId("");}
      setDelivery(body.delivery);setCanReconcile(body.canReconcile===true);setError(null);onBlocked(!!body.delivery);
    }catch(e){if(!disposed){setError(e instanceof Error?e.message:"Estado indisponível. Não reenvie.");onBlocked(true);}}};
    void refresh();const timer=setInterval(()=>void refresh(),5000);
    return()=>{disposed=true;controller.abort();clearInterval(timer);};
  },[conversationId,refreshKey,revision,onBlocked]);
  async function reconcile(){
    if(!delivery||busy||editingReservation!==delivery.reservationId)return;setBusy(true);setNotice("");
    try{
      const response=await fetch("/api/conversations/reconcile",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({conversationId,reservationId:editingReservation,outcome,evidence,messageId:outcome==="accepted"?messageId:undefined})});
      const body=await response.json();if(!response.ok)throw Error(body.error??"Reconciliação não confirmada. Atualize para conferir.");
      setNotice("Reconciliação auditada. A operação original foi encerrada sem reenvio.");setOutcome("");setEvidence("");setMessageId("");
    }catch(e){setNotice(e instanceof Error?e.message:"Reconciliação não confirmada. Não reenvie.");}
    finally{setBusy(false);setRevision(n=>n+1);}
  }
  return <section aria-label="Estado persistente do envio" style={{minWidth:0,overflowWrap:"anywhere",padding:"12px 16px",borderBottom:"1px solid var(--border)",display:delivery||error||notice?"block":"none"}}>
    {error&&<p role="alert">{error}</p>}
    {delivery&&<>
      <strong>{delivery.status==="uncertain"?"Envio com resultado incerto":"Envio em andamento ou encerramento não confirmado"}</strong>
      <p>Novos envios e mudanças de responsável estão bloqueados. Não reenvie a mensagem.</p>
      {delivery.acceptedMessageId&&<p>A aceitação foi registrada pelo servidor; a persistência precisa de conferência. Isso não comprova entrega ao cliente.</p>}
      {!delivery.eligible&&<p>A tentativa ainda não tem encerramento comprovado. Esta tela não pode liberar o bloqueio, mesmo para administradores.</p>}
      {delivery.eligible&&!canReconcile&&<p>Solicite a conferência a um supervisor ou administrador.</p>}
      {delivery.eligible&&canReconcile&&<details key={delivery.reservationId} onToggle={event=>{if(event.currentTarget.open)setEditingReservation(delivery.reservationId);}}><summary>Reconciliar envio</summary>
        <p>Confira o registro externo antes de decidir. Se o resultado continuar desconhecido, mantenha o bloqueio. Ausência de recibo não comprova que a mensagem não saiu. Esta ação não envia mensagens nem repara o histórico.</p>
        <label className="field" style={{marginTop:12,gridTemplateColumns:"minmax(0, 1fr)"}}>Conclusão da conferência<select style={{minWidth:0}} aria-label="Conclusão da conferência" value={outcome} disabled={busy} onChange={e=>{setOutcome(e.target.value);setMessageId(delivery.acceptedMessageId??"");}}><option value="">Selecione uma conclusão comprovada</option><option value="accepted">Aceita pelo provedor</option>{!delivery.acceptedMessageId&&<option value="not_sent">Não enviada, com confirmação explícita do provedor</option>}</select></label>
        {outcome==="accepted"&&<label className="field" style={{marginTop:12,gridTemplateColumns:"minmax(0, 1fr)"}}>ID de aceitação<input style={{minWidth:0}} aria-label="ID de aceitação" maxLength={200} value={messageId} disabled={busy} onChange={e=>setMessageId(e.target.value)}/></label>}
        <label className="field" style={{marginTop:12,gridTemplateColumns:"minmax(0, 1fr)"}}>Referência da evidência<input style={{minWidth:0}} aria-label="Referência da evidência" value={evidence} disabled={busy} maxLength={500} placeholder="Protocolo da conferência; não inclua dados pessoais" onChange={e=>setEvidence(e.target.value)}/></label>
        <button type="button" className="button secondary" style={{marginTop:12,whiteSpace:"normal"}} disabled={busy||editingReservation!==delivery.reservationId||!outcome||evidence.trim().length<20||(outcome==="accepted"&&!messageId.trim())} onClick={()=>void reconcile()}>{busy?"Registrando…":"Registrar reconciliação sem reenviar"}</button>
      </details>}
    </>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
