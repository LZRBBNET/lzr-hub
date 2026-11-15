// Real HTTPS browser -> synthetic application -> disposable PostgreSQL.
// No API doubles, public artifacts, operational integrations or inherited secrets.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, stat } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createServer as httpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { X509Certificate, randomBytes } from 'node:crypto';
import pg from 'pg';
import { manageProcessGroup, registerCleanup } from './qa-lifecycle.mjs';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';
import { hashPassword } from '../lib/platform/auth.ts';
import { loadSyntheticSchema } from './prepare-synthetic-initialization.mjs';
import { createSyntheticInitializer } from '../lib/platform/synthetic-initialization.ts';

const dir = process.env.LZR_GATE_DIR;
assert.ok(dir?.startsWith('/tmp/lzr-integrated-'));
const home = process.env.HOME;
assert.equal(process.getuid(), (await stat(home)).uid);
assert.notEqual(process.getuid(), 0);
assert.equal((await stat(home)).mode & 0o777, 0o700);
assert.ok(home.startsWith('/tmp/lzr-integrated-'));
const nss = join(home, '.local/share/pki/nssdb');
const cert = new X509Certificate(await readFile(join(dir, 'cert.pem')));
const origin = 'https://127.0.0.1:34443';
const clean = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home,'.config'), XDG_DATA_HOME: join(home,'.local/share'), LANG: 'C.UTF-8', LZR_GATE_DIR: dir };
const record = (check, extra = {}) => console.log(JSON.stringify({ check, ...extra, result: 'pass' }));
const run = (bin,args) => execFileSync(bin,args,{env:clean,stdio:['ignore','pipe','pipe'],timeout:10000});
const present = async path => stat(path).then(()=>true,()=>false);
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
let phase = process.argv[2], stage = 'preflight';

