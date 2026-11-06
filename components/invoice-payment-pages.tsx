"use client";
import {useEffect,useRef,useState} from 'react';
type Page={customerId:string;invoiceId:string;scope:'invoice-page';mode:'staging-readonly';page:number;pageSize:number;total:number|null;hasMore:boolean|null;observedAt:string;items:Array<{id:string;invoiceId:string;paidAt:string|null;method:string;value:number|null}>};
type Props={customerId:string;invoiceId:string};
export function InvoicePaymentPages(props:Props){return <InvoicePaymentPageState key={`${props.customerId}:${props.invoiceId}`} {...props}/>;}
function InvoicePaymentPageState({customerId,invoiceId}:Props){
  const[data,setData]=useState<Page|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const requests=useRef({generation:0,busy:false,controller:null as AbortController|null});
  useEffect(()=>{const state=requests.current;return()=>{state.generation++;state.controller?.abort();};},[]);
  async function load(page:number){
    const state=requests.current;if(state.busy)return;state.busy=true;const sequence=++state.generation;state.controller?.abort();const abort=new AbortController();state.controller=abort;setData(null);setError(null);setBusy(true);
    try{const response=await fetch(`/api/customers/payments?id=${encodeURIComponent(customerId)}&invoiceId=${encodeURIComponent(invoiceId)}&page=${page}`,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:abort.signal});
      const next=await response.json();if(sequence!==state.generation)return;
      if(response.status===429)throw Error("RATE_LIMITED");
      if(!response.ok||next.mode!=='staging-readonly'||next.scope!=='invoice-page'||next.customerId!==customerId||next.invoiceId!==invoiceId||next.page!==page||next.pageSize!==10||!Array.isArray(next.items)||next.items.length>10||(next.total!==null&&(!Number.isSafeInteger(next.total)||next.total<0))||![true,false,null].includes(next.hasMore)||typeof next.observedAt!=='string'||next.items.some((item:Page['items'][number])=>item.invoiceId!==invoiceId||typeof item.id!=='string'||(item.value!==null&&(typeof item.value!=='number'||!Number.isFinite(item.value)||item.value<0))))throw Error('Unconfirmed page');setData(next);
    }catch(error){if(sequence===state.generation)setError(error instanceof Error&&error.message==="RATE_LIMITED"?"Limite temporário de consultas. Aguarde um minuto.":"Página não confirmada. Nenhuma ação de pagamento foi executada.");}finally{if(sequence===state.generation){state.busy=false;setBusy(false);}}
  }
  return <div className="invoice-payments"><button className="button ghost small" type="button" disabled={busy} onClick={()=>void load(1)}>{busy?'Consultando…':'Consultar pagamentos desta fatura'}</button>
    {error&&<p role="alert">{error}</p>}
    {data&&data.customerId===customerId&&data.invoiceId===invoiceId&&<section aria-label={`Pagamentos da fatura ${invoiceId}`}><p>Página {data.page}: {data.items.length} registro(s). Total informado nesta fatura: {data.total??'não confirmado'}. Não é o histórico total do cliente.</p>
      {data.items.length===0?<p>Nenhum registro nesta página.</p>:<ul>{data.items.map(item=><li key={item.id}>Pagamento {item.id} · {item.paidAt??'Data não confirmada'} · {item.value===null?'Valor não confirmado':`R$ ${item.value.toFixed(2).replace('.',',')}`} · {item.method}</li>)}</ul>}
      <button type="button" className="button ghost small" disabled={busy||data.page<=1} onClick={()=>void load(data.page-1)}>Anterior</button><button type="button" className="button ghost small" disabled={busy||data.hasMore!==true||data.page>=1000} onClick={()=>void load(data.page+1)}>Próxima</button>
      <p className="hint">Leitura por página, sem somar pagamentos nem confirmar quitação. Os dados podem mudar entre páginas; não é uma consulta transacional. Consulta em {data.observedAt}.</p>
    </section>}
  </div>;
}
