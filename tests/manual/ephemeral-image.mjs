// Explicit local image build/test. No registry push, remote DB, or public ports.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm,writeFile,readFile,access,chmod} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {buildContext} from '../../scripts/ephemeral/context.mjs';
if(process.argv[2]!=='--run')throw Error('Explicit --run required');
const execute=promisify(execFile),suffix=randomBytes(6).toString('hex'),image='lzr-ephemeral-local:'+suffix,name='lzr-image-'+suffix,hostile=name+'-hostile';
const temporary=await mkdtemp('/tmp/lzr-image-test-');await chmod(temporary,0o700);await mkdir(temporary+'/docker-config',{mode:0o700});let context,stage='context',failed=false,interrupted=false,cleaning=false;
process.once('SIGTERM',()=>{interrupted=true;});process.once('SIGINT',()=>{interrupted=true;});
const deadline=Date.now()+1200000;
const docker=args=>execute('docker',['--host','unix:///var/run/docker.sock',...args],{env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_CONFIG:temporary+'/docker-config'},timeout:cleaning?30000:Math.max(1000,Math.min(600000,deadline-Date.now())),maxBuffer:50*1024*1024});
const evidence=[];const record=row=>{evidence.push(row);console.log(JSON.stringify(row));};
const ready=async()=>{for(let i=0;i<120;i++){assert.ok(Date.now()<deadline&&!interrupted);try{await docker(['exec','--user','10001:10001',name,'node','-e',"fetch('http://127.0.0.1:34444/login').then(r=>{if(r.status!==200)process.exitCode=1}).catch(()=>process.exitCode=1)"]);return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('READINESS_FAILED');};
try{
 context=await buildContext();record({stage,pass:true});
 const head=(await execute('git',['rev-parse','HEAD','HEAD^{tree}'])).stdout.trim().split('\n');record({stage:'provenance',pass:true,head:head[0],tree:head[1],dockerfileSha256:createHash('sha256').update(await readFile('deploy/ephemeral/Dockerfile')).digest('hex')});
 stage='build';await docker(['build','--pull=false','--tag',image,'--file',context+'/deploy/ephemeral/Dockerfile',context]);record({stage,pass:true});
 stage='preload-refusal';await docker(['create','--name',hostile,'--network','none','--read-only','--env','NODE_OPTIONS=--require=/app/scripts/ephemeral/preload-canary.cjs',image]);await docker(['start','--attach',hostile]).catch(()=>{});const denied=JSON.parse((await docker(['inspect',hostile])).stdout)[0];assert.equal(denied.State.ExitCode,78);const logs=(await docker(['logs',hostile])).stderr;assert.ok(logs.includes('EPHEMERAL_EXTERNAL_RUNTIME_REFUSED'));assert.ok(!logs.includes('EPHEMERAL_PRELOAD_EXECUTED'));await docker(['rm','-v',hostile]);record({stage,pass:true});
 stage='create';await docker(['create','--name',name,'--network','none','--read-only','--security-opt','no-new-privileges:true','--log-driver','none','--memory','512m','--memory-swap','512m','--cpus','0.1','--pids-limit','128','--tmpfs','/run/lzr:rw,nosuid,noexec,size=192m,mode=0700','--tmpfs','/tmp:rw,nosuid,noexec,size=32m,mode=1777','--tmpfs','/var/lib/postgresql/data:rw,nosuid,noexec,size=1m',image]);
 const inspected=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(inspected.HostConfig.NetworkMode,'none');assert.deepEqual(inspected.HostConfig.PortBindings,{});assert.ok(inspected.Mounts.every(m=>m.Type!=='bind'&&m.Type!=='volume'));record({stage:'no-host-mounts-or-network',pass:true});
 for(let cycle=1;cycle<=2;cycle++){
  stage='start-'+cycle;await docker(cycle===1?['start',name]:['restart',name]);await ready();record({stage,pass:true});
  if(cycle===2)await docker(['cp',temporary+'/session',name+':/run/lzr/old-session']);
  stage='flow-'+cycle;const result=await docker(['exec','--workdir','/app',name,'node','--experimental-strip-types','scripts/ephemeral/test-flow.mjs']);
  for(const line of result.stdout.trim().split('\n')){const row=JSON.parse(line);assert.ok(typeof row.stage==='string'&&typeof row.pass==='boolean');assert.ok(Object.keys(row).every(k=>['stage','pass','reason','resourceGate','visibleScope','freeViabilityProven','observed'].includes(k)));record({cycle,...row});assert.ok(row.pass);}
  if(cycle===1){await docker(['cp',name+':/run/lzr/test-session',temporary+'/session']);await chmod(temporary+'/session',0o600);}
 }
 record({stage:'outcome',pass:false,functionalPass:true,resourceGate:'unverified',freeViabilityProven:false});
}catch(error){failed=true;if(stage==='build'){const text=String(error.stderr)+String(error.stdout);record({stage:'build-diagnostic',pass:false,steps:text.split('\n').filter(l=>/^#[0-9]+ \[/.test(l)).map(l=>l.replace(/https?:\/\/[^ ]+/g,'<endpoint>')).slice(-4),errors:text.split('\n').filter(l=>l.startsWith('ERROR:')).map(l=>l.replace(/https?:\/\/[^ ]+/g,'<endpoint>').replace(/127\.0\.0\.1:[0-9]+/g,'localhost:<port>').replace(/\/tmp\/[^ :]+/g,'<temporary-path>').replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]+/g,'<ip>:<port>')).slice(-2)});}record({stage,pass:false,reason:['ENOENT','EACCES','ERR_ASSERTION'].includes(error.code)?error.code:stage==='build'?['not supported','permission denied','connection refused','failed to dial','not found','buildx','buildkit','403 Forbidden','401 Unauthorized','failed to solve'].find(x=>(String(error.stderr)+String(error.stdout)).includes(x))??'unclassified-build':'other'});if(error.stdout)for(const line of error.stdout.trim().split('\n')){try{const row=JSON.parse(line);if(Object.keys(row).every(k=>['stage','pass','reason'].includes(k))&&typeof row.stage==='string'&&typeof row.pass==='boolean')record(row);}catch{}}}
finally{
 cleaning=true;let containers=true,files=true,imageRemoved=false;
 for(const target of [name,hostile])try{const listing=async()=>(await docker(['ps','-a','--filter',`name=^/${target}$`,'--format','{{.Names}}'])).stdout.trim();const found=await listing();assert.ok(found===''||found===target);if(found)await docker(['rm','-f','-v',target]);assert.equal(await listing(),'');}catch{containers=false;}
 try{const listing=(await docker(['image','ls','--filter','reference='+image,'--format','{{.Repository}}:{{.Tag}}'])).stdout.trim();if(listing){assert.equal(listing,image);await docker(['image','rm',image]);}assert.equal((await docker(['image','ls','--filter','reference='+image,'--format','{{.Repository}}:{{.Tag}}'])).stdout.trim(),'');imageRemoved=true;}catch{}
 for(const path of [context,temporary].filter(Boolean))try{await rm(path,{recursive:true,force:true});try{await access(path);files=false;}catch(e){if(e.code!=='ENOENT')files=false;}}catch{files=false;}
 record({stage:'cleanup',pass:containers&&files&&imageRemoved,containersRemoved:containers,filesRemoved:files,imageRemoved});
 if(!containers||!files||!imageRemoved||interrupted)failed=true;
 await writeFile('/workspace/evidence/ephemeral-image-results.json',JSON.stringify(evidence,null,2)+'\n');
}process.exitCode=failed?1:0;
