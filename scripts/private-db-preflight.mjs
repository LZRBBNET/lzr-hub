// Explicit private metadata diagnostic, never wired into build/default start.
import {fork} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspectionPlan,assertInspectionLauncher} from '../lib/platform/synthetic-operational-inspection.ts';
import {installSyntheticEgress} from '../lib/runtime/synthetic-egress.mjs';
import {assertInspectionArtifact} from './synthetic-inspect-start.mjs';
import {runSyntheticWeb} from './synthetic-web.mjs';
import {inspect,result,project} from '../lib/platform/private-db-preflight.mjs';
export function planFor(source,now=Date.now()){
 if(source.PRIVATE_DB_PREFLIGHT_ENABLED!=='true')throw Error('PREFLIGHT_DISABLED');
 const plan=inspectionPlan(source,now);if(plan.mode!=='inspect'||!plan.oid)throw Error('PREFLIGHT_REFUSED');return plan;
}
function environment(source){const exact=['DATABASE_URL','NODE_ENV','LZR_ENV','NEXT_PUBLIC_LZR_ENV','LZR_RUNTIME_MODE','PILOT_MODE','IXC_MODE','IXC_TRANSPORT','DEMO_DATASET','SYNTHETIC_WEB_DEMO','SYNTHETIC_DATABASE_CONFIRMATION','SYNTHETIC_DEMO_ORIGIN','SYNTHETIC_INIT_ENABLED','SYNTHETIC_BROWSER_SETUP_ENABLED','IXC_WRITE_ENABLED','PRIVATE_DB_PREFLIGHT_ENABLED'];return Object.fromEntries(Object.entries(source).filter(([k,v])=>v!==undefined&&(exact.includes(k)||k.startsWith('FEATURE_')||k.startsWith('SYNTHETIC_RO_INSPECTION_'))));}
export async function worker(source,{loadClient=async()=> (await import('pg')).Client,egress=installSyntheticEgress,now=Date.now}={}){
 let client,r=result('query-failed'),clientError=false;
 try{const p=planFor(source,now());egress(source.DATABASE_URL);const Client=await loadClient();client=new Client({host:p.host,port:5432,user:p.user,password:p.password,database:p.database,ssl:false,connectionTimeoutMillis:3000,query_timeout:3500,options:'-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000',application_name:'private_metadata_preflight'});client.on('error',()=>{clientError=true;});if(now()>=p.expires)throw Error('WINDOW_ENDED');await client.connect();r=await inspect(client,p,now);}catch{r=result('query-failed');}
 finally{if(client)try{await client.end();}catch{r=result('close-failed');}}
 return r.reason==='close-failed'?r:clientError?result('query-failed'):r;
}
export function supervise(source,{spawn=fork,now=Date.now}={}){
 let plan;try{plan=planFor(source,now());}catch{return Promise.resolve(result('refused'));}
 return new Promise(resolve=>{let child,message,messages=0,invalid=false,timed=false,timer;
 try{child=spawn(fileURLToPath(import.meta.url),['--worker'],{execPath:process.execPath,execArgv:['--experimental-strip-types'],env:environment(source),stdio:['ignore','ignore','ignore','ipc']});timer=setTimeout(()=>{timed=true;child.kill('SIGKILL');},Math.max(1,Math.min(20000,plan.expires-now())));child.on('message',v=>{messages++;if(messages!==1){invalid=true;child.kill('SIGKILL');}else message=project(v);});child.on('error',()=>{invalid=true;});child.on('close',code=>{clearTimeout(timer);resolve(timed?result('deadline'):invalid||code!==0?result('child-failed'):messages!==1?result('invalid-message'):message);});}catch{clearTimeout(timer);if(child){child.once('close',()=>resolve(result('child-failed')));child.kill('SIGKILL');}else resolve(result('child-failed'));}});
}
export async function start(source,{artifact=assertInspectionArtifact,inspect=supervise,run=()=>runSyntheticWeb('start'),emit=r=>console.log(JSON.stringify(r))}={}){assertInspectionLauncher(source);await artifact();let r=result('disabled');if(source.PRIVATE_DB_PREFLIGHT_ENABLED==='true')try{r=await inspect(source);}catch{r=result('query-failed');}else if(source.PRIVATE_DB_PREFLIGHT_ENABLED!==undefined&&source.PRIVATE_DB_PREFLIGHT_ENABLED!=='false')r=result('refused');emit(project(r));assertInspectionLauncher(source);await run();}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length===3&&process.argv[2]==='--worker'&&process.send){const r=await worker(process.env);await new Promise(resolve=>process.send(project(r),()=>resolve()));process.disconnect();}
 else if(process.argv.length===3&&process.argv[2]==='--start'){try{await start(process.env);}catch{console.error('PRIVATE_PREFLIGHT_START_REFUSED');process.exitCode=1;}}
 else if(process.argv.length===2){console.log(JSON.stringify(await supervise(process.env)));process.exitCode=2;}
 else process.exitCode=2;
}
