import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {hashPassword} from '../../lib/platform/auth.ts';

export async function runHandoffBrowser({pool,dir,root,record}){
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);const password=randomBytes(24).toString('hex'),{hash,salt}=await hashPassword(password),now=new Date().toISOString();
 await pool.query("INSERT INTO users(id,email,name,role,password_hash,password_salt,created_at,updated_at) VALUES('visual-operator','visual@example.invalid','Operador Visual','Atendente',$1,$2,$3,$3)",[hash,salt,now]);
 await pool.query("INSERT INTO users(id,email,name,role,password_hash,password_salt,created_at,updated_at) VALUES('visual-supervisor','supervisor@example.invalid','Supervisor Visual','Supervisor',$1,$2,$3,$3)",[hash,salt,now]);
 await pool.query(`GRANT SELECT ON users,sessions,knowledge_documents,channel_contacts TO synthetic_delivery_runtime; GRANT INSERT,DELETE ON sessions TO synthetic_delivery_runtime; GRANT UPDATE(last_login_at,updated_at) ON users TO synthetic_delivery_runtime;`);
 for(const [phone,text]of [['5511999000001','Preciso de atendimento visual cabeado'],['5511999000002','Preciso de atendimento com resultado incerto']]){
  await pool.query("INSERT INTO channel_messages(id,channel,external_conversation_id,role,content,created_at) VALUES($1,'n8n-whatsapp',$1,'customer',$2,$3)",[phone,text,now]);
  await pool.query("INSERT INTO conversation_outcomes(id,channel,external_conversation_id,intent,final_status,handoff,handoff_reason,created_at,correlation_id) VALUES($1,'n8n-whatsapp',$1,'human_handoff','handoff',true,'customer_requested_human',$2,$1)",[phone,now]);
 }
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));const origin=`http://127.0.0.1:${port}`;
 const entry=join(dir,'visual-app.mjs');await writeFile(entry,`import {startProdServer} from ${JSON.stringify(join(root,'node_modules/vinext/dist/server/prod-server.js'))};let mode='success',calls=0;globalThis.fetch=async(url,options)=>{const u=new URL(String(url));if(u.hostname!=='graph.facebook.com'||!u.pathname.includes('/synthetic/messages'))throw Error('QA external transport blocked');calls++;if(mode==='timeout'){const e=Error('synthetic timeout');e.name='AbortError';throw e;}return new Response(JSON.stringify({messages:[{id:'synthetic-visual-'+calls}]}),{status:200,headers:{'content-type':'application/json'}});};process.on('message',m=>{if(m.mode)mode=m.mode;process.send({calls,mode});});await startProdServer({port:${port},host:'127.0.0.1',outDir:${JSON.stringify(join(root,'dist'))}});`);
 const app=spawn(process.execPath,[entry],{cwd:root,env:{PATH:process.env.PATH,LANG:'C.UTF-8',NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_COPILOT_LLM:'false',FEATURE_LLM_INTENT:'false',FEATURE_LANGFUSE:'false',FEATURE_N8N_CHANNEL:'false',FEATURE_N8N_AUTOREPLY:'false',FEATURE_ATTENDANT_REPLY:'true',META_ACCESS_TOKEN:'synthetic',META_PHONE_NUMBER_ID:'synthetic',IXC_MODE:'disabled',DATABASE_URL:`postgresql://synthetic_delivery_runtime@localhost/handoff_synthetic?host=${encodeURIComponent(dir)}`},stdio:['ignore','pipe','pipe','ipc']});app.stdout.on('data',()=>{});app.stderr.on('data',()=>{});
 const control=async mode=>{const response=once(app,'message');app.send(mode?{mode}:{});return (await response)[0];};
 let browser;try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(origin+'/login')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  assert.equal((await fetch(origin+'/api/conversations/reconcile?conversationId=5511999000002')).status,401);
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),violations=[];
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();violations.push(route.request().url());return route.abort();});
  await page.goto(origin+'/login');await page.getByLabel('E-mail',{exact:true}).fill('visual@example.invalid');await page.getByLabel('Senha',{exact:true}).fill(password);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL(origin+'/');
  const open=async text=>{await page.locator('a[href="#/atendimento"]').click();await page.locator('.inbox-item').filter({hasText:text}).click();};
  const summary=async()=>{const details=page.getByRole('button',{name:'Mostrar detalhes do cliente',exact:true});if(await details.getAttribute('aria-pressed')==='false')await details.click();await page.getByRole('tab',{name:'Copiloto',exact:true}).click();const response=page.waitForResponse(r=>r.url().endsWith('/api/copilot')&&r.request().postDataJSON()?.action==='summary');await page.getByRole('button',{name:'Resumir para transferir',exact:true}).click();const r=await response;assert.equal(r.status(),200);return (await r.json()).summary;};
  const send=async text=>{await page.getByLabel('Resposta ao cliente',{exact:true}).fill(text);const response=page.waitForResponse(r=>r.url().endsWith('/api/conversations/reply'));await page.getByRole('button',{name:'Enviar',exact:true}).click();return await response;};
  await open('Preciso de atendimento visual cabeado');const before=await summary();assert.match(before,/Cliente pediu atendente/);assert.match(before,/atendimento visual cabeado/);assert.match(before,/ainda não atribuído/);
  await page.screenshot({path:join(dir,'handoff-before.png'),fullPage:true});
  const sent=await send('Vamos verificar sua conexão cabeada.');assert.equal(sent.status(),200);assert.equal((await sent.json()).recorded,true);
  assert.equal((await pool.query("SELECT assignee_id FROM conversation_states WHERE channel='n8n-whatsapp' AND external_conversation_id='5511999000001'")).rows[0].assignee_id,'visual-operator');
  const after=await summary();assert.match(after,/Responsável atual: Operador Visual/);await page.getByText(/Responsável atual: Operador Visual/).waitFor();await page.screenshot({path:join(dir,'handoff-assigned.png'),fullPage:true});
  await page.setViewportSize({width:500,height:900});await page.waitForTimeout(400);await page.screenshot({path:join(dir,'handoff-mobile.png'),fullPage:true});const overflow=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));record('handoff_visual_mobile',{...overflow});await page.setViewportSize({width:1440,height:1000});
  await open('Preciso de atendimento com resultado incerto');await control('timeout');const failed=await send('Vou conferir sua conexão.');assert.equal(failed.status(),502);await page.getByText(/Não sei se a mensagem saiu/).waitFor();const firstCalls=(await control()).calls;const originalOperation=failed.request().postDataJSON();
  await page.getByText('Envio com resultado incerto',{exact:true}).waitFor();assert.equal(await page.getByText('Reconciliar envio',{exact:true}).count(),0);
  const repeat=await context.request.post(origin+'/api/conversations/reply',{data:{...originalOperation,idempotencyKey:'visual-repeat-new-key'}});assert.equal(repeat.status(),503);assert.equal((await control()).calls,firstCalls);
  const uncertain=await summary();assert.match(uncertain,/Responsável atual: Operador Visual/);
  // Native release cannot discard an uncertain delivery reservation.
  await page.reload();await open('Preciso de atendimento com resultado incerto');await page.getByText('Envio com resultado incerto',{exact:true}).waitFor();const release=page.waitForResponse(r=>r.url().endsWith('/api/conversations/state'));await page.getByRole('button',{name:'Devolver à IA',exact:true}).click();assert.equal((await release).status(),409);
  await page.getByText('A conversa mudou durante a ação. Atualize antes de tentar novamente.',{exact:true}).waitFor();await page.screenshot({path:join(dir,'handoff-uncertain.png'),fullPage:true});
  const status=await (await context.request.get(origin+'/api/conversations/reconcile?conversationId=5511999000002')).json();assert.equal(status.canReconcile,false);assert.equal(status.delivery.eligible,true);
  let resolution={conversationId:'5511999000002',reservationId:status.delivery.reservationId,outcome:'accepted',evidence:'Protocolo sintético de confirmação visual 20261106',messageId:'synthetic-visual-accepted'};
  assert.equal((await context.request.post(origin+'/api/conversations/reconcile',{data:resolution})).status(),403);
  const supervisor=await browser.newContext({viewport:{width:1440,height:1000}});await supervisor.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());const sp=await supervisor.newPage();
  await sp.goto(origin+'/login');await sp.getByLabel('E-mail',{exact:true}).fill('supervisor@example.invalid');await sp.getByLabel('Senha',{exact:true}).fill(password);await sp.getByRole('button',{name:'Entrar',exact:true}).click();await sp.waitForURL(origin+'/');await sp.locator('a[href="#/atendimento"]').click();await sp.locator('.inbox-item').filter({hasText:'Preciso de atendimento com resultado incerto'}).click();
  await sp.getByText('Reconciliar envio',{exact:true}).click();await sp.getByLabel('Conclusão da conferência',{exact:true}).selectOption('accepted');await sp.getByLabel('ID de aceitação',{exact:true}).fill(resolution.messageId);await sp.getByLabel('Referência da evidência',{exact:true}).fill(resolution.evidence);
  // Polling must never transfer evidence from reservation A to a later reservation B.
  assert.equal((await supervisor.request.post(origin+'/api/conversations/reconcile',{data:resolution})).status(),200);
  assert.equal((await context.request.post(origin+'/api/conversations/reply',{data:{...originalOperation,idempotencyKey:'visual-second-uncertain-operation'}})).status(),502);
  let changed=false;for(let attempt=0;attempt<60;attempt++){if(await sp.getByLabel('Referência da evidência',{exact:true}).inputValue()===''){changed=true;break;}await sp.waitForTimeout(100);}assert.equal(changed,true);
  assert.equal(await sp.getByRole('button',{name:'Registrar reconciliação sem reenviar',exact:true}).isVisible(),false);
  await sp.getByText('Reconciliar envio',{exact:true}).click();assert.equal(await sp.getByLabel('Conclusão da conferência',{exact:true}).inputValue(),'');assert.equal(await sp.getByLabel('Referência da evidência',{exact:true}).inputValue(),'');
  const replacementStatus=await (await supervisor.request.get(origin+'/api/conversations/reconcile?conversationId=5511999000002')).json();assert.notEqual(replacementStatus.delivery.reservationId,resolution.reservationId);resolution={...resolution,reservationId:replacementStatus.delivery.reservationId};
  await sp.getByLabel('Conclusão da conferência',{exact:true}).selectOption('accepted');await sp.getByLabel('ID de aceitação',{exact:true}).fill(resolution.messageId);await sp.getByLabel('Referência da evidência',{exact:true}).fill(resolution.evidence);
  await sp.screenshot({path:join(dir,'handoff-reconcile-form.png'),fullPage:true});
  await sp.setViewportSize({width:500,height:900});await sp.waitForTimeout(400);
  if(await sp.getByRole('button',{name:'Fechar detalhes',exact:true}).isVisible())await sp.getByRole('button',{name:'Fechar detalhes',exact:true}).click();
  await sp.waitForTimeout(250);
  await sp.getByLabel('Referência da evidência',{exact:true}).scrollIntoViewIfNeeded();
  await sp.screenshot({path:join(dir,'handoff-reconcile-mobile.png'),fullPage:true});
  assert.equal(await sp.evaluate(()=>document.documentElement.scrollWidth),500);
  const field=await sp.getByLabel('Referência da evidência',{exact:true}).boundingBox();assert.ok(field&&field.x>=0&&field.x+field.width<=500);
  await sp.screenshot({path:join(dir,'handoff-reconcile-mobile.png'),fullPage:true});
  record('reconciliation_visual_mobile',{width:500,scrollWidth:500,fieldWithinViewport:true});
  await sp.setViewportSize({width:1440,height:1000});
  await pool.query('REVOKE INSERT ON audit_events FROM synthetic_delivery_runtime');
  try{const rejected=sp.waitForResponse(r=>r.url().endsWith('/api/conversations/reconcile')&&r.request().method()==='POST');await sp.getByRole('button',{name:'Registrar reconciliação sem reenviar',exact:true}).click();assert.equal((await rejected).status(),503);await sp.getByText('Reconciliação não confirmada. Atualize para conferir; não reenvie a mensagem.',{exact:true}).waitFor();}finally{await pool.query('GRANT INSERT ON audit_events TO synthetic_delivery_runtime');}
  const confirmed=sp.waitForResponse(r=>r.url().endsWith('/api/conversations/reconcile')&&r.request().method()==='POST');await sp.getByRole('button',{name:'Registrar reconciliação sem reenviar',exact:true}).click();assert.equal((await confirmed).status(),200);await sp.getByText('Reconciliação auditada. A operação original foi encerrada sem reenvio.',{exact:true}).waitFor();
  await sp.screenshot({path:join(dir,'handoff-reconciled.png'),fullPage:true});
  const replay=await supervisor.request.post(origin+'/api/conversations/reconcile',{data:resolution});assert.equal(replay.status(),200);assert.equal((await replay.json()).duplicate,true);
  assert.equal((await context.request.post(origin+'/api/conversations/reply',{data:originalOperation})).status(),409);
  assert.equal((await pool.query("SELECT count(*) FROM audit_events WHERE action='conversation.delivery.reconciled' AND correlation_id=$1",[resolution.reservationId])).rows[0].count,'1');
  await supervisor.close();record('reconciliation_built_browser',{persistentAfterReload:true,attendantHTTP:403,supervisorForm:true,changedReservationClearsAndClosesForm:true,auditFailureHTTP:503,confirmedHTTP:200,replayOneAudit:true,originalSendKeyHTTP:409,transportCallsUnchanged:true});
  assert.equal(violations.length,0);assert.equal((await control()).calls,3);
  record('handoff_built_browser',{login:true,reason:true,context:true,unassignedThenAssigned:true,nativeComposer:true,successHTTP:200,timeoutHTTP:502,newClickBlockedHTTP:503,releaseBlockedHTTP:409,simulatedTransportCalls:3,realMessages:0,unexpectedBrowserRequests:0,manualReconciliationUIAvailable:true,screenshots:['handoff-before.png','handoff-assigned.png','handoff-mobile.png','handoff-uncertain.png']});
 }finally{if(browser)await browser.close();app.kill('SIGTERM');await once(app,'exit');}
}
