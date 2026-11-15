import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {statfs,lstat,readdir,mkdtemp,mkdir,chmod,chown,writeFile,unlink,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {environment,origin} from './environment.mjs';
import {grants} from './grants.mjs';
import {assertSyntheticWeb} from '../../lib/runtime/synthetic-web.ts';
import {createSyntheticInitializer} from '../../lib/platform/synthetic-initialization.ts';
import {hashPassword} from '../../lib/platform/auth.ts';
import {createAppStopper,childRunning,checkStop,withClosingClient} from './lifecycle.mjs';
import {loadSyntheticSchema} from '../prepare-synthetic-initialization.mjs';
const execute=promisify(execFile),root='/run/lzr';let owned,pgAttempted=false,app,stopping=false;
const clean={PATH:'/usr/local/bin:/usr/lib/postgresql/17/bin:/usr/bin:/bin',HOME:'/tmp',LANG:'C.UTF-8'};
const command=(bin,args)=>execute(bin,args,{env:clean,timeout:30000,maxBuffer:200000});
const postgres=args=>command('/usr/local/bin/gosu',['postgres',...args]);
const stopApp=createAppStopper();const ensureRunning=()=>checkStop(stopping);
const signal=()=>{stopping=true;stopApp(app);};process.once('SIGTERM',signal);process.once('SIGINT',signal);
try{
 assert.equal(process.getuid(),0);
 for(const key of Object.keys(process.env))if(!(key==='PGDATA'&&process.env[key]==='')&&/^(?:DATABASE_URL|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|PGDATA|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|POSTGRES_)/.test(key))throw Error('EXTERNAL_DATABASE_OR_RUNTIME_CONFIG_REFUSED');
 // The upstream image defines PGDATA. Dockerfile removes it; any caller override is refused.
 assert.equal((await statfs(root)).type,0x01021994);const rootStat=await lstat(root);assert.ok(rootStat.isDirectory()&&!rootStat.isSymbolicLink()&&rootStat.uid===0);
 assert.deepEqual(await readdir(root),[]);await chmod(root,0o711);owned=await mkdtemp(root+'/generation-');await chmod(owned,0o711);
 const data=owned+'/data',socket=owned+'/socket',pwfile=owned+'/bootstrap-password';await mkdir(data,{mode:0o700});await mkdir(socket,{mode:0o700});await chown(data,999,999);await chown(socket,999,999);
 const bootstrap=randomBytes(32).toString('hex'),runtime=randomBytes(32).toString('hex'),password=randomBytes(24).toString('hex');
 await writeFile(pwfile,bootstrap,{mode:0o600});await chown(pwfile,999,999);
 await postgres(['initdb','-D',data,'-U','lzr_synthetic_demo','--auth-local=scram-sha-256','--auth-host=scram-sha-256','--pwfile='+pwfile]);await unlink(pwfile);ensureRunning();
 pgAttempted=true;await postgres(['pg_ctl','-D',data,'-l',owned+'/socket/postgres.log','-o',`-h 127.0.0.1 -k ${socket} -p 5432 -c shared_buffers=32MB -c max_connections=20 -c work_mem=1MB -c log_statement=none -c log_min_messages=fatal -c log_min_error_statement=panic`,'-w','start']);ensureRunning();
 await withClosingClient(new pg.Client({connectionTimeoutMillis:3000,query_timeout:5000,host:'127.0.0.1',user:'lzr_synthetic_demo',password:bootstrap,database:'postgres'}),async admin=>{await admin.connect();ensureRunning();await admin.query('CREATE DATABASE lzr_synthetic_demo');});ensureRunning();
 const initUrl=`postgresql://lzr_synthetic_demo:${bootstrap}@127.0.0.1:5432/lzr_synthetic_demo`,source=environment(initUrl,origin);assertSyntheticWeb(source);
 await withClosingClient(new pg.Client({connectionString:initUrl,connectionTimeoutMillis:3000,query_timeout:5000}),async(client,close)=>{
  await client.connect();ensureRunning();const oid=(await client.query('SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()')).rows[0].oid;
  const files=await loadSyntheticSchema(),login=await hashPassword(password);ensureRunning();
  await createSyntheticInitializer()({query:(sql,args)=>client.query(sql,args),destroy:close},source,{databaseOid:oid,attempt:'synthetic-init-ephemeral-image',confirmation:'CREATE_EMPTY_SYNTHETIC_DATABASE_V1'},files,login,new Date());
 });ensureRunning();
 await withClosingClient(new pg.Client({connectionString:initUrl,connectionTimeoutMillis:3000,query_timeout:5000}),async owner=>{await owner.connect();ensureRunning();await owner.query(`CREATE ROLE lzr_demo_app LOGIN PASSWORD '${runtime}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);for(const sql of grants){ensureRunning();await owner.query(sql);}});ensureRunning();
 const url=`postgresql://lzr_demo_app:${runtime}@127.0.0.1:5432/lzr_synthetic_demo`;
 // Root-only, ephemeral operator/test material. Never emitted, never embedded in a layer.
 await writeFile(root+'/operator.json',JSON.stringify({password,url,generation:owned}),{mode:0o600});
 ensureRunning();
 app=spawn('/usr/local/bin/gosu',['10001:10001','/usr/local/bin/node','--experimental-strip-types','scripts/ephemeral/server.mjs'],{cwd:'/app',env:{...environment(url),PATH:clean.PATH,HOME:'/tmp'},stdio:['ignore','ignore','ignore']});
 await new Promise((resolve,reject)=>{app.once('error',reject);app.once('exit',(code)=>code===0||stopping?resolve():reject(Error('APP_STOPPED')));});
}catch{console.error('EPHEMERAL_DEMO_STOPPED');process.exitCode=1;}finally{
 if(childRunning(app))await new Promise(resolve=>{app.once('exit',resolve);stopApp(app);});
 let pgStopped=!pgAttempted;
 if(pgAttempted){
  try{await postgres(['pg_ctl','-D',owned+'/data','-m','immediate','-w','stop']);}catch{/* Verify authoritative status below even after uncertain start/stop. */}
  try{await postgres(['pg_ctl','-D',owned+'/data','status']);}catch(e){if(e.code===3)pgStopped=true;}
  if(!pgStopped)process.exitCode=1;
 }
 if(owned)await unlink(root+'/operator.json').catch(e=>{if(e.code!=='ENOENT')process.exitCode=1;});
 if(pgStopped&&owned&&owned.startsWith(root+'/generation-'))await rm(owned,{recursive:true,force:true}).catch(()=>{process.exitCode=1;});
}
