import {NextResponse} from 'next/server';
import {randomUUID} from 'node:crypto';
import {createPaymentDiagnostic} from '@/lib/integrations/ixc/payment-diagnostics';
import {authorize} from '@/lib/platform/session-guard';
import {getIxcRuntime} from '@/lib/integrations/ixc/runtime';
import {logUnauthenticatedAction} from '@/lib/platform/audit-log';
const headers={'cache-control':'private, no-store','referrer-policy':'no-referrer'};
export async function GET(request:Request){
  const guard=await authorize(request,'customer.read');
  if(!guard.allowed)return NextResponse.json({error:guard.error},{status:guard.status,headers});
  if(!guard.user)return NextResponse.json({error:'Autenticação obrigatória.'},{status:503,headers});
  const params=new URL(request.url).searchParams;
  const id=params.get('id')??'',invoiceId=params.get('invoiceId')??'',rawPage=params.get('page')??'';
  if([...params.keys()].some(key=>!['id','invoiceId','page'].includes(key))||['id','invoiceId','page'].some(key=>params.getAll(key).length!==1)||!/^[1-9]\d{0,31}$/.test(id)||!/^[1-9]\d{0,31}$/.test(invoiceId)||!/^[1-9]\d{0,3}$/.test(rawPage)||Number(rawPage)>1000)return NextResponse.json({error:'Consulta de pagamentos inválida.'},{status:400,headers});
  const diagnostic=createPaymentDiagnostic();
  try{
    const {provider}=getIxcRuntime();if(!provider){diagnostic.finish('unavailable');return NextResponse.json({error:'Fonte IXC indisponível.'},{status:503,headers});}
    const result=await provider.getInvoicePaymentPage(id,invoiceId,Number(rawPage),randomUUID(),diagnostic.progress);
    diagnostic.progress("response-identity","identity");
    if(result.customerId!==id||result.invoiceId!==invoiceId||result.page!==Number(rawPage)||result.scope!=='invoice-page')throw Error('Unconfirmed page identity');
    diagnostic.progress("audit","serialization");
    await logUnauthenticatedAction({action:'customer360.invoice.payments.view',entity:`customer:${id}:invoice:${invoiceId}`,result:'success',reason:'Consulta de página de pagamentos da fatura',actor:guard.user});
    diagnostic.progress("response","serialization");
    const response=NextResponse.json({...result,mode:'staging-readonly',observedAt:new Date().toISOString()},{headers});
    diagnostic.finish('success');
    return response;
  }catch(error){
    diagnostic.finish('failure',error);
    const forbidden=error instanceof Error&&error.name==='IxcCustomerNotAllowedError';
    const limited=error instanceof Error&&['IXC_RATE_LIMITED','IXC_HTTP_429'].includes(error.message);
    return NextResponse.json({error:forbidden?'Cadastro fora do escopo autorizado.':limited?'Limite temporário de consultas. Aguarde um minuto.':'Não foi possível confirmar a página de pagamentos.'},{status:forbidden?403:limited?429:503,headers:limited?{...headers,'retry-after':'60'}:headers});
  }
}
