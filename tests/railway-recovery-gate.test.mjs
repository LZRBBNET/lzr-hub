import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { PROJECT_ID, PROTECTED_ID_TEST_SENTINEL, isProtectedIdentity, RailwayGateRefusal, validateRailwayRecoveryTarget, isPrivateTestAddress, assertRailwayDatabaseReady } from '../scripts/railway-recovery-gate-target.mjs';
import { runRailwayRecoveryGate } from '../scripts/test-recovery-cases-railway.mjs';

const now = new Date('2026-10-27T21:00:00Z');
const manifest = () => ({version:1,projectId:PROJECT_ID,environmentId:'10000000-0000-0000-0000-000000000001',environmentName:'lzr-qa-fixture',runnerServiceId:'10000000-0000-0000-0000-000000000002',databaseServiceId:'10000000-0000-0000-0000-000000000003',databaseVolumeId:'10000000-0000-0000-0000-000000000004',databaseHost:'lzr-qa-db-fixture.railway.internal',databasePort:5432,databaseName:'lzr_recovery_test_1234567890abcdef12345678',databaseUser:'postgres',sourceCommit:'a'.repeat(40),branch:'test/recovery-gate',nonce:'1234567890abcdef12345678',approvedAt:'2026-10-27T20:59:00Z',expiresAt:'2026-10-28T20:59:00Z',maxAdditionalUsd:5,approvalReference:'approved-synthetic-fixture'});
const environment = m => ({RECOVERY_CASE_RAILWAY_TARGET_JSON:JSON.stringify(m),RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL:`postgres://postgres:synthetic-test-only@${m.databaseHost}:5432/${m.databaseName}`,RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION:`${m.environmentId}:${m.databaseServiceId}:${m.nonce}`,RAILWAY_PROJECT_ID:m.projectId,RAILWAY_ENVIRONMENT_ID:m.environmentId,RAILWAY_ENVIRONMENT_NAME:m.environmentName,RAILWAY_SERVICE_ID:m.runnerServiceId,RAILWAY_GIT_COMMIT_SHA:m.sourceCommit,RAILWAY_GIT_BRANCH:m.branch,RAILWAY_GIT_REPO_OWNER:'LZRBBNET',RAILWAY_GIT_REPO_NAME:'lzr-hub'});
const validate = (m = manifest(), overrides = {}) => validateRailwayRecoveryTarget({...environment(m),...overrides},now);
const refused = error => error instanceof RailwayGateRefusal && !error.message.includes('synthetic-test-only');

