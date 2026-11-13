// Regression for auth revocation after admission. Fresh disposable PostgreSQL only.
// PG_BIN=/path/to/bin NODE_PATH=./node_modules node tests/manual/reconciliation-revocation.mjs
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),require=createRequire(root+'/package.json');
const {Pool}=require('pg'),{drizzle}=require('drizzle-orm/node-postgres'),{migrate}=require('drizzle-orm/node-postgres/migrator'),{build}=require('esbuild');
const bin=process.env.PG_BIN;assert.ok(bin,'Explicit local PostgreSQL path required');
const dir=await mkdtemp(join(tmpdir(),'reconcile-revocation-')),data=join(dir,'data'),env={PATH:process.env.PATH,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
let pool,runtime,started=false;const results=[];
try{
 execFileSync(join(bin,'initdb'),['-D',data,'--auth=trust','--encoding=UTF8','--no-locale'],{env,stdio:'pipe'});
 execFileSync(join(bin,'pg_ctl'),['-D',data,'-l',join(dir,'postgres.log'),'-o',`-k ${dir} -h ''`,'-w','start'],{env,stdio:'pipe'});started=true;
 pool=new Pool({host:dir,user:process.env.USER||'agent',database:'postgres'});
 await pool.query('CREATE DATABASE revocation_synthetic');await pool.end();pool=new Pool({host:dir,user:process.env.USER||'agent',database:'revocation_synthetic'});
 await migrate(drizzle(pool),{migrationsFolder:root+'/drizzle'});
 await pool.query(`CREATE ROLE synthetic_revoke_runtime LOGIN;
 GRANT CONNECT ON DATABASE revocation_synthetic TO synthetic_revoke_runtime;
 GRANT USAGE ON SCHEMA public TO synthetic_revoke_runtime;
 GRANT SELECT ON users,sessions,channel_idempotency_keys,audit_events TO synthetic_revoke_runtime;
 GRANT UPDATE(last_login_at) ON users TO synthetic_revoke_runtime;
 GRANT UPDATE(expires_at) ON sessions TO synthetic_revoke_runtime;
 GRANT INSERT ON audit_events,channel_idempotency_keys TO synthetic_revoke_runtime;
 GRANT UPDATE(response_json),DELETE ON channel_idempotency_keys TO synthetic_revoke_runtime;`);
 runtime=new Pool({host:dir,user:'synthetic_revoke_runtime',database:'revocation_synthetic'});
 globalThis.__revocationDb=drizzle(runtime);process.env.FEATURE_AUTH='true';
 const bundled=await build({stdin:{contents:`export {POST} from './app/api/conversations/reconcile/route.ts';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',packages:'external',write:false,logLevel:'silent',plugins:[{name:'private-new-db',setup(b){b.onResolve({filter:/^(?:@\/db|(?:\.\.\/)+db\/index\.ts)$/},()=>({path:'synthetic',namespace:'qa'}));b.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:'export async function getDb(){return globalThis.__revocationDb}',loader:'js'}));}}]});
 const path=join(dir,'route.cjs');await writeFile(path,bundled.outputFiles[0].text);const {POST}=require(path);
 const now=new Date().toISOString();
 await pool.query("INSERT INTO users(id,email,name,role,password_hash,password_salt,active,created_at,updated_at) VALUES('qa-supervisor','supervisor@example.invalid','Synthetic supervisor','Supervisor','synthetic','synthetic',true,$1,$1)",[now]);
 const modes=['session_deleted','account_disabled','role_demoted','session_expired'];
 const cases=[...modes.map(mode=>({mode,wait:'body',replay:false})),...modes.map(mode=>({mode,wait:'advisory',replay:false})),{mode:'session_deleted',wait:'body',replay:true}];
 for(const [i,{mode,wait,replay}] of cases.entries()){
  await pool.query("UPDATE users SET active=true,role='Supervisor' WHERE id='qa-supervisor'");
  const token=randomUUID(),hash=createHash('sha256').update(token).digest('hex'),reservation=randomUUID(),phone='55110000000'+i,operation='reply:qa-revocation-'+i;
  await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES($1,$2,$3,$4)',[hash,'qa-supervisor',new Date(Date.now()+3600000).toISOString(),now]);
  const fence='delivery:'+createHash('sha256').update(JSON.stringify(['n8n-whatsapp',phone])).digest('hex');
  await pool.query('INSERT INTO channel_idempotency_keys(idempotency_key,channel,external_conversation_id,response_json,created_at) VALUES($1,$2,$3,$4,$5),($6,$2,$3,$7,$5)',[operation,'n8n-whatsapp',phone,JSON.stringify({status:'unknown'}),now,fence,JSON.stringify({status:'uncertain',workerSettled:true,operationKey:operation,token:reservation,kind:'human'})]);
  const body={conversationId:phone,reservationId:reservation,outcome:'not_sent',evidence:'Synthetic explicit provider confirmation reference'};
  const makeRequest=()=>new Request('http://127.0.0.1/api/conversations/reconcile',{method:'POST',headers:{cookie:'lzr_session='+token,'content-type':'application/json'},body:JSON.stringify(body)});
  if(replay){const initial=await POST(makeRequest());assert.equal(initial.status,200);}
  let entered,release;const bodyEntered=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const request=makeRequest();
  let blocker,pending,observedLock=false;
  if(wait==='body'){
   // Delay only parsing; the actual session guard and route execute unchanged.
   request.json=async()=>{entered();await gate;return body;};pending=POST(request);await bodyEntered;
  }else{
   blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[fence]);
   pending=POST(request);
   for(let attempt=0;attempt<80;attempt++){
    observedLock=Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE usename='synthetic_revoke_runtime' AND wait_event_type='Lock' AND query ILIKE '%pg_advisory_xact_lock%'")).rows[0].count)>0;
    if(observedLock)break;await new Promise(r=>setTimeout(r,10));
   }
   if(!observedLock){await blocker.query('ROLLBACK');blocker.release();await pending;throw Error('Request did not reach advisory lock');}
  }
  if(mode==='session_deleted')await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hash]);
  if(mode==='account_disabled')await pool.query("UPDATE users SET active=false WHERE id='qa-supervisor'");
  if(mode==='role_demoted')await pool.query("UPDATE users SET role='Atendente' WHERE id='qa-supervisor'");
  if(mode==='session_expired')await pool.query('UPDATE sessions SET expires_at=$2 WHERE token_hash=$1',[hash,new Date(Date.now()-1000).toISOString()]);
  if(wait==='body')release();else{await blocker.query('COMMIT');blocker.release();}
  const response=await pending;
  const remaining=Number((await pool.query('SELECT count(*) FROM channel_idempotency_keys WHERE idempotency_key=$1',[fence])).rows[0].count);
  const audits=Number((await pool.query("SELECT count(*) FROM audit_events WHERE action='conversation.delivery.reconciled' AND correlation_id=$1",[reservation])).rows[0].count);
  const fresh=await POST(new Request('http://127.0.0.1/api/conversations/reconcile',{method:'POST',headers:{cookie:'lzr_session='+token,'content-type':'application/json'},body:JSON.stringify(body)}));
  results.push({mode,wait,replay,observedLock,staleRequestStatus:response.status,remainingFence:remaining,audits,freshRequestStatus:fresh.status});
  assert.equal(response.status,mode==='role_demoted'?403:401);assert.equal(remaining,replay?0:1);assert.equal(audits,replay?1:0);assert.equal(fresh.status,mode==='role_demoted'?403:401);
 }
 await writeFile(join(dir,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({results,evidence:join(dir,'results.json'),syntheticOnly:true},null,2));
}finally{if(runtime)await runtime.end();if(pool)await pool.end();if(started)execFileSync(join(bin,'pg_ctl'),['-D',data,'-m','fast','-w','stop'],{env,stdio:'pipe'});}
