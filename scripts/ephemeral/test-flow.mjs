import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {environment,origin} from './environment.mjs';
import {assertSyntheticWeb} from '../../lib/runtime/synthetic-web.ts';
const material=JSON.parse(await readFile('/run/lzr/operator.json','utf8'));
const {password,url}=material,nextPassword=randomBytes(24).toString('hex'),env=environment(url);
let cookie='',stage='start';const record=stage=>console.log(JSON.stringify({stage,pass:true}));
async function api(path,body,extra={}){const r=await fetch('http://127.0.0.1:34444'+path,{method:body?'POST':'GET',headers:{host:'127.0.0.1:34443','x-forwarded-proto':'https','x-forwarded-host':'127.0.0.1:34443',origin,cookie,'content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const data=await r.json().catch(()=>null);return {status:r.status,data};}
try{
 stage='old-session';let old;try{old=await readFile('/run/lzr/old-session','utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(old){cookie=old;assert.equal((await api('/api/customers?id=10')).status,401);cookie='';record('old-session-invalid');}
 stage='origin-negative';assert.ok([400,403].includes((await api('/api/auth/login',{email:'supervisor@example.invalid',password},{origin:'https://other.invalid'})).status));record('wrong-origin-refused');
 stage='https-config-negative';assert.throws(()=>assertSyntheticWeb({...env,SYNTHETIC_DEMO_ORIGIN:'http://127.0.0.1:34443'}));record('http-origin-configuration-refused');
 stage='login';assert.equal((await api('/api/auth/login',{email:'supervisor@example.invalid',password})).status,200);assert.ok(cookie.startsWith('lzr_session='));assert.equal((await api('/api/auth/me')).data.authenticated,true);record('authenticated-login');
 stage='password';assert.equal((await api('/api/auth/password',{currentPassword:password,newPassword:nextPassword})).status,200);record('password-change');
 stage='customer360';const customer=await api('/api/customers?id=10');assert.equal(customer.status,200);assert.equal(customer.data.customer.id,'10');record('customer360-real-api');
 stage='handoff-context';const summary=await api('/api/copilot',{action:'summary',channel:'n8n-whatsapp',conversationId:'synthetic-demo-customer-10',question:''});assert.equal(summary.status,200);assert.match(summary.data.summary,/Motivo do encaminhamento/);assert.match(summary.data.summary,/Responsável atual/);record('handoff-context-real-api');
 stage='handoff-claim';const claim=await api('/api/conversations/state',{conversationId:'synthetic-demo-customer-10',action:'claim',takeOver:false});assert.equal(claim.status,200);assert.equal(claim.data.state.assigneeId,'synthetic-demo-supervisor');record('handoff-owner-claimed-real-api');
 stage='collections';const dispatch=await api('/api/billing/collections/dispatch');assert.equal(dispatch.status,200);assert.equal(dispatch.data.today.candidates,1);record('collection-candidate-real-api');
 stage='promise';assert.equal((await api('/api/billing/promises',{action:'create',invoiceId:'901',customerId:'10',promisedFor:new Date(Date.now()+86400000).toISOString().slice(0,10)})).status,201);const paused=await api('/api/billing/collections/dispatch');assert.equal(paused.data.today.candidates,0);assert.equal(paused.data.pausedByPromise,1);record('promise-pauses-reminder');
 stage='payment';assert.equal((await api('/api/demo/invoices',{action:'simulate_payment',invoiceId:'901'})).status,200);assert.equal((await api('/api/billing/promises',{action:'review'})).data.fulfilled.length,1);const final=await api('/api/billing/collections/dispatch',{action:'run'});assert.equal(final.status,200);assert.equal(final.data.candidates,0);assert.equal(final.data.enqueued,0);record('paid-excluded-without-delivery');

 stage='runtime-privileges';const client=new pg.Client({connectionString:url});await client.connect();
 const role=(await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(Object.values(role),[false,false,false,false,false]);
 for(const sql of ["CREATE TABLE public.denied_fixture(id integer)","CREATE SCHEMA denied_fixture","CREATE ROLE denied_fixture","ALTER TABLE public.users OWNER TO lzr_demo_app","SELECT pg_catalog.pg_read_file('/etc/passwd')","SET ROLE lzr_synthetic_demo","SELECT rolpassword FROM pg_catalog.pg_authid","UPDATE public.users SET role='admin' WHERE id='synthetic-demo-supervisor'","SELECT * FROM public.synthetic_init_reservation","CREATE TEMP TABLE denied_fixture(id integer)"]){await assert.rejects(client.query(sql),e=>e.code==='42501');}
 await client.end();record('runtime-ddl-admin-escalation-refused');
 stage='os-separation';const execute=promisify(execFile);const probe=await execute('/usr/local/bin/gosu',['10001:10001','/usr/local/bin/node','--input-type=module','-e',`import fs from 'node:fs';let denied=0;for(const p of ['/run/lzr/operator.json',${JSON.stringify(material.generation+'/data/PG_VERSION')}]){try{fs.readFileSync(p);}catch(e){if(e.code==='EACCES')denied++;}}if(denied!==2)process.exitCode=1;`],{env:{PATH:'/usr/local/bin:/usr/bin:/bin'},timeout:10000});assert.equal(probe.stdout,'');record('app-os-admin-files-refused');
 await writeFile('/run/lzr/test-session',cookie,{mode:0o600});assert.equal((await stat('/run/lzr/test-session')).mode&0o777,0o600);
 const observed={};for(const key of ['memory.max','memory.current','memory.peak','memory.swap.max','cpu.max']){const v=(await readFile('/sys/fs/cgroup/'+key,'utf8')).trim();assert.match(v,/^(?:[0-9 ]+|max)$/);observed[key]=v;}
 console.log(JSON.stringify({stage:'resource-observation',pass:true,resourceGate:'unverified',visibleScope:'unattributed',freeViabilityProven:false,observed}));
}catch(e){console.log(JSON.stringify({stage,pass:false,reason:['ENOENT','EACCES','EROFS','ERR_ASSERTION','42501'].includes(e.code)?e.code:'other'}));process.exitCode=1;}