function appEnvironment(databaseUrl) {
  return {...clean,...stagingDemoRequirements,NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:origin,SYNTHETIC_INIT_ENABLED:'false',SYNTHETIC_BROWSER_SETUP_ENABLED:'false',FEATURE_N8N_AUTOREPLY:'false',FEATURE_ATTENDANT_REPLY:'false',FEATURE_LLM_INTENT:'false',FEATURE_COPILOT_LLM:'false',FEATURE_TELEGRAM_ALERTS:'false',DATABASE_URL:databaseUrl,PORT:'34444'};
}
async function browser() {
  const reservation=netServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const profile=await mkdtemp(join(dir,'browser-'));
  const child=spawn('/usr/bin/chromedriver',[`--port=${port}`,'--allowed-ips=127.0.0.1'],{env:clean,detached:true,stdio:['ignore','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  let session, failed=false;child.on('error',()=>{failed=true;});
  const request=async(path,body,method=body===undefined?'GET':'POST')=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const payload=await response.json();if(!response.ok||payload.value?.error){const error=Error('GATE_WEBDRIVER_COMMAND_FAILED');error.safeCode=['no such element','element click intercepted','stale element reference','javascript error','unknown command','invalid argument','timeout','element not interactable'].includes(payload.value?.error)?payload.value.error.replaceAll(' ','-'):'webdriver-other';error.certCode=payload.value?.message?.match(/net::(ERR_CERT_(?:AUTHORITY_INVALID|COMMON_NAME_INVALID|DATE_INVALID))/)?.[1];throw error;}return payload.value;
  };
  const close=manageProcessGroup(child,profile,async()=>{if(session)await request(`/session/${session}`,undefined,'DELETE');});
  try {
    let ready=false;for(let i=0;i<60&&!failed;i++){try{await request('/status');ready=true;break;}catch{await delay(100);}}assert.ok(ready);
    const created=await request('/session',{capabilities:{alwaysMatch:{browserName:'chrome',acceptInsecureCerts:false,'goog:chromeOptions':{binary:'/usr/bin/google-chrome',args:['--headless=new','--disable-background-networking','--no-first-run','--disable-dev-shm-usage',`--user-data-dir=${profile}`]}}}});
    session=created.sessionId;assert.equal(created.capabilities.acceptInsecureCerts,false);
    const command=(path,body,method)=>request(`/session/${session}${path}`,body,method);
    const evaluate=(script,args=[])=>command('/execute/sync',{script,args});
    await command('/url',{url:'chrome://sandbox'});
    const sandbox=await evaluate('return document.body.innerText');
    for(const name of ['Seccomp-BPF sandbox','PID namespaces','Network namespaces'])assert.match(sandbox,new RegExp(`${name}\\s+Yes`,'i'));
    return {command,evaluate,close};
  }catch(error){await close().catch(()=>{});throw error;}
}
async function serve(certName, keyName, handler, port=34443) {
  const server=httpsServer({cert:await readFile(join(dir,certName)),key:await readFile(join(dir,keyName))},handler);
  const ready=new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  await ready;
  let done;const close=()=>done??=new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
  const unregister=registerCleanup(close);return async()=>{await close();unregister();};
}
async function tlsCheck(name,certName,keyName,url,accepted) {
  stage=name;let hits=0, b;
  const stop=await serve(certName,keyName,(_,res)=>{hits++;res.writeHead(200,{'content-type':'text/html'});res.end('<title>LZR_TLS_GATE_OK</title><p>LZR_TLS_GATE_OK</p>');});
  try {
    b=await browser();let rejected=false,certificateCode;
    try{await b.command('/url',{url});}catch(error){rejected=true;certificateCode=error.certCode;}
    const body=await b.evaluate('return document.body?.innerText??""').catch(()=> '');
    if(accepted){assert.equal(rejected,false);assert.match(body,/LZR_TLS_GATE_OK/);assert.ok(hits>0);}
    else {assert.equal(hits,0);assert.doesNotMatch(body,/LZR_TLS_GATE_OK/);const expected=name.includes('expired')?'ERR_CERT_DATE_INVALID':name.includes('hostname')?'ERR_CERT_COMMON_NAME_INVALID':'ERR_CERT_AUTHORITY_INVALID';assert.ok(certificateCode===expected||body.includes(expected),'exact certificate rejection required, not unrelated TLS/connectivity failure');}
    record(name,{accepted,endpointHits:hits});
  }finally{if(b)await b.close();await stop();}
}
async function preflight() {
  assert.equal(await present(join(home,'.pki/nssdb')),false);
  assert.equal(await present(nss),false);
  assert.equal(cert.ca,false);assert.equal(cert.checkIP('127.0.0.1'),'127.0.0.1');assert.equal(cert.checkHost('localhost'),undefined);
  assert.ok(Date.parse(cert.validTo)-Date.now()>300000);assert.ok(Date.parse(cert.validTo)-Date.parse(cert.validFrom)<=600000);
  assert.ok(cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1'));
  const b=await browser();await b.close();record('isolated-user-browser-sandbox');
  await mkdir(nss,{recursive:true,mode:0o700});if(!await present(join(nss,'cert9.db')))run('certutil',['-N','--empty-password','-d',`sql:${nss}`]);
  run('certutil',['-A','-d',`sql:${nss}`,'-n','lzr-integrated-leaf','-t','P,,','-i',join(dir,'cert.pem')]);
  const exported=run('certutil',['-L','-d',`sql:${nss}`,'-n','lzr-integrated-leaf','-a']);assert.equal(new X509Certificate(exported).fingerprint256,cert.fingerprint256);
  assert.match(run('certutil',['-L','-d',`sql:${nss}`]).toString(),/lzr-integrated-leaf\s+P,,/);
  await writeFile(join(dir,'trust-fingerprint'),cert.fingerprint256,{mode:0o600});
  await tlsCheck('tls-exact-leaf','cert.pem','key.pem',origin,true);
  await tlsCheck('tls-different-leaf-refused','other-cert.pem','other-key.pem',origin,false);
  await tlsCheck('tls-hostname-refused','cert.pem','key.pem','https://localhost:34443',false);
  await writeFile(join(dir,'tls-preflight-passed'),'passed\n',{mode:0o600});
}
async function cleanup() {
  if(await present(nss)) {
    const raw=run('certutil',['-L','-d',`sql:${nss}`,'-n','lzr-integrated-leaf','-a']);
    assert.equal(new X509Certificate(raw).fingerprint256,cert.fingerprint256);
    run('certutil',['-D','-d',`sql:${nss}`,'-n','lzr-integrated-leaf']);
    assert.doesNotMatch(run('certutil',['-L','-d',`sql:${nss}`]).toString(),/lzr-integrated-leaf/);
    record('trust-fingerprint-removed');
  }
}
async function journey() {
  assert.equal((await readFile(join(dir,'tls-preflight-passed'),'utf8')).trim(),'passed');
  stage='postgres-connect';const config=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));
  assert.equal(config.host,'127.0.0.1');assert.equal(config.database,'lzr_synthetic_demo');assert.equal(config.user,'lzr_synthetic_demo');
  const url=`postgresql://${config.user}:${encodeURIComponent(config.password)}@127.0.0.1:${config.port}/${config.database}`;
  const env=appEnvironment(url),password=randomBytes(24).toString('hex'),nextPassword=randomBytes(24).toString('hex');
  const client=new pg.Client(config);await client.connect();
  assert.match((await client.query('SHOW server_version')).rows[0].server_version,/^17\./);
  const oid=(await client.query('SELECT oid::text FROM pg_database WHERE datname=current_database()')).rows[0].oid;
  stage='synthetic-initialization';
  await createSyntheticInitializer()({query:(sql,args)=>client.query(sql,args),destroy:()=>client.end()},env,{databaseOid:oid,attempt:'synthetic-init-integrated-ci-gate',confirmation:'CREATE_EMPTY_SYNTHETIC_DATABASE_V1'},await loadSyntheticSchema(),await hashPassword(password),new Date());
  record('postgres17-real-schema-and-fixtures');
  let pool=new pg.Pool(config), b, app, appClose, proxyClose;
  const start=async()=>{
    // Use the actual protected artifact + egress guard, but bind only loopback.
    const entry=join(dir,'server.mjs');
    await writeFile(entry,`import {installSyntheticEgress} from ${JSON.stringify(join(process.cwd(),'lib/runtime/synthetic-egress.mjs'))};\nimport {assertSyntheticWebDatabase} from ${JSON.stringify(join(process.cwd(),'lib/runtime/synthetic-web.ts'))};\nassertSyntheticWebDatabase(process.env);installSyntheticEgress(process.env.DATABASE_URL);\nconst {startProdServer}=await import(${JSON.stringify(join(process.cwd(),'node_modules/vinext/dist/server/prod-server.js'))});await startProdServer({port:34444,host:'127.0.0.1',outDir:${JSON.stringify(join(process.cwd(),'work/synthetic-web/dist'))}});`,{mode:0o600});
    const profile=await mkdtemp(join(dir,'app-'));
    app=spawn(process.execPath,['--experimental-strip-types',entry],{env,detached:true,stdio:['ignore','pipe','pipe']});app.stdout.resume();app.stderr.resume();
    appClose=manageProcessGroup(app,profile,async()=>{});
    let ready=false;for(let i=0;i<100;i++){try{const r=await fetch('http://127.0.0.1:34444/login',{signal:AbortSignal.timeout(500)});await r.arrayBuffer();if(r.status===200){ready=true;break;}}catch{}await delay(100);}assert.ok(ready,'app readiness');
  };
  const getBrowserTools=async()=>{
    b=await browser();const {command,evaluate}=b;
    const wait=async(expression)=>{for(let i=0;i<120;i++){if(await evaluate(`return Boolean(${expression})`))return;await delay(100);}throw Error('GATE_UI_WAIT_FAILED');};
    const api=async(path,body)=>{
      assert.ok(path.startsWith('/api/'));
      return command('/execute/async',{script:'const [path,body,done]=arguments; fetch(path,{method:body===null?"GET":"POST",headers:body===null?{}:{"content-type":"application/json"},...(body===null?{}:{body:JSON.stringify(body)})}).then(async r=>done({status:r.status,body:await r.json()})).catch(()=>done({status:0}));',args:[path,body??null]});
    };
    const click=async(selector)=>{const e=await command('/element',{using:'css selector',value:selector});await command(`/element/${e['element-6066-11e4-a52e-4f735466cecf']}/click`,{});};
    const fill=async(selector,text)=>{const e=await command('/element',{using:'css selector',value:selector});const id=e['element-6066-11e4-a52e-4f735466cecf'];await command(`/element/${id}/clear`,{});await command(`/element/${id}/value`,{text});};
    const button=async(text)=>{await wait("document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).every(a=>a.playState!=='running')");const e=await command('/element',{using:'xpath',value:`//button[normalize-space(.)='${text}' or @aria-label='${text}']`});await command(`/element/${e['element-6066-11e4-a52e-4f735466cecf']}/click`,{});};
    return {command,evaluate,wait,api,click,fill,button};
  };
  try {
    stage='app-start';await start();
    proxyClose=await serve('cert.pem','key.pem',(req,res)=>{
      const headers={...req.headers,host:'127.0.0.1:34443','x-forwarded-proto':'https','x-forwarded-host':'127.0.0.1:34443'};
      const upstream=httpRequest({host:'127.0.0.1',port:34444,path:req.url,method:req.method,headers},reply=>{res.writeHead(reply.statusCode,{...reply.headers,'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'self'"});reply.pipe(res);});
      upstream.on('error',()=>{res.writeHead(503);res.end();});req.pipe(upstream);
    });
    const t=await getBrowserTools();
    stage='login-cookie';await t.command('/url',{url:origin+'/login'});await t.wait("document.querySelector('#login-email')");
    await t.fill('#login-email','supervisor@example.invalid');await t.fill('#login-password',password);await t.button('Entrar');await t.wait("location.pathname==='/'");
    assert.equal((await t.api('/api/auth/me')).body.authenticated,true);
    const cookies=await t.command('/cookie');const cookie=cookies.find(x=>x.name==='lzr_session');assert.ok(cookie?.secure&&cookie.httpOnly);assert.equal(cookie.sameSite,'Lax');
    assert.equal((await t.api('/api/customers')).status,403);
    await t.wait("document.querySelector('dialog[open] input[autocomplete=current-password]')");
    await t.fill('dialog[open] input[autocomplete=current-password]',password);
    await t.fill('dialog[open] input[placeholder="mínimo 10 caracteres"]',nextPassword);
    await t.fill('dialog[open] label.field:last-of-type input',nextPassword);
    await t.button('Trocar senha');await t.wait("document.body.innerText.includes('Senha trocada.')");await t.button('Entrar');
    await t.wait("!document.querySelector('dialog[open]')");
    assert.equal((await t.api('/api/auth/me')).body.mustChangePassword,false);
    await t.command('/url',{url:origin+'/#/clientes'});await t.wait("document.querySelector('button.tr.stack-sm')");record('login-secure-cookie-and-password-change');
    stage='customer360';
    const customer=await t.api('/api/customers?id=10');assert.equal(customer.status,200);assert.equal(customer.body.customer.id,'10');
    for(const width of [1440,390]){
      stage=`customer360-${width}-resize`;
      await t.command('/goog/cdp/execute',{cmd:'Emulation.setDeviceMetricsOverride',params:{width,height:900,deviceScaleFactor:1,mobile:false}});
      stage=`customer360-${width}-open`;await t.command('/url',{url:origin+'/#/clientes'});await t.wait("document.querySelector('button.tr.stack-sm')");await t.click('button.tr.stack-sm');await t.wait("document.body.innerText.includes('Plano sintético')");
      assert.ok(await t.evaluate("return document.body.innerText.includes('Fonte sintética')"));
      assert.equal(await t.evaluate('return window.innerWidth'),width);
      assert.ok(await t.evaluate('return document.documentElement.scrollWidth<=document.documentElement.clientWidth'),'no horizontal overflow');stage=`customer360-${width}-close`;await t.button('Fechar');
      record('customer360-real-app-layout',{width});
    }
    stage='handoff';await t.command('/goog/cdp/execute',{cmd:'Emulation.setDeviceMetricsOverride',params:{width:1440,height:900,deviceScaleFactor:1,mobile:false}});
    await t.command('/url',{url:origin+'/#/atendimento'});await t.wait("document.querySelector('.inbox-item')");await t.click('.inbox-item');
    await t.wait("document.body.innerText.includes('fatura fictícia 901')");
    const summary=await t.api('/api/copilot',{action:'summary',channel:'n8n-whatsapp',conversationId:'synthetic-demo-customer-10',question:''});assert.equal(summary.status,200);assert.match(summary.body.summary,/Motivo do encaminhamento/);assert.match(summary.body.summary,/fatura fictícia 901/);assert.match(summary.body.summary,/Responsável atual/);
    await t.button('Assumir');await t.wait("document.querySelector('.chat-actions')?.textContent.includes('Com você')");
    const state=(await pool.query("SELECT * FROM conversation_states WHERE external_conversation_id='synthetic-demo-customer-10'")).rows[0];assert.equal(state.assignee_id,'synthetic-demo-supervisor');
    record('handoff-real-state-persisted',{context:true,owner:true});
    stage='billing-before-promise';let dispatch=await t.api('/api/billing/collections/dispatch');assert.equal(dispatch.status,200);assert.equal(dispatch.body.available,true);assert.equal(dispatch.body.today.candidates,1);
    // Actual UI creates the promise; no API fixtures injected.
    await t.command('/url',{url:origin+'/#/acoes-cobranca'});await t.wait("document.querySelector('[aria-label=Operação]')");await t.click('[aria-label=Operação] button:nth-child(3)');await t.wait("document.querySelector('input[type=date]')");
    await t.fill('input[placeholder="ex.: 4821"]','901');await t.fill('input[placeholder="ex.: 21857"]','10');
    const promised=new Date(Date.now()+86400000).toISOString().slice(0,10);
    await t.evaluate("const el=document.querySelector('input[type=date]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,arguments[0]);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true",[promised]);
    await t.button('Registrar promessa');await t.wait("document.querySelector('.row-main')?.textContent.includes('Fatura 901')");
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_promises WHERE invoice_id=$1 AND status=$2',['901','pending'])).rows[0].n,1);
    dispatch=await t.api('/api/billing/collections/dispatch');assert.equal(dispatch.body.today.candidates,0);assert.equal(dispatch.body.pausedByPromise,1);
    record('promise-real-ui-db-pauses-reminder');
    stage='payment';assert.equal((await t.api('/api/demo/invoices',{action:'simulate_payment',invoiceId:'901'})).status,200);
    const review=await t.api('/api/billing/promises',{action:'review'});assert.equal(review.status,200);assert.equal(review.body.fulfilled.length,1);
    dispatch=await t.api('/api/billing/collections/dispatch');assert.equal(dispatch.body.today.candidates,0);
    const run=await t.api('/api/billing/collections/dispatch',{action:'run'});assert.equal(run.status,200);assert.equal(run.body.candidates,0);assert.equal(run.body.enqueued,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM collection_dispatches')).rows[0].n,0);record('synthetic-payment-excludes-next-reminder',{delivery:false});
    // PG persistence is proved across connection/server restart by orchestrator's
    // restart handshake. Only authenticated state, not process-local invoice, persists.
    stage='restart';await appClose();await pool.end();
    await writeFile(join(dir,'restart-request'),'restart\n',{mode:0o600});
    let restarted=false;for(let i=0;i<600;i++){if(await present(join(dir,'restart-complete'))){restarted=true;break;}await delay(100);}assert.ok(restarted);
    pool=new pg.Pool(config);await start();
    assert.equal((await t.api('/api/auth/me')).body.authenticated,true);
    assert.equal((await pool.query('SELECT status FROM payment_promises WHERE invoice_id=$1',['901'])).rows[0].status,'fulfilled');
    assert.equal((await pool.query("SELECT assignee_id FROM conversation_states WHERE external_conversation_id='synthetic-demo-customer-10'")).rows[0].assignee_id,'synthetic-demo-supervisor');record('app-and-postgres-restart-persistence');
    // Synthetic invoice source is intentionally process-local, unlike promises.
    const resetCustomer=await t.api('/api/customers?id=10');assert.equal(resetCustomer.status,200);record('synthetic-invoice-source-process-local',{delivery:false});
    stage='logout';await t.command('/url',{url:origin+'/#/clientes'});await t.wait("document.querySelector('.app-shell')");await t.click('.user-trigger');
    const logout=await t.command('/element',{using:'xpath',value:"//*[@role='menuitem' and contains(.,'Sair')]"});await t.command(`/element/${logout['element-6066-11e4-a52e-4f735466cecf']}/click`,{});await t.wait("location.pathname==='/login'");
    assert.equal((await t.api('/api/customers')).status,401);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,0);record('logout-revoked-db-session');
    await writeFile(join(dir,'journey-passed'),'passed\n',{mode:0o600});
  }finally{if(b)await b.close();if(proxyClose)await proxyClose();if(appClose)await appClose();await pool.end().catch(()=>{});}
}
try {
  if(phase==='preflight')await preflight();
  else if(phase==='journey')await journey();
  else if(phase==='expiry'){
    assert.equal((await readFile(join(dir,'journey-passed'),'utf8')).trim(),'passed');
    const until=Date.parse(cert.validTo)+2000;assert.ok(until-Date.now()<540000);
    while(Date.now()<until)await delay(Math.min(1000,until-Date.now()));
    await tlsCheck('tls-same-leaf-expired-refused','cert.pem','key.pem',origin,false);
  }else if(phase==='cleanup')await cleanup();else throw Error('GATE_PHASE_INVALID');
}catch(error){const line=Number(error.stack?.match(/qa-integrated\.mjs:(\d+):/)?.[1]??0);console.error(JSON.stringify({gate:'integrated',phase,stage,result:'failed',error:error.safeCode,line,actual:typeof error.actual==='number'?error.actual:undefined,expected:typeof error.expected==='number'?error.expected:undefined}));process.exitCode=1;}
