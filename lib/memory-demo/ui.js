const el=id=>document.getElementById(id);let user,epoch=0,busy=false,focusPending=false;
class StaleSession extends Error {}
const results=['customerResult','handoffResult','billingResult'];
function clearSession(){epoch++;user=null;busy=false;focusPending=false;for(const id of results)el(id).textContent='';for(const id of ['login','password'])el(id).reset();el('date').value='';message('');render();}
function focusEntry(){if(busy){focusPending=true;return;}focusPending=false;const target=!user?el('login').querySelector('input'):user.mustChangePassword?el('password').querySelector('input'):el('customer');target?.focus();}
async function api(path,body){const stamp=epoch;const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(stamp!==epoch)throw new StaleSession();if(r.status===401){clearSession();focusEntry();throw new StaleSession();}if(!r.ok)throw Error(data.error??'Operação indisponível');return data;}
function message(text){el('message').textContent=text;}
function render(){el('login').hidden=!!user;el('password').hidden=!user;el('logout').hidden=!user;el('panels').hidden=!user||user.mustChangePassword===true;for(const id of ['workspaceNav','journeyNav'])el(id).hidden=el('panels').hidden;el('identity').textContent=user?`${user.name} · ${user.role}`:'Sessão não iniciada';for(const button of document.querySelectorAll('button'))button.disabled=busy;for(const id of ['claim','release','promise','review','pay','dispatch'])el(id).disabled=busy||user?.role==='Somente leitura';for(const id of ['login','password','panels'])el(id).setAttribute('aria-busy',String(busy));}
async function session(){const data=await api('/api/auth/me');user=data.user;render();}
async function perform(action,success){if(busy)return;const stamp=epoch;busy=true;render();try{await action();if(stamp===epoch&&success)message(success);}catch(e){if(stamp===epoch&&!(e instanceof StaleSession)){message(e.message);el('message').focus();}}finally{if(stamp===epoch){busy=false;render();if(focusPending)focusEntry();}}}
function bind(id,action){el(id).addEventListener('click',()=>perform(action,'Operação concluída na demonstração.'));}
function show(id,text){el(id).textContent=text;}
const money=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}):'Não disponível';
const status=value=>({A:'Em aberto',R:'Pagamento confirmado',C:'Cancelada'}[value]??value??'Não disponível');
function customerText(data){const invoices=data.reading?.invoices??[],payments=data.reading?.payments??[],orders=data.reading?.serviceOrders??[];return [
 data.customer?.name??'Cliente fictício',
 `Contrato: ${data.contract?.id??'Não disponível'} · ${data.contract?.plan??'Plano não disponível'}`,
 `Mensalidade: ${money(data.contract?.monthlyValue)}`,
 `Conexão: ${data.network?.onuStatus??'Não disponível'} · ${data.network?.connectionType??''}`,
 `Tempo conectado: ${data.network?.uptime??'Não disponível'}`,
 '', 'Faturas',...invoices.map(i=>`#${i.id} · ${status(i.status)} · vencimento ${i.dueAt??'não informado'} · saldo ${money(i.openBalance)}`),
 '', 'Histórico de pagamentos',...(payments.length?payments.map(p=>`${p.paidOn} · ${money(p.value)} · fatura #${p.invoiceId}`):['Nenhum pagamento nesta amostra.']),
 '', 'Histórico de atendimento',...(orders.length?orders.map(o=>`${o.openedAt??'Sem data'} · ${o.subject} · ${o.status}`):['Nenhuma ordem nesta amostra.']),
 data.partial?'Algumas informações da amostra estão indisponíveis.':''
 ].filter(line=>line!==undefined).join('\n');}
function billingText(data){if(data.today)return [`Data da régua: ${data.today.scheduledFor}`,`Faturas elegíveis: ${data.today.candidates}`,`Pausadas por promessa: ${data.pausedByPromise??0}`,'Nenhuma mensagem foi enviada.'].join('\n');if(data.fulfilled)return [`Promessas cumpridas: ${data.fulfilled.length}`,`Promessas vencidas: ${data.broken.length}`,`Ainda pendentes: ${data.stillPending.length}`].join('\n');return [`Faturas elegíveis: ${data.candidates}`,`Etapas registradas na simulação: ${data.recorded??0}`,`Repetições ignoradas: ${data.duplicates??0}`,data.businessHour===false?'Fora do horário comercial: nenhuma etapa registrada.':'Etapa simulada concluída.','Nenhuma mensagem foi enviada.'].join('\n');}
for(const name of ['login','password'])el(name).addEventListener('submit',e=>{e.preventDefault();const form=e.currentTarget,stamp=epoch;void perform(async()=>{try{await api('/api/auth/'+name,Object.fromEntries(new FormData(form)));form.reset();await session();focusEntry();message(name==='login'&&user?.mustChangePassword?'Troque a senha provisória para continuar.':'Acesso atualizado.');}finally{if(stamp===epoch)for(const input of form.querySelectorAll('input[type=password]'))input.value='';}});});
bind('logout',async()=>{await api('/api/auth/logout',{});clearSession();focusEntry();message('Sessão encerrada.');});
bind('customer',async()=>show('customerResult',customerText(await api('/api/customers?id=10'))));
const summary=async()=>show('handoffResult',(await api('/api/copilot',{action:'summary',conversationId:'synthetic-demo-customer-10',channel:'n8n-whatsapp'})).summary);
bind('summary',summary);for(const action of ['claim','release'])bind(action,async()=>{await api('/api/conversations/state',{action,conversationId:'synthetic-demo-customer-10',takeOver:false});await summary();});
const preview=async()=>{const data=await api('/api/billing/collections/dispatch');show('billingResult',billingText(data));if(!el('date').value){const date=new Date(data.today.scheduledFor+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+1);el('date').value=date.toISOString().slice(0,10);}};
bind('preview',preview);bind('promise',async()=>{await api('/api/billing/promises',{action:'create',customerId:'10',invoiceId:'901',promisedFor:el('date').value});await preview();});bind('review',async()=>show('billingResult',billingText(await api('/api/billing/promises',{action:'review'}))));bind('pay',async()=>{await api('/api/demo/invoices',{action:'simulate_payment',invoiceId:'901'});const review=await api('/api/billing/promises',{action:'review'});const billing=await api('/api/billing/collections/dispatch');show('billingResult',billingText(review)+'\n\n'+billingText(billing));show('customerResult',customerText(await api('/api/customers?id=10')));});bind('dispatch',async()=>show('billingResult',billingText(await api('/api/billing/collections/dispatch',{action:'run'}))));
async function revalidate(){clearSession();await perform(async()=>{await session();focusEntry();});}
window.addEventListener('pagehide',()=>clearSession());
window.addEventListener('pageshow',()=>{void revalidate();});
// Clear cached state before revalidation, including returning from another tab.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')clearSession();else void revalidate();});
void revalidate();
