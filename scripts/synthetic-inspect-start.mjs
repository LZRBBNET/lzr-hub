// Explicit operational entry only. Not referenced by package scripts/builds/default start.
import { fork } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectionPlan, assertInspectionLauncher, inspectOperational, report, validOid, MAX_INSPECTION_MS } from '../lib/platform/synthetic-operational-inspection.ts';
import { installSyntheticEgress } from '../lib/runtime/synthetic-egress.mjs';
import { runSyntheticWeb } from './synthetic-web.mjs';

export function projectReport(value,mode) {
 const states=['unknown','identity-observed','absence-observed','reservation-structural','completion-structural'];
 if(!value||typeof value!=='object'||!states.includes(value.state)||value.retryAllowed!==false||value.initializationAllowed!==false||value.credentialsVerified!==false||value.attemptReconciled!==false)return report('unknown');
 const hasOid=Object.hasOwn(value,'oid');
 if(Object.keys(value).sort().join(',')!==['state','retryAllowed','initializationAllowed','credentialsVerified','attemptReconciled',...(hasOid?['oid']:[])].sort().join(','))return report('unknown');
 if(value.state==='identity-observed')return mode==='identify'&&validOid(value.oid)?report(value.state,value.oid):report('unknown');
 if(hasOid||mode==='identify'&&value.state!=='unknown')return report('unknown');
 return report(value.state);
}
function workerEnvironment(source) {
 const allowed=['NODE_ENV','LZR_ENV','NEXT_PUBLIC_LZR_ENV','LZR_RUNTIME_MODE','PILOT_MODE','IXC_MODE','IXC_TRANSPORT','DEMO_DATASET','SYNTHETIC_WEB_DEMO','SYNTHETIC_DATABASE_CONFIRMATION','SYNTHETIC_DEMO_ORIGIN','SYNTHETIC_INIT_ENABLED','SYNTHETIC_BROWSER_SETUP_ENABLED','DATABASE_URL'];
 return Object.fromEntries(Object.entries(source).filter(([key,value])=>value!==undefined&&(allowed.includes(key)||key.startsWith('FEATURE_')||key.startsWith('SYNTHETIC_RO_INSPECTION_')||key==='IXC_WRITE_ENABLED')));
}
/** One child per process; stdout/stderr discarded. Only validated IPC survives closed child. */
export async function superviseInspection(source,plan,{spawn=fork,now=Date.now}={}) {
 if(now()+1000>=plan.expires)return report('outside-window');
 return new Promise(resolve=>{
  let child,timer,result=report('unknown'),messages=0,timedOut=false,invalid=false;
  try{
   child=spawn(fileURLToPath(import.meta.url),['--worker'],{execPath:process.execPath,execArgv:['--experimental-strip-types','--disable-warning=ExperimentalWarning'],env:workerEnvironment(source),stdio:['ignore','ignore','ignore','ipc']});
   timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},Math.max(1,Math.min(MAX_INSPECTION_MS-1000,plan.expires-now()-1000)));
   child.on('message',value=>{if(++messages!==1){invalid=true;child.kill('SIGKILL');return;}result=projectReport(value,plan.mode);});
   child.on('error',()=>{invalid=true;});
   child.on('close',code=>{clearTimeout(timer);resolve(timedOut?report('timeout'):invalid||code!==0?report('unknown'):result);});
  }catch{clearTimeout(timer);if(child){child.once('close',()=>resolve(report('unknown')));child.kill('SIGKILL');}else resolve(report('unknown'));}
 });
}
export async function assertInspectionArtifact() {
 const root=new URL('../work/synthetic-web/dist/',import.meta.url);
 const manifest=JSON.parse(await readFile(new URL('synthetic-web.json',root),'utf8'));
 if(manifest.kind!=='isolated-synthetic-node-v1')throw Error('SYNTHETIC_RO_REFUSED');
 await access(new URL('server/index.js',root));
}
export async function runInspectionStart(source,{artifact=assertInspectionArtifact,inspect=superviseInspection,start=()=>runSyntheticWeb('start'),emit=value=>console.log(JSON.stringify(value)),now=Date.now}={}) {
 // Launcher/security refusal is fatal and never reaches DB; diagnostic refusal is not a restart trigger.
 assertInspectionLauncher(source);await artifact();
 let result;
 try{const plan=inspectionPlan(source,now());result='state' in plan?plan:await inspect(source,plan);}catch{result=report('refused');}
 emit(result);assertInspectionLauncher(source);await start();
}
async function worker() {
 let client,result=report('unknown');
 try{
  const source=process.env,plan=inspectionPlan(source,Date.now());
  if('state' in plan)throw Error();
  installSyntheticEgress(source.DATABASE_URL);
  const {Client}=await import('pg');
  // Same explicitly private TCP contract as the existing synthetic target; no URL/PG option overrides.
  client=new Client({host:plan.host,port:5432,user:plan.user,password:plan.password,database:plan.database,ssl:false,
   options:'-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000',
   connectionTimeoutMillis:3000,query_timeout:3500,application_name:'synthetic_ro_inspection'});
  client.on('error',()=>{});
  if(Date.now()>=plan.expires)throw Error();
  await client.connect();result=await inspectOperational(client,plan);
 }catch{result=report('unknown');}
 finally{if(client){try{await client.end();}catch{result=report('unknown');}}}
 if(process.send)await new Promise(resolve=>process.send(result,()=>resolve()));
 process.disconnect?.();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const action=process.argv.length===3&&process.argv[2]==='--worker'&&process.send?worker:
  process.argv.length===2?()=>runInspectionStart(process.env):()=>Promise.reject(Error());
 action().catch(()=>{console.error('SYNTHETIC_RO_START_REFUSED');process.exitCode=1;});
}
