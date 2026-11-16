import {randomUUID} from 'node:crypto';
import {login,resolveSession,logout,changeOwnPassword,PasswordChangeError,SESSION_TTL_HOURS} from '../platform/auth.ts';
import {can} from '../platform/rbac.ts';
import {loginThrottle} from '../platform/login-throttle.ts';
import {loadConversationSummary} from '../platform/copilot-summary-service.ts';
import {changeConversationState} from '../platform/conversation-state-service.ts';
import {parsePromisedFor,reviewPendingPromises,PaymentPromiseValidationError} from '../platform/payment-promise-service.ts';
import {loadConfirmedReviewStatuses} from '../platform/payment-promise-evidence.ts';
import {businessToday} from '../platform/billing-service.ts';
import {loadFreshDispatchInvoices,excludePromiseHeldInvoices} from '../platform/collection-dispatch-source.ts';
import {resolveTodayCandidates,runTodayDispatch} from '../platform/collection-dispatch-service.ts';
import {conversationId,channel} from './state.mjs';
export const routes=new Map([['/api/auth/login',['POST']],['/api/auth/me',['GET']],['/api/auth/password',['POST']],['/api/auth/logout',['POST']],['/api/customers',['GET']],['/api/copilot',['POST']],['/api/conversations/state',['POST']],['/api/billing/promises',['GET','POST']],['/api/billing/collections/dispatch',['GET','POST']],['/api/demo/invoices',['POST']]]);
const headers={'cache-control':'no-store','x-robots-tag':'noindex, nofollow','referrer-policy':'no-referrer'};
const json=(data,status=200,extra={})=>Response.json(data,{status,headers:{...headers,...extra}});
const cookie=(token,seconds)=>`lzr_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
function tokenOf(request){const tokens=(request.headers.get('cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('lzr_session='));if(tokens.length!==1)return undefined;const value=tokens[0].slice(12);return /^[a-f0-9]{64}$/.test(value)?value:undefined;}
const fail=(error,status=400)=>json({error,synthetic:true,delivered:false},status);
async function handleRequest(request,state,config){
 const url=new URL(request.url),methods=routes.get(url.pathname);if(!methods)return fail('Fora desta demonstração',404);if(!methods.includes(request.method))return fail('Método indisponível',405);
 if(request.headers.get('host')!==config.host)return fail('Host não autorizado',403);
 if(request.method!=='GET'&&request.headers.get('origin')!==config.origin)return fail('Origem não autorizada',403);
 let body={};if(request.method==='POST'){if(!request.headers.get('content-type')?.startsWith('application/json'))return fail('JSON obrigatório',415);try{body=await request.json();}catch{return fail('JSON inválido');}if(!body||typeof body!=='object'||Array.isArray(body))return fail('Corpo inválido');}
 const token=tokenOf(request),user=await resolveSession(state.auth,token);
 if(url.pathname==='/api/auth/me')return json({authenticated:!!user,user:user??null,synthetic:true,volatile:true});
 if(url.pathname==='/api/auth/login'){
  if(typeof body.email!=='string'||typeof body.password!=='string'||body.email.length>254||body.password.length>256)return fail('Credenciais inválidas');
  // One bounded, fixed account scope; arbitrary input cannot grow the throttle map.
  const email=['supervisor@example.invalid','reader@example.invalid'].includes(body.email.toLowerCase())?body.email.toLowerCase():'unknown@example.invalid';
  const wait=loginThrottle.retryAfterSeconds(email,'memory-demo');if(wait)return fail('Tente novamente mais tarde',429);
  const logged=await login(state.auth,email,body.password);if(!logged){loginThrottle.recordFailure(email,'memory-demo');return fail('Credenciais inválidas',401);}loginThrottle.clear(email);
  return json({user:logged.user,mustChangePassword:logged.mustChangePassword,synthetic:true},200,{'set-cookie':cookie(logged.token,SESSION_TTL_HOURS*3600)});
 }
 if(!user)return fail('Sessão necessária',401);
 if(url.pathname==='/api/auth/logout'){await logout(state.auth,token);return json({ok:true},200,{'set-cookie':cookie('',0)});}
 if(url.pathname==='/api/auth/password'){
  if(typeof body.currentPassword!=='string'||typeof body.newPassword!=='string'||body.newPassword.length>256||body.currentPassword.length>256)return fail('Senha inválida');
  try{await changeOwnPassword(state.auth,user.id,token,body.currentPassword,body.newPassword);return json({ok:true});}catch(e){return fail(e instanceof PasswordChangeError?e.message:'Alteração indisponível');}
 }
 if(user.mustChangePassword)return fail('Troque a senha provisória',403);
 const permission=url.pathname==='/api/conversations/state'?'support.write':request.method==='POST'&&['/api/billing/promises','/api/billing/collections/dispatch','/api/demo/invoices'].includes(url.pathname)?'billing.write-demo':'customer.read';
 if(!can(user.role,permission))return fail('Perfil sem permissão',403);
 try{
  if(url.pathname==='/api/customers'){if(url.searchParams.get('id')!=='10')return fail('Cliente fictício não encontrado',404);const customer=await state.customers.get('10');return json({...customer,mode:'demo',synthetic:true,volatile:true});}
  if(url.pathname==='/api/copilot'){if(body.action!=='summary'||body.conversationId!==conversationId||body.channel!==channel)return fail('Resumo fictício indisponível',404);return json({summary:await loadConversationSummary(state.conversations,state.states,channel,conversationId),synthetic:true,llmExecuted:false});}
  if(url.pathname==='/api/conversations/state'){if(body.conversationId!==conversationId||!['claim','release','resolve','reopen'].includes(body.action))return fail('Ação indisponível');const changed=await changeConversationState(state.states,{channel,conversationId,action:body.action,takeOver:body.takeOver===true,actor:user});return json({...changed,synthetic:true,delivered:false},changed.ok?200:changed.status);}
  if(url.pathname==='/api/demo/invoices'){if(body.action!=='simulate_payment'||body.invoiceId!=='901')return fail('Somente pagamento fictício permitido');return json(state.demo.markPaid());}
  if(url.pathname==='/api/billing/promises'){
   if(request.method==='GET')return json({pending:await state.promises.listPending(),synthetic:true});
   if(body.action==='create'){
    if(body.customerId!=='10'||body.invoiceId!=='901'||typeof body.promisedFor!=='string')return fail('Referência fictícia inválida');
    const promisedFor=parsePromisedFor(body.promisedFor,new Date());const statuses=await loadConfirmedReviewStatuses('10',randomUUID(),()=>state.demo.provider);if(statuses.get('901')!=='A')return fail('Fatura aberta não confirmada',409);
    if((await state.promises.listPending()).some(p=>p.invoiceId==='901'&&p.customerId==='10'))return fail('Promessa pendente já existe',409);
    const created=await state.promises.create({invoiceId:'901',customerId:'10',promisedFor,registeredBy:user.email,correlationId:randomUUID()});return json(created,201);
   }
   if(body.action==='review'){
    const pending=await state.promises.listPending(),statuses=await loadConfirmedReviewStatuses('10',randomUUID(),()=>state.demo.provider);
    const reviewed=reviewPendingPromises(pending.filter(p=>p.customerId==='10'),statuses,businessToday(new Date()));
    const admitted=await resolveSession(state.auth,token);if(!admitted||admitted.id!==user.id||!can(admitted.role,'billing.write-demo'))return fail('Acesso alterado',403);
    for(const id of reviewed.fulfilled)await state.promises.updateStatus(id,'fulfilled');for(const id of reviewed.broken)await state.promises.updateStatus(id,'broken');return json(reviewed);
   }return fail('Ação indisponível');
  }
  if(url.pathname==='/api/billing/collections/dispatch'){
   const rule=await state.rules.getLatest(),now=new Date(),raw=await loadFreshDispatchInvoices(state.demo.provider,['10']),held=await excludePromiseHeldInvoices(raw,state.promises,now);
   if(request.method==='GET')return json({today:{scheduledFor:businessToday(now),candidates:resolveTodayCandidates(rule,held.invoices,now).length},pausedByPromise:held.paused,synthetic:true,delivered:false});
   if(body.action!=='run')return fail('Ação indisponível');
   return json({...await runTodayDispatch(rule,held.invoices,state.ledger,now,randomUUID()),pausedByPromise:held.paused,synthetic:true,delivered:false});
  }
 }catch(e){return fail(e instanceof PaymentPromiseValidationError?e.message:'Operação não confirmada',e instanceof PaymentPromiseValidationError?400:503);}
 return fail('Fora desta demonstração',404);
}

export async function handleApi(request,state,config){if(state.queued>=32)return fail('Demonstração ocupada',503);state.queued++;const pending=state.tail.then(async()=>{for(const [key,session] of state.auth.sessions)if(session.expiresAt<=new Date().toISOString())state.auth.sessions.delete(key);while(state.auth.sessions.size>=20)state.auth.sessions.delete(state.auth.sessions.keys().next().value);if(state.states.audits.length>100)state.states.audits.splice(0,state.states.audits.length-100);return handleRequest(request,state,config);});state.tail=pending.catch(()=>{});try{return await pending;}finally{state.queued--;}}
