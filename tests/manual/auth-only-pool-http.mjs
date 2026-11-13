// Only a newly initialized disposable cluster. Never uses DATABASE_URL.
// PG_BIN=/path/to/postgresql/bin node --experimental-strip-types tests/manual/auth-only-pool-http.mjs
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=process.env.PG_BIN;
assert.ok(bin,'Explicit local PostgreSQL path required');
const dir=await mkdtemp(join(tmpdir(),'handoff-synthetic-')),data=join(dir,'data'),env={PATH:process.env.PATH,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},results=[];
let pool,runtime,server,held=[],started=false;
// Pool.end() can resolve before client sockets finish closing; stop PostgreSQL only after client end events.
const clientClosures=[];
const track=pool=>{pool.on('connect',client=>clientClosures.push(new Promise(resolve=>client.once('end',resolve))));return pool;};
const record=(name,evidence)=>{results.push({name,...evidence});console.log(JSON.stringify(results.at(-1)));};
try{
 execFileSync(join(bin,'initdb'),['-D',data,'--auth=trust','--encoding=UTF8','--no-locale'],{env,stdio:'pipe'});
 execFileSync(join(bin,'pg_ctl'),['-D',data,'-l',join(dir,'postgres.log'),'-o',`-k ${dir} -h ''`,'-w','start'],{env,stdio:'pipe'});started=true;
 pool=track(new pg.Pool({host:dir,user:process.env.USER||'agent',database:'postgres'}));await pool.query('CREATE DATABASE handoff_synthetic');await pool.end();
 pool=track(new pg.Pool({host:dir,user:process.env.USER||'agent',database:'handoff_synthetic'}));
 await migrate(drizzle(pool),{migrationsFolder:join(root,'drizzle')});

 await build({stdin:{contents:"export {GET as ME} from './app/api/auth/me/route.ts';export {POST as LOGOUT} from './app/api/auth/logout/route.ts';export {getPool} from './db/index.ts';",resolveDir:root},outfile:join(root,'tests/manual/.auth-only-http-test.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',alias:{'next/server':'next/server.js'},tsconfig:join(root,'tsconfig.json')});
 process.env.DATABASE_URL='postgresql://'+(process.env.USER||'agent')+'@localhost/handoff_synthetic?host='+encodeURIComponent(dir);
 process.env.FEATURE_AUTH='true';
 const {ME,LOGOUT,getPool}=await import('./.auth-only-http-test.mjs');runtime=track(getPool());
 const now=new Date().toISOString(),token='synthetic-http-session',hash=createHash('sha256').update(token).digest('hex');
 await pool.query("INSERT INTO users(id,email,name,role,password_hash,password_salt,created_at,updated_at) VALUES('http-user','http@example.invalid','HTTP Synthetic','Atendente','unused','unused',$1,$1)",[now]);
 await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES($1,'http-user',$2,$3)",[hash,new Date(Date.now()+3600000).toISOString(),now]);
 const occupy=async()=>{for(let i=0;i<runtime.options.max;i++)held.push(await runtime.connect());};
 const release=()=>held.splice(0).forEach(client=>client.release());
 server=createServer(async(req,res)=>{
  try{
   const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers});
   const response=req.url==='/api/auth/logout'?await LOGOUT(request):await ME(request);
   for(const [key,value] of response.headers)if(key!=='set-cookie')res.setHeader(key,value);
   const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);
   res.writeHead(response.status);res.end(await response.text());
  }catch{res.writeHead(500);res.end('Synthetic adapter failure');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,headers={cookie:'lzr_session='+token};
 const request=async(path,method='GET',custom=headers)=>fetch(origin+path,{method,headers:custom});
 assert.equal((await (await request('/api/auth/me')).json()).authenticated,true);
 await occupy();
 for(const [path,method] of [['/api/auth/me','GET'],['/api/auth/logout','POST']]){
  const start=Date.now(),response=await request(path,method),body=await response.json();
  assert.equal(response.status,503);assert.equal(body.ok,undefined);assert.equal(body.authenticated,undefined);assert.deepEqual(response.headers.getSetCookie(),[]);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(runtime.waitingCount,0);
  record('unavailable',{path,status:503,elapsedMs:Date.now()-start,noCookieMutation:true});
 }
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash=$1',[hash])).rows[0].n,1);
 release();assert.equal((await (await request('/api/auth/me')).json()).authenticated,true);
 assert.equal((await (await request('/api/auth/me','GET',{cookie:'lzr_session=unknown'})).json()).authenticated,false);
 const response=await request('/api/auth/logout','POST');assert.equal(response.status,200);assert.equal((await response.json()).ok,true);assert.match(response.headers.get('set-cookie'),/Max-Age=0/i);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash=$1',[hash])).rows[0].n,0);
 assert.equal((await (await request('/api/auth/me')).json()).authenticated,false);
 const repeated=await request('/api/auth/logout','POST');assert.equal(repeated.status,200);await repeated.text();
 assert.equal(runtime.waitingCount,0);assert.equal(runtime.idleCount,runtime.totalCount);
 record('recovered',{sameTokenBeforeLogout:true,revoked:true,oldTokenRejected:true,repeatedLogout:200,idle:runtime.idleCount,total:runtime.totalCount});
 await writeFile(join(dir,'results.json'),JSON.stringify(results,null,2)+'\n');console.log('QA_EVIDENCE='+join(dir,'results.json'));
}finally{
 try{
  const released=held.length;held.splice(0).forEach(c=>c.release());
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await unlink(join(root,'tests/manual/.auth-only-http-test.mjs')).catch(()=>{});
  let timer;
  try{await Promise.race([Promise.all([runtime?.end(),pool?.end()]).then(()=>Promise.all(clientClosures)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('QA pool cleanup timeout')),10000);})]);}
  finally{clearTimeout(timer);}
  record('cleanup',{released,poolsEnded:true});
 }finally{
  if(started)await promisify(execFile)(join(bin,'pg_ctl'),['-D',data,'-m','fast','-w','stop'],{env,timeout:15000});
  console.log('QA_CLUSTER_STOPPED='+data);
 }
}