test('Railway gate refuses absent target before DNS/connection and ignores production DATABASE_URL',async()=>{
 assert.throws(()=>validateRailwayRecoveryTarget({DATABASE_URL:'postgres://production.invalid/db'},now),refused);
 await assert.rejects(()=>runRailwayRecoveryGate({}),refused);
});
test('only complete approved manifest matching exact runtime identities is accepted',()=>{
 const target=validate();assert.equal(target.databaseName,manifest().databaseName);assert.equal(target.projectId,PROJECT_ID);assert.ok(Object.isFrozen(target));assert.match(target.marker,/lzr-recovery-disposable:/);
 for(const key of ['RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID','RAILWAY_GIT_COMMIT_SHA','RAILWAY_GIT_BRANCH','RAILWAY_GIT_REPO_OWNER','RAILWAY_GIT_REPO_NAME'])assert.throws(()=>validate(manifest(),{[key]:'wrong'}),refused);
 for(const raw of ['', 'null','[]','{}','invalid'])assert.throws(()=>validate(manifest(),{RECOVERY_CASE_RAILWAY_TARGET_JSON:raw}),refused);
 assert.throws(()=>validate({...manifest(),unknown:true}),refused);
});
test('protected identities use exact digest checks and are denied in every target identity position',()=>{
 assert.equal(isProtectedIdentity(PROTECTED_ID_TEST_SENTINEL),true);assert.equal(isProtectedIdentity(manifest().environmentId),false);assert.equal(isProtectedIdentity(null),false);
 for(const id of [PROTECTED_ID_TEST_SENTINEL])for(const key of ['environmentId','runnerServiceId','databaseServiceId','databaseVolumeId'])assert.throws(()=>validate({...manifest(),[key]:id}),refused);
 assert.throws(()=>validate({...manifest(),runnerServiceId:manifest().databaseServiceId}),refused);
 assert.throws(()=>validate({...manifest(),projectId:'10000000-0000-0000-0000-000000000099'}),refused);
});
test('default/main/production targets and unreviewed source are rejected',()=>{
 for(const m of [{...manifest(),environmentName:'production'},{...manifest(),environmentName:'lzr-qa-production'},{...manifest(),branch:'main'},{...manifest(),sourceCommit:'latest'},{...manifest(),databaseHost:'postgres.railway.internal'},{...manifest(),databaseHost:'test.proxy.rlwy.net'},{...manifest(),databaseName:'railway'},{...manifest(),databasePort:6543}])assert.throws(()=>validate(m),refused);
});
test('approval must be current, bounded by24h and at most5USD; acknowledgement is not authorization itself',()=>{
 for(const m of [{...manifest(),approvedAt:'2026-10-27T21:01:00Z'},{...manifest(),expiresAt:'2026-10-27T21:00:30Z'},{...manifest(),expiresAt:'2026-10-29T21:00:00Z'},{...manifest(),approvedAt:'invalid'},{...manifest(),approvalReference:'PENDING'},{...manifest(),maxAdditionalUsd:6},{...manifest(),maxAdditionalUsd:0}])assert.throws(()=>validate(m),refused);
});
test('runner rejects inherited operational config and public/altered connections without printing credentials',()=>{
 for(const [key,value]of Object.entries({FEATURE_AUTH:'true',FEATURE_IXC_WRITE:'true',DATABASE_URL:'postgres://production/db',IXC_MODE:'staging-readonly',IXC_TOKEN:'fake',META_ACCESS_TOKEN:'fake',GROQ_API_KEY:'fake',RAILWAY_TOKEN:'fake',RAILWAY_API_TOKEN:'fake',IXC_WRITE_ENABLED:'true'}))assert.throws(()=>validate(manifest(),{[key]:value}),refused);
 for(const url of ['postgres://postgres:synthetic-test-only@127.0.0.1/test','postgres://postgres:synthetic-test-only@public.proxy.rlwy.net/test',environment(manifest()).RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL+'?sslmode=disable',environment(manifest()).RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL+'#fragment'])assert.throws(()=>validate(manifest(),{RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL:url}),refused);
 assert.throws(()=>validate(manifest(),{RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION:'yes'}),refused);
 assert.equal(validate(manifest(),{FEATURE_AUTH:'false',FEATURE_IXC_WRITE:'false',IXC_MODE:'disabled'}).databasePort,5432);
});
test('actual process PGOPTIONS cannot bypass guards through an injected env; real pg fallback is accounted for',async()=>{
 const previous=process.env.PGOPTIONS;
 try {
  process.env.PGOPTIONS='-c search_path=unexpected,public';
  const legacy=new Client({host:'127.0.0.1',user:'synthetic',database:'synthetic',password:'synthetic',options:'',ssl:false});
  assert.equal(legacy.connectionParameters.options,process.env.PGOPTIONS); // constructor only; never connect
  const explicit=new Client({host:'127.0.0.1',user:'synthetic',database:'synthetic',password:'synthetic',options:'-c search_path=public',ssl:false});
  assert.equal(explicit.connectionParameters.options,'-c search_path=public');
  await assert.rejects(()=>runRailwayRecoveryGate(environment(manifest())),error=>refused(error)&&error.message.includes('PG*'));
  for(const key of ['PGOPTIONS','PGHOST','PGUSER','PGDATABASE','PGSSLMODE','PGREPLICATION'])assert.throws(()=>validate(manifest(),{[key]:'unexpected'}),refused);
 } finally { if(previous===undefined)delete process.env.PGOPTIONS;else process.env.PGOPTIONS=previous; }
});
test('private DNS predicate excludes public, loopback, link-local, malformed and mapped-public addresses',()=>{
 for(const ip of ['10.1.2.3','172.16.0.1','172.31.255.254','192.168.1.2','fd12:3456::1','fc00::2'])assert.equal(isPrivateTestAddress(ip),true,ip);
 for(const ip of ['127.0.0.1','::1','8.8.8.8','169.254.1.1','172.32.0.1','192.169.1.1','fe80::1','::ffff:8.8.8.8','invalid','10.999.1.1'])assert.equal(isPrivateTestAddress(ip),false,ip);
});
const readiness = (rowChanges = {}, rowCount = 0) => {
 const target=validate(), calls=[];
 const row={database:target.databaseName,username:target.databaseUser,address:'fd12::1',port:5432,marker:target.marker,...rowChanges};
 const client={query:async sql=>{calls.push(sql);return calls.length===1?{rows:[row]}:{rowCount};}};
 return {target,calls,client};
};
test('database readiness uses SELECT only and requires independently provisioned marker plus empty database',async()=>{
 const good=readiness();await assertRailwayDatabaseReady(good.client,good.target,'fd12:0:0:0:0:0:0:1',now);assert.equal(good.calls.length,2);assert.ok(good.calls.every(sql=>sql.startsWith('select ')));
 for(const change of [{database:'production'},{username:'other'},{address:'8.8.8.8'},{address:'fd12::2'},{port:6543},{marker:null},{marker:'other-environment'}]){const bad=readiness(change);await assert.rejects(()=>assertRailwayDatabaseReady(bad.client,bad.target,'fd12::1',now),refused);assert.equal(bad.calls.length,1);}
 const nonempty=readiness({},1);await assert.rejects(()=>assertRailwayDatabaseReady(nonempty.client,nonempty.target,'fd12::1',now),refused);
});
test('expiry is rechecked immediately before readiness and never reaches SQL when expired',async()=>{
 const ctx=readiness();await assert.rejects(()=>assertRailwayDatabaseReady(ctx.client,ctx.target,'fd12::1',new Date('2026-10-29')),refused);assert.equal(ctx.calls.length,0);
});
test('Railway variant preserves the original PostgreSQL assertions rather than replacing them with mocks',async()=>{
 const original=await readFile(new URL('../scripts/test-recovery-cases-postgres.mjs',import.meta.url),'utf8'),variant=await readFile(new URL('../scripts/test-recovery-cases-railway.mjs',import.meta.url),'utf8');
 const core=text=>text.slice(text.indexOf('    const db = drizzle(pool);'),text.indexOf('  } finally {')).replace('approved empty disposable Railway database','empty local database');
 assert.equal(core(variant),core(original));
 assert.match(variant,/host: address/);assert.match(variant,/pg_try_advisory_lock/);assert.match(variant,/assertRailwayDatabaseReady\(guard, target, address\)/);
 assert.doesNotMatch(variant,/console\.error\(error\.message\)/);
});
