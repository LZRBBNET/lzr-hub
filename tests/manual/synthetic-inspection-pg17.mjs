// Explicit local reproduction only: never runs from the normal test glob/CI.
// Real locked pg driver, official pinned PostgreSQL17, no network or remote DB.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,chmod,writeFile,readFile,rm,access,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import pg from 'pg';
import {inspectOperational,report,unknownReport,IDENTITY_ONLY_SQL,TABLES_SQL,RESERVATION_SQL,COMPLETION_SQL,JOURNAL_SQL} from '../../lib/platform/synthetic-operational-inspection.ts';
import {EMPTY_SQL,RESERVED_EMPTY_SQL} from '../../lib/platform/synthetic-inspection-sql.ts';
import manifest from '../../lib/platform/synthetic-schema-manifest.json' with {type:'json'};
const require=createRequire(import.meta.url);
const IMAGE='docker.io/library/postgres@sha256:99d1a998c76487d3abb48b141505bda5dcf8089c0c4cd7be40f75de314fa32f0';
const OPTIONS='-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000';
const execute=promisify(execFile);
const dockerEnv=Object.fromEntries(['PATH','HOME'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const docker=(args)=>execute('docker',['--host','unix:///var/run/docker.sock',...args],{env:dockerEnv,timeout:20000,maxBuffer:1024*1024});
const results=[];
const record=(name,evidence={})=>{const row={name,...evidence};results.push(row);console.log(JSON.stringify(row));};
const allFalse=r=>{for(const key of ['retryAllowed','initializationAllowed','credentialsVerified','attemptReconciled'])assert.equal(r[key],false);};
const sourceRoot=resolve(import.meta.dirname,'../..');
if(process.argv.length!==3||process.argv[2]!=='--run')throw Error('Explicit --run required; never uses DATABASE_URL');
assert.equal(require('pg/package.json').version,'8.22.0');
const lock=JSON.parse(await readFile(join(sourceRoot,'package-lock.json'),'utf8'));assert.equal(lock.packages['node_modules/pg'].version,'8.22.0');
const dir=await mkdtemp(join(tmpdir(),'lzr-inspection-pg17-'));
const socketDir=join(dir,'socket');
const name='lzr-inspection-'+randomBytes(6).toString('hex');
const adminPassword=randomBytes(32).toString('hex'),ownerPassword=randomBytes(32).toString('hex');
const envFile=join(dir,'postgres.env');

let admin,stage='image',failure=false,interrupted=false,connectionCode='unclassified';
process.once('SIGTERM',()=>{interrupted=true;});process.once('SIGINT',()=>{interrupted=true;});
const base={host:socketDir,port:5432,ssl:false,connectionTimeoutMillis:1000,query_timeout:3500};
const owner='lzr_synthetic_demo';
const client=(database,ro=false)=>new pg.Client({...base,database,user:owner,password:ownerPassword,...(ro?{options:OPTIONS,application_name:'synthetic_ro_inspection'}:{application_name:'synthetic_fixture_setup'})});
const connect=async c=>{c.on('error',()=>{});await c.connect();return c;};
const digest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
const stamp='2026-01-01T00:00:00.000Z',attempt='synthetic-init-pg17-fixture';
const markReservation=async c=>{
 await c.query('CREATE TABLE public.synthetic_init_reservation (attempt text PRIMARY KEY, manifest text NOT NULL, created_at text NOT NULL)');
 await c.query('INSERT INTO public.synthetic_init_reservation (attempt,manifest,created_at) VALUES ($1,$2,$3)',[attempt,digest,stamp]);
};
const markCompletion=async c=>{
 await c.query('CREATE TABLE public.synthetic_init_completion (attempt text PRIMARY KEY, manifest text NOT NULL, completed_at text NOT NULL)');
 await c.query('INSERT INTO public.synthetic_init_completion (attempt,manifest,completed_at) VALUES ($1,$2,$3)',[attempt,digest,stamp]);
};
const markJournal=async c=>{
 await c.query('CREATE SCHEMA drizzle');
 await c.query('CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
 for(const m of manifest)await c.query('INSERT INTO drizzle.__drizzle_migrations (hash,created_at) VALUES ($1,$2)',[m.sha256,m.when]);
};
async function fullSchema(c){
 for(const m of manifest){
  const sql=await readFile(join(sourceRoot,'drizzle',m.name),'utf8');assert.equal(createHash('sha256').update(sql).digest('hex'),m.sha256);
  for(const statement of sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await c.query(statement);
 }
}
const cases=[
 ['blank',async()=>{},'absence-observed'],
 ['reservation',markReservation,'reservation-structural'],
 ['complete',async c=>{await markReservation(c);await fullSchema(c);await markJournal(c);await markCompletion(c);},'completion-structural'],
 ['extra_schema',c=>c.query('CREATE SCHEMA fictitious_extra'),['catalog','unexpected-inventory']],
 ['default_acl',c=>c.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC'),['catalog','unexpected-inventory']],
 ['extension',c=>c.query('CREATE EXTENSION hstore'),['catalog','unexpected-inventory']],
 ['completion_without_reservation',markCompletion,['catalog','marker-without-reservation']],
 ['completion_without_journal',async c=>{await markReservation(c);await markCompletion(c);},['catalog','completion-without-journal']],
 ['journal_without_completion',async c=>{await markReservation(c);await markJournal(c);},['catalog','journal-without-completion']],
 ['invalid_catalog_rls',async c=>{await markReservation(c);await c.query('ALTER TABLE public.synthetic_init_reservation ENABLE ROW LEVEL SECURITY');},['catalog','invalid-marker-catalog']],
 ['reserved_extra_inventory',async c=>{await markReservation(c);await c.query('CREATE SCHEMA fictitious_extra');},['catalog','unexpected-inventory']],
 ['marker_mismatch',async c=>{await markReservation(c);await c.query('UPDATE public.synthetic_init_reservation SET manifest=$1',['0'.repeat(64)]);},['reservation','marker-mismatch']],
 ['journal_mismatch',async c=>{await markReservation(c);await markJournal(c);await markCompletion(c);await c.query('DELETE FROM drizzle.__drizzle_migrations WHERE id=1');},['journal','journal-mismatch']],
];
try{
 assert.equal((await stat('/var/run/docker.sock')).isSocket(),true);
 await chmod(dir,0o700);await mkdir(socketDir,{mode:0o1777});await chmod(socketDir,0o1777);
 await writeFile(envFile,`POSTGRES_USER=qa_admin\nPOSTGRES_PASSWORD=${adminPassword}\nPOSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256\n`,{mode:0o600});
 const provenance=(await execute('git',['rev-parse','HEAD','HEAD^{tree}'],{cwd:sourceRoot,timeout:3000})).stdout.trim().split('\n');
 assert.ok(provenance.length===2&&provenance.every(v=>/^[a-f0-9]{40}$/.test(v)));
 record('provenance',{pass:true,head:provenance[0],tree:provenance[1],harnessSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex')});
 await docker(['image','inspect',IMAGE]);
 stage='container-create';
 await docker(['create','--name',name,'--network','none','--read-only','--security-opt','no-new-privileges:true','--log-driver','none','--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--tmpfs','/var/run/postgresql:rw,noexec,nosuid,size=16m','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=512m','--mount',`type=bind,source=${socketDir},target=/qa-socket`,'--env-file',envFile,IMAGE,'-c',"listen_addresses=",'-c','unix_socket_directories=/var/run/postgresql,/qa-socket','-c','log_statement=none','-c','log_min_messages=fatal','-c','log_min_error_statement=panic']);
 await docker(['start',name]);
 const inspected=JSON.parse((await docker(['inspect',name])).stdout)[0];
 assert.equal(inspected.HostConfig.NetworkMode,'none');assert.deepEqual(inspected.HostConfig.PortBindings,{});
 assert.equal(inspected.Mounts.filter(m=>m.Type==='volume').length,0);
 stage='socket-ready';
 for(let i=0;i<40;i++){
  assert.equal(interrupted,false);
  // Do not connect to the entrypoint's temporary initialization server.
  const mainProcess=(await docker(['exec',name,'cat','/proc/1/comm'])).stdout.trim();
  if(mainProcess!=='postgres'){await new Promise(r=>setTimeout(r,250));continue;}
  const c=new pg.Client({...base,user:'qa_admin',password:adminPassword,database:'postgres'});c.on('error',()=>{});
  try{await c.connect();admin=c;break;}catch(error){connectionCode=['ENOENT','EACCES','ECONNREFUSED','28P01','28000','3D000','57P03'].includes(error.code)?error.code:'unclassified';await c.end().catch(()=>{});await new Promise(r=>setTimeout(r,250));}
 }
 if(!admin){
  const data=JSON.parse((await docker(['inspect',name])).stdout)[0].State;
  const socketPresent=await stat(join(socketDir,'.s.PGSQL.5432')).then(s=>s.isSocket(),()=>false);
  let insideReady=false;try{await docker(['exec',name,'pg_isready','-h','/qa-socket','-U','qa_admin','-d','postgres']);insideReady=true;}catch{/* no raw logs */}
  record('socket-readiness-diagnostic',{pass:false,running:data.Running===true,exitCode:Number.isInteger(data.ExitCode)?data.ExitCode:null,oomKilled:data.OOMKilled===true,hostSocketPresent:socketPresent,insideReady,connectionCode});
 }
 assert.ok(admin,'Local socket must be ready');
 const version=(await admin.query('SHOW server_version_num')).rows[0].server_version_num;assert.ok(Number(version)>=170000&&Number(version)<180000);
 await admin.query(`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
 record('runtime',{pass:true,postgresMajor:17,pgDriver:'8.22.0',network:'none',transport:'local-unix-socket'});
 const sqlHash=createHash('sha256').update(JSON.stringify([IDENTITY_ONLY_SQL,TABLES_SQL,RESERVATION_SQL,COMPLETION_SQL,JOURNAL_SQL,EMPTY_SQL,RESERVED_EMPTY_SQL])).digest('hex');
 assert.equal(sqlHash,'61fa22c4fea7088ebf88793d4b036e950b1732f6c3cc54cd5732daeae6c61bf9');
 for(const [label,setup,expected]of cases){
  assert.equal(interrupted,false);stage=label;const database='inspection_'+label;
  await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
  let setupClient,ro;
  try{
   stage=label+':fixture-connect';setupClient=await connect(client(database));await setup(setupClient);await setupClient.end();setupClient=undefined;
   stage=label+':readonly-connect';ro=await connect(client(database,true));
   stage=label+':settings';assert.equal((await ro.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
   assert.equal((await ro.query('SHOW search_path')).rows[0].search_path,'pg_catalog');
   assert.equal((await ro.query('SHOW statement_timeout')).rows[0].statement_timeout,'3s');
   assert.equal((await ro.query('SHOW lock_timeout')).rows[0].lock_timeout,'1s');
   assert.equal((await ro.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout,'5s');
   stage=label+':oid-type';const oid=(await ro.query(IDENTITY_ONLY_SQL)).rows[0].oid;assert.equal(typeof oid,'string');
   stage=label+':count-type';const objects=(await ro.query(EMPTY_SQL)).rows[0].objects;assert.equal(typeof objects,'number');
   stage=label+':table-types';const tables=(await ro.query(TABLES_SQL)).rows;
   for(const t of tables){assert.equal(typeof t.rls,'boolean');assert.equal(typeof t.kind,'string');}
   const now=Date.now(),config={mode:'inspect',host:'local-socket-only',database,user:owner,password:ownerPassword,oid,expires:now+60000};
   stage=label+':inspection-result';const observed=await inspectOperational(ro,config);allFalse(observed);
   assert.deepEqual(observed,Array.isArray(expected)?unknownReport(...expected):report(expected));
   record(label,{pass:true,state:observed.state,...(observed.phase?{phase:observed.phase,reason:observed.reason}:{}),objectsType:'number',...(tables.length?{rlsType:'boolean',kindType:'string'}:{})});
   await ro.end();ro=undefined;
   if(label==='blank'){
    ro=await connect(client(database,true));
    await assert.rejects(ro.query('CREATE TABLE public.forbidden_write(id integer)'),e=>e.code==='25006');
    const pinned=await inspectOperational(ro,{...config,oid:'1'});assert.deepEqual(pinned,unknownReport('identity','identity-mismatch'));allFalse(pinned);await ro.end();
    ro=await connect(client(database,true));let calls=0;
    const expired=await inspectOperational({query:async sql=>{calls++;return ro.query(sql);}},{...config,expires:now},()=>now);
    assert.deepEqual(expired,unknownReport('transaction','deadline'));assert.equal(calls,0);allFalse(expired);
    record('readonly-pin-deadline',{pass:true,writeRejected:true,wrongPinRejected:true,expiredQueryCount:0});
   }
  }finally{if(ro)await ro.end().catch(()=>{});if(setupClient)await setupClient.end().catch(()=>{});}
  await admin.query(`DROP DATABASE ${database}`);
 }
}catch{
 failure=true;record('failure',{pass:false,stage,details:'raw error suppressed'});
}finally{
 if(admin)await admin.end().catch(()=>{failure=true;});
 let containerRemoved=false,filesRemoved=false;
 try{
  // Query succeeds or cleanup remains unconfirmed; daemon errors are not absence.
  const matching=async()=> (await docker(['ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}'])).stdout.trim();
  const before=await matching();assert.ok(before===''||before===name);
  if(before===name)await docker(['rm','-f','-v',name]);
  assert.equal(await matching(),'');containerRemoved=true;
 }catch{/* Preserve failure, never infer resource absence from command error. */}
 try{
  await rm(dir,{recursive:true,force:true});
  try{await access(dir);}catch(error){if(error.code==='ENOENT')filesRemoved=true;}
 }catch{/* A failed deletion is not a successful absence check. */}
 const cleanup=containerRemoved&&filesRemoved;
 record('cleanup',{pass:cleanup,containerRemoved,socketAndCredentialsRemoved:filesRemoved});
 if(!cleanup||interrupted)failure=true;
 const evidence=join(sourceRoot,'work','inspection-pg17-results.json');await mkdir(join(sourceRoot,'work'),{recursive:true});
 await writeFile(evidence,JSON.stringify({syntheticOnly:true,remoteAccess:false,productionChanged:false,results},null,2)+'\n');
}
process.exitCode=failure?1:0;
