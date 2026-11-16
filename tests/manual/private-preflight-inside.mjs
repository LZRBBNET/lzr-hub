// Only this disposable cluster receives fixture setup writes; diagnostic client is READ ONLY.
import assert from 'node:assert/strict';
import pg from 'pg';
import {inspect} from './core.mjs';
const base={host:'127.0.0.1',user:'fixture',database:'fixture',password:process.env.POSTGRES_PASSWORD,connectionTimeoutMillis:3000,query_timeout:3500};
let admin;const opened=[];const connect=async ro=>{const c=new pg.Client({...base,...(ro?{options:'-c default_transaction_read_only=on -c search_path=pg_catalog -c statement_timeout=3000 -c lock_timeout=1000'}:{})});opened.push(c);c.on('error',()=>{});await c.connect();return c;};
const record=check=>console.log(JSON.stringify({check,pass:true}));
try{
 admin=await connect(false);const version=Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);assert.ok(version>=170000&&version<180000);
 const oid=(await admin.query('SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname=current_database()')).rows[0].oid;
 const run=async(reason,pinned=oid)=>{const c=await connect(true);try{const r=await inspect(c,{database:'fixture',user:'fixture',oid:pinned,expires:Date.now()+15000});assert.equal(r.reason,reason);for(const k of ['initializationAllowed','capacityVerified','remoteExecutionAllowed','retryAllowed','credentialsVerified','attemptReconciled'])assert.equal(r[k],false);assert.equal((await c.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');return r;}finally{await c.end();opened.splice(opened.indexOf(c),1);}};
 const initial=await run('public-connect');assert.equal(initial.observations.public_connect,true);assert.equal(initial.observations.public_schema_acl,true);record('default-public-connect-blocked');
 await run('identity-mismatch','4294967295');record('wrong-oid-stops-inspection');
 await admin.query('CREATE ROLE lzr_h100_app');await run('name-collision');await admin.query('DROP ROLE lzr_h100_app');record('proposed-role-collision-blocked');
 await admin.query('CREATE DATABASE lzr_h100_demo');await run('name-collision');await admin.query('DROP DATABASE lzr_h100_demo');record('proposed-database-collision-blocked');
 for(const name of ['postgres','template1','fixture'])await admin.query(`REVOKE CONNECT,TEMPORARY ON DATABASE ${name} FROM PUBLIC`);
 await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
 const clean=await run('capacity-unverified');assert.equal(clean.observations.public_connect,false);assert.equal(clean.observations.public_temp,false);assert.equal(clean.observations.public_schema_acl,false);assert.equal(clean.observations.public_object_acl,false);record('clean-fixture-still-blocked-capacity');
 await admin.query('ALTER ROLE fixture NOCREATEDB NOCREATEROLE');await run('capability-unobserved');record('capability-metadata-absent-blocked');
}catch{console.log(JSON.stringify({check:'preflight-failed',pass:false}));process.exitCode=1;}finally{for(const c of opened)await c.end().catch(()=>{process.exitCode=1;});}
