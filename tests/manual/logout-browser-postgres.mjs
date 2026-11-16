// Only a newly initialized disposable cluster. Never uses DATABASE_URL.
// PG_BIN=/path/to/postgresql/bin node --experimental-strip-types tests/manual/logout-browser-postgres.mjs
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=process.env.PG_BIN;
assert.ok(bin,'Explicit local PostgreSQL path required');
const dir=await mkdtemp(join(tmpdir(),'handoff-synthetic-')),data=join(dir,'data'),env={PATH:process.env.PATH,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},results=[];
let pool,started=false;
const closures=[];const track=p=>{p.on('connect',c=>closures.push(new Promise(r=>c.once('end',r))));return p;};
const record=(name,evidence)=>{results.push({name,...evidence});console.log(JSON.stringify(results.at(-1)));};
try{
 execFileSync(join(bin,'initdb'),['-D',data,'--auth=trust','--encoding=UTF8','--no-locale'],{env,stdio:'pipe'});
 execFileSync(join(bin,'pg_ctl'),['-D',data,'-l',join(dir,'postgres.log'),'-o',`-k ${dir} -h ''`,'-w','start'],{env,stdio:'pipe'});started=true;
 pool=track(new pg.Pool({host:dir,user:process.env.USER||'agent',database:'postgres'}));await pool.query('CREATE DATABASE handoff_synthetic');await pool.end();
 pool=track(new pg.Pool({host:dir,user:process.env.USER||'agent',database:'handoff_synthetic'}));
 await migrate(drizzle(pool),{migrationsFolder:join(root,'drizzle')});
 await pool.query(`CREATE ROLE synthetic_auth_visual LOGIN; GRANT CONNECT ON DATABASE handoff_synthetic TO synthetic_auth_visual; GRANT USAGE ON SCHEMA public TO synthetic_auth_visual; GRANT SELECT ON ALL TABLES IN SCHEMA public TO synthetic_auth_visual; GRANT INSERT,DELETE ON sessions TO synthetic_auth_visual; GRANT UPDATE(last_login_at,updated_at) ON users TO synthetic_auth_visual;`);
 const {runLogoutBrowser}=await import('./logout-browser.mjs');await runLogoutBrowser({pool,dir,root,record});
 await writeFile(join(dir,'results.json'),JSON.stringify(results,null,2)+'\n');console.log('QA_EVIDENCE='+join(dir,'results.json'));
 }finally{
 try{if(pool)await pool.end();await Promise.all(closures);}finally{if(started)await promisify(execFile)(join(bin,'pg_ctl'),['-D',data,'-m','fast','-w','stop'],{env,timeout:15000});}
}
