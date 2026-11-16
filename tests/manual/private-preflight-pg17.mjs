// Explicit cache-only local PG17 transaction experiment. No app or external delivery.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,realpath,copyFile,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const exec=promisify(execFile),image='docker.io/library/postgres@sha256:99d1a998c76487d3abb48b141505bda5dcf8089c0c4cd7be40f75de314fa32f0';
if(process.argv.length!==3||process.argv[2]!=='--run')throw Error('EXPLICIT_RUN_REQUIRED');
const dir=await mkdtemp(join(tmpdir(),'lzr-private-preflight-')),name='lzr-private-preflight-'+randomBytes(6).toString('hex');
const evidence=[],record=row=>{evidence.push(row);console.log(JSON.stringify(row));};let stage='prepare',failed=false,interrupted=false;
process.once('SIGINT',()=>{interrupted=true;});process.once('SIGTERM',()=>{interrupted=true;});
const deadline=Date.now()+120000;
const docker=async args=>{if(stage!=='cleanup'&&(interrupted||Date.now()>deadline))throw Error('STOP');return exec('docker',['--host','unix:///var/run/docker.sock',...args],{env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_CONFIG:join(dir,'docker-config')},timeout:20000,maxBuffer:1024*1024});};
try{
 await mkdir(join(dir,'docker-config'),{mode:0o700});const deps=await realpath('node_modules');const lock=JSON.parse(await readFile('package-lock.json','utf8'));assert.equal(lock.packages['node_modules/pg'].version,'8.22.0');assert.equal(JSON.parse(await readFile(join(deps,'pg/package.json'),'utf8')).version,'8.22.0');
 record({check:'provenance',head:(await exec('git',['rev-parse','HEAD'])).stdout.trim(),tree:(await exec('git',['rev-parse','HEAD^{tree}'])).stdout.trim(),harnessSha:createHash('sha256').update(await readFile('tests/manual/private-preflight-pg17.mjs')).digest('hex'),coreSha:createHash('sha256').update(await readFile('lib/platform/private-db-preflight.mjs')).digest('hex'),insideSha:createHash('sha256').update(await readFile('tests/manual/private-preflight-inside.mjs')).digest('hex')});
 stage='cached-image';const cached=JSON.parse((await docker(['image','inspect',image])).stdout)[0];assert.ok(cached.RepoDigests.some(d=>d.endsWith(image.slice(image.indexOf('@')))));record({check:stage,pass:true});
 await copyFile('tests/manual/private-preflight-inside.mjs',join(dir,'inside.mjs'));await copyFile('lib/platform/private-db-preflight.mjs',join(dir,'core.mjs'));
 await writeFile(join(dir,'postgres.env'),'POSTGRES_USER=fixture\nPOSTGRES_DB=fixture\nPOSTGRES_PASSWORD='+randomBytes(32).toString('hex')+'\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256\n',{mode:0o600});
 stage='create';await docker(['create','--pull=never','--name',name,'--network','none','--read-only','--security-opt','no-new-privileges:true','--log-driver','none','--pids-limit','128','--tmpfs','/var/lib/postgresql/data:rw,nosuid,noexec,size=192m','--tmpfs','/var/run/postgresql:rw,nosuid,noexec,size=16m','--tmpfs','/tmp:rw,nosuid,noexec,size=16m','--env-file',join(dir,'postgres.env'),'--mount',`type=bind,source=${join(dir,'inside.mjs')},target=/qa/inside.mjs,readonly`,'--mount',`type=bind,source=${join(dir,'core.mjs')},target=/qa/core.mjs,readonly`,'--mount',`type=bind,source=${deps},target=/qa/node_modules,readonly`,'--mount',`type=bind,source=${process.execPath},target=/node,readonly`,image,'-c','shared_buffers=16MB','-c','max_connections=12']);
 const info=JSON.parse((await docker(['inspect',name])).stdout)[0];assert.equal(info.HostConfig.NetworkMode,'none');assert.deepEqual(info.HostConfig.PortBindings,{});assert.ok(info.Mounts.every(m=>m.Type!=='volume'&&(m.Type!=='bind'||m.RW===false)));
 stage='start';await docker(['start',name]);let ready=false;for(let n=0;n<100;n++){try{const r=await docker(['exec',name,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -q -h 127.0.0.1 -U fixture -d fixture']);ready=r.stderr==='';if(ready)break;}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 for(const mode of ['--initial']){stage=mode;const result=await docker(['exec',name,'/node','/qa/inside.mjs',mode]);for(const line of result.stdout.trim().split('\n')){const row=JSON.parse(line);assert.deepEqual(Object.keys(row).sort(),['check','pass']);assert.match(row.check,/^[a-z-]+$/);assert.equal(row.pass,true);record(row);}}
}catch{failed=true;record({check:stage.replace(/^--/,''),pass:false});}
finally{
 stage='cleanup';let containerRemoved=false,filesRemoved=false;
 try{const list=async()=>(await docker(['ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}'])).stdout.trim();const found=await list();assert.ok(found===''||found===name);if(found)await docker(['rm','-f','-v',name]);assert.equal(await list(),'');containerRemoved=true;}catch{}
 try{await rm(dir,{recursive:true,force:true});try{await lstat(dir);}catch(e){if(e.code==='ENOENT')filesRemoved=true;}}catch{}
 if(!containerRemoved||!filesRemoved||interrupted)failed=true;record({check:'cleanup',pass:containerRemoved&&filesRemoved,containerRemoved,filesRemoved,cachedImageRetained:true});
 await mkdir('/workspace/evidence/private-preflight-pg17',{recursive:true});await writeFile('/workspace/evidence/private-preflight-pg17/'+name+'.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
}process.exitCode=failed?1:0;
