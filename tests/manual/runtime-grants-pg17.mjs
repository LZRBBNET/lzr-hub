// Explicit cached-PG17 host-mounted role/API test; not image validation. No builds, pulls, remote DB or public ports.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm,writeFile,readFile,access,chmod,cp,symlink,readdir,realpath} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {captureSession,restoreSession} from './private-session-transfer.mjs';
import {buildContext} from '../../scripts/ephemeral/context.mjs';
if(!process.argv.includes('--run'))throw Error('Explicit --run required');
const execute=promisify(execFile),suffix=randomBytes(6).toString('hex'),image='docker.io/library/postgres@sha256:99d1a998c76487d3abb48b141505bda5dcf8089c0c4cd7be40f75de314fa32f0',name='lzr-runtime-grants-'+suffix;
const deliveryBaseline=process.argv.includes('--delivery-baseline'),baseline=process.argv.includes('--baseline')||deliveryBaseline;
const temporary=await mkdtemp('/tmp/lzr-runtime-grants-');await chmod(temporary,0o700);await mkdir(temporary+'/docker-config',{mode:0o700});let retainedSession,context,stage='context',failed=false,interrupted=false,cleaning=false;
process.once('SIGTERM',()=>{interrupted=true;});process.once('SIGINT',()=>{interrupted=true;});
const deadline=Date.now()+1200000;
const docker=args=>execute('docker',['--host','unix:///var/run/docker.sock',...args],{env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_CONFIG:temporary+'/docker-config'},timeout:cleaning?30000:Math.max(1000,Math.min(600000,deadline-Date.now())),maxBuffer:50*1024*1024});
const evidence=[];const record=row=>{evidence.push(row);console.log(JSON.stringify(row));};
const artifactDigest=async()=>{const entries=[];async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=dir+'/'+item.name;if(item.isDirectory())await walk(path);else entries.push([path,createHash('sha256').update(await readFile(path)).digest('hex')]);}}await walk('work/synthetic-web/dist');entries.sort((a,b)=>a[0].localeCompare(b[0]));return createHash('sha256').update(JSON.stringify(entries)).digest('hex');};
const ready=async()=>{for(let i=0;i<120;i++){assert.ok(Date.now()<deadline&&!interrupted);try{await docker(['exec','--user','10001:10001',name,'node','-e',"fetch('http://127.0.0.1:34444/login').then(r=>{if(r.status!==200)process.exitCode=1}).catch(()=>process.exitCode=1)"]);return;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error('READINESS_FAILED');};
try{
 context=await buildContext();record({stage,pass:true});
 const head=(await execute('git',['rev-parse','HEAD','HEAD^{tree}'])).stdout.trim().split('\n');record({stage:'provenance',pass:true,head:head[0],tree:head[1],artifactSha256:await artifactDigest(),contextHelperSha256:createHash('sha256').update(await readFile('scripts/ephemeral/context.mjs')).digest('hex'),grantsSha256:createHash('sha256').update(await readFile('scripts/ephemeral/grants.mjs')).digest('hex'),transferSha256:createHash('sha256').update(await readFile('tests/manual/private-session-transfer.mjs')).digest('hex'),harnessSha256:createHash('sha256').update(await readFile('tests/manual/runtime-grants-pg17.mjs')).digest('hex'),probeSha256:createHash('sha256').update(await readFile('tests/manual/runtime-grants-probe.mjs')).digest('hex'),supervisorSha256:createHash('sha256').update(await readFile('scripts/ephemeral/supervisor.mjs')).digest('hex'),dockerfileSha256:createHash('sha256').update(await readFile('deploy/ephemeral/Dockerfile')).digest('hex')});
 stage='cached-image';const cached=JSON.parse((await docker(['image','inspect',image])).stdout)[0];assert.ok(cached.RepoDigests.some(d=>d.endsWith('@sha256:99d1a998c76487d3abb48b141505bda5dcf8089c0c4cd7be40f75de314fa32f0')));record({stage,pass:true});
 await cp('work/synthetic-web/dist',context+'/work/synthetic-web/dist',{recursive:true});
 await mkdir(context+'/tests/manual',{recursive:true});await cp('tests/manual/runtime-grants-probe.mjs',context+'/tests/manual/runtime-grants-probe.mjs');
 const dependencies=await realpath('node_modules');const lock=JSON.parse(await readFile('package-lock.json','utf8'));assert.equal(JSON.parse(await readFile(dependencies+'/pg/package.json','utf8')).version,lock.packages['node_modules/pg'].version);await cp(dependencies,temporary+'/dependencies/node_modules',{recursive:true});await symlink('/dependencies/node_modules',context+'/node_modules');
 await execute('chmod',['-R','a+rX',context,temporary+'/dependencies']);
 stage='create';await docker(['create','--pull=never','--workdir','/app','--name',name,'--network','none','--read-only','--security-opt','no-new-privileges:true','--log-driver','none','--memory','512m','--memory-swap','512m','--cpus','0.1','--pids-limit','128','--tmpfs','/run/lzr:rw,nosuid,noexec,size=192m,mode=0700','--tmpfs','/tmp:rw,nosuid,noexec,size=32m,mode=1777','--tmpfs','/var/lib/postgresql/data:rw,nosuid,noexec,size=1m','--mount',`type=bind,source=${context},target=/app,readonly`,'--mount',`type=bind,source=${temporary}/dependencies/node_modules,target=/dependencies/node_modules,readonly`,'--mount',`type=bind,source=${process.execPath},target=/usr/local/bin/node,readonly`,'--env','PGDATA=','--entrypoint','/bin/sh',image,'/app/scripts/ephemeral/entrypoint.sh']);
 const inspected=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(inspected.HostConfig.NetworkMode,'none');assert.deepEqual(inspected.HostConfig.PortBindings,{});assert.ok(inspected.Mounts.every(m=>m.Type!=='volume'));assert.ok(inspected.Mounts.filter(m=>m.Type==='bind').every(m=>m.RW===false));record({stage:'readonly-host-prototype-no-network',pass:true,imageValidation:false});
 for(let cycle=1;cycle<=(baseline?1:2);cycle++){
  stage='start-'+cycle;await docker(cycle===1?['start',name]:['restart',name]);await ready();record({stage,pass:true});
  if(cycle===2){stage='restore-private-session';await restoreSession(name,{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_CONFIG:temporary+'/docker-config'},retainedSession);retainedSession=undefined;}
  stage='repository-grants-'+cycle;const probe=await docker(['exec','--workdir','/app',name,'node','--experimental-strip-types','tests/manual/runtime-grants-probe.mjs',...(baseline?[deliveryBaseline?'--delivery-baseline':'--baseline']:[])]);for(const line of probe.stdout.trim().split('\n')){const row=JSON.parse(line);record({cycle,...row});assert.ok(row.pass);}
  if(baseline)continue;
  stage='flow-'+cycle;const result=await docker(['exec','--workdir','/app',name,'node','--experimental-strip-types','scripts/ephemeral/test-flow.mjs']);
  for(const line of result.stdout.trim().split('\n')){const row=JSON.parse(line);assert.ok(typeof row.stage==='string'&&typeof row.pass==='boolean');assert.ok(Object.keys(row).every(k=>['stage','pass','reason','resourceGate','visibleScope','freeViabilityProven','observed'].includes(k)));record({cycle,...row});assert.ok(row.pass);}
  if(cycle===1){stage='capture-private-session';retainedSession=await captureSession(name,{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_CONFIG:temporary+'/docker-config'});}
 }
 record({stage:'outcome',scope:'host-mounted-runtime-only',status:baseline?'baseline-reproduced':'functional-only',pass:true,baselineReproduced:baseline,functionalPass:!baseline,imageValidation:false,resourceGate:'unverified',freeViabilityProven:false});
}catch(error){failed=true;record({stage,pass:false,reason:['ENOENT','EACCES','ERR_ASSERTION'].includes(error.code)?error.code:'other'});if(error.stdout)for(const line of error.stdout.trim().split('\n')){try{const row=JSON.parse(line);if(Object.keys(row).every(k=>['stage','pass','reason'].includes(k))&&typeof row.stage==='string'&&typeof row.pass==='boolean')record(row);}catch{}}}
finally{
 retainedSession?.fill(0);retainedSession=undefined;cleaning=true;let containers=true,files=true,imageRemoved=false;
 for(const target of [name])try{const listing=async()=>(await docker(['ps','-a','--filter',`name=^/${target}$`,'--format','{{.Names}}'])).stdout.trim();const found=await listing();assert.ok(found===''||found===target);if(found)await docker(['rm','-f','-v',target]);assert.equal(await listing(),'');}catch{containers=false;}
 imageRemoved=true; // cached official image retained deliberately
 for(const path of [context,temporary].filter(Boolean))try{await rm(path,{recursive:true,force:true});try{await access(path);files=false;}catch(e){if(e.code!=='ENOENT')files=false;}}catch{files=false;}
 record({stage:'cleanup',pass:containers&&files&&imageRemoved,containersRemoved:containers,filesRemoved:files,cachedImageRetained:imageRemoved});
 if(!containers||!files||!imageRemoved||interrupted)failed=true;
 await writeFile('/workspace/evidence/runtime-grants-'+(deliveryBaseline?'delivery-baseline':baseline?'baseline':'final')+'.json',JSON.stringify(evidence,null,2)+'\n');
}process.exitCode=failed?1:0;
