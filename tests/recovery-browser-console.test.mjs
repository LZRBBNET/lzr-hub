import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, chmod, lstat, link, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { verifyPassword } from '../lib/platform/auth.ts';
import { PROJECT_ID, PROTECTED_ID_TEST_SENTINEL, RailwayGateRefusal } from '../scripts/railway-recovery-gate-target.mjs';
import { consoleTarget, consoleDirectory, consumeConsole, deriveConsoleCredentials, prepareConsole, provisionConsole, readMaskedPassword } from '../scripts/recovery-browser-console.mjs';

// Deliberately non-credential input sent only to local fake/isolated TTY tests.
const operator = 'NOT-A-REAL-OPERATOR-PASSWORD', reader = 'NOT-A-REAL-READER-PASSWORD';
function environment() {
  const now = Date.now();
  const m = {version:1,projectId:PROJECT_ID,environmentId:'10000000-0000-0000-0000-000000000001',environmentName:'lzr-qa-console-fixture',runnerServiceId:'10000000-0000-0000-0000-000000000002',databaseServiceId:'10000000-0000-0000-0000-000000000003',databaseVolumeId:'10000000-0000-0000-0000-000000000004',databaseHost:'lzr-qa-db-fixture.railway.internal',databasePort:5432,databaseName:'lzr_recovery_test_1234567890abcdef12345678',databaseUser:'postgres',sourceCommit:'a'.repeat(40),branch:'test/recovery-gate',nonce:'1234567890abcdef12345678',approvedAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),maxAdditionalUsd:5,approvalReference:'approved-synthetic-fixture'};
  return {RECOVERY_CASE_RAILWAY_TARGET_JSON:JSON.stringify(m),RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL:`postgres://postgres:synthetic-test-only@${m.databaseHost}:5432/${m.databaseName}`,RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION:`${m.environmentId}:${m.databaseServiceId}:${m.nonce}`,RAILWAY_PROJECT_ID:m.projectId,RAILWAY_ENVIRONMENT_ID:m.environmentId,RAILWAY_ENVIRONMENT_NAME:m.environmentName,RAILWAY_SERVICE_ID:m.runnerServiceId,RAILWAY_GIT_COMMIT_SHA:m.sourceCommit,RAILWAY_GIT_BRANCH:m.branch,RAILWAY_GIT_REPO_OWNER:'LZRBBNET',RAILWAY_GIT_REPO_NAME:'lzr-hub',RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED:`${m.environmentId}:${m.databaseServiceId}:${m.nonce}`,PORT:'3000'};
}
class FakeTTY extends EventEmitter {
  isTTY = true; isRaw = false; modes = []; chunks = [];
  constructor(chunks = []) { super(); this.chunks = chunks.map(value => Buffer.from(value)); }
  setRawMode(value) { this.isRaw = value; this.modes.push(value); }
  resume() { const chunk = this.chunks.shift(); if (chunk) setImmediate(() => this.emit('data', chunk)); }
  pause() {}
}
const output = () => ({ isTTY:true, text:'', write(value) { this.text += value; } });
const refusal = error => error instanceof RailwayGateRefusal;
async function context(t) {
  const root = await mkdtemp(join(tmpdir(),'lzr-console-unit-')), directory = join(root,'private');
  t.after(() => rm(root,{recursive:true,force:true}));
  const env = environment(), target = consoleTarget(env);
  await prepareConsole(directory,target);
  return {root,directory,env,target};
}
async function exists(path) { try { await lstat(path); return true; } catch(error) { if(error.code==='ENOENT') return false; throw error; } }
async function completeFile(directory, values) {
  await writeFile(join(directory,'credentials.json'),JSON.stringify(values),{mode:0o600});
  await writeFile(join(directory,'committed'),'',{mode:0o600});
}

test('console preflight retains identity, production denylist, time, flags, port and separate seed ACK', () => {
  const env=environment(); assert.equal(consoleDirectory(consoleTarget(env)), '/tmp/lzr-recovery-browser-console-1234567890abcdef12345678');
  for(const change of [{RAILWAY_ENVIRONMENT_ID:PROTECTED_ID_TEST_SENTINEL},{FEATURE_AUTH:'true'},{PGOPTIONS:'bad'},{PORT:'80'},{PORT:'3000bad'},
    {RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED:'yes'},{RECOVERY_BROWSER_OPERATOR_PASSWORD:'never-accepted'},{RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH:'a'.repeat(128)}]) assert.throws(()=>consoleTarget({...env,...change}),refusal);
  assert.throws(()=>consoleTarget(env,new Date(Date.now()+7200000)),refusal);
});

test('masked input requires genuine TTY and disables echo before prompt; never outputs sentinel', async () => {
  const input=new FakeTTY(), out=output(), chunk=Buffer.from(`${operator}\r`);
  const promise=readMaskedPassword(input,out,'Synthetic test',{deadline:Date.now()+5000});
  assert.equal(input.isRaw,true); input.emit('data',chunk);
  const result=await promise;
  assert.equal(result.toString(),operator); assert.equal(chunk.every(byte=>byte===0),true); result.fill(0);
  assert.deepEqual(input.modes,[true,false]); assert.equal(input.listenerCount('data'),0); assert.equal(input.isRaw,false);
  assert.equal(out.text.includes(operator),false);
  for(const [a,b] of [[{...input,isTTY:false},out],[input,{...out,isTTY:false}],[{...input,setRawMode:undefined},out]]) assert.throws(()=>readMaskedPassword(a,b,'No input',{deadline:Date.now()+5000}),refusal);
});

test('masked prompt restores terminal and clears input on Ctrl-C, escape, nonASCII, overflow, short input, EOF and timeout', async () => {
  for(const data of ['\x03','\x1b[A','é','x'.repeat(129),'short\r',`${operator}\r${reader}\r`]) {
    const input=new FakeTTY(),out=output(),chunk=Buffer.from(data);
    const promise=readMaskedPassword(input,out,'Test',{deadline:Date.now()+5000});input.emit('data',chunk);
    await assert.rejects(promise); assert.equal(input.isRaw,false);assert.equal(input.listenerCount('data'),0);assert.equal(chunk.every(byte=>byte===0),true);assert.equal(out.text.includes(data),false);
  }
  for(const end of ['end','timeout','signal']) {
    const input=new FakeTTY(),out=output(),controller=new AbortController();
    const promise=readMaskedPassword(input,out,'Test',{deadline:Date.now()+(end==='timeout'?10:5000),signal:controller.signal});
    if(end==='end')input.emit('end');if(end==='signal')controller.abort();
    await assert.rejects(promise);assert.equal(input.isRaw,false);assert.equal(input.listenerCount('data'),0);
  }
});

test('masked prompt handles backspace without echoing plaintext', async () => {
  const input=new FakeTTY([`${operator}X\x7f\r`]),out=output();
  const value=await readMaskedPassword(input,out,'Test',{deadline:Date.now()+5000});
  assert.equal(value.toString(),operator);value.fill(0);assert.equal(out.text.includes(operator),false);
});

test('hashing uses product scrypt hex-string salt, independent salts and rejects equal or invalid passwords', async () => {
  const values=deriveConsoleCredentials(Buffer.from(operator),Buffer.from(reader));
  assert.equal(await verifyPassword(operator,values.RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH,values.RECOVERY_BROWSER_OPERATOR_PASSWORD_SALT),true);
  assert.equal(await verifyPassword(reader,values.RECOVERY_BROWSER_READER_PASSWORD_HASH,values.RECOVERY_BROWSER_READER_PASSWORD_SALT),true);
  assert.notEqual(values.RECOVERY_BROWSER_OPERATOR_PASSWORD_SALT,values.RECOVERY_BROWSER_READER_PASSWORD_SALT);
  for(const [a,b] of [[operator,operator],['short',reader],[`${operator}\n`,reader],['x'.repeat(129),reader]]) assert.throws(()=>deriveConsoleCredentials(Buffer.from(a),Buffer.from(b)),refusal);
});

test('private directory single-use, owner modes and symlink refusal', async t => {
  const {root,directory,target,env}=await context(t);
  assert.equal((await lstat(directory)).mode&0o777,0o700);assert.equal((await lstat(join(directory,'ready.json'))).mode&0o777,0o600);
  await assert.rejects(()=>prepareConsole(directory,target));
  const linked=join(root,'linked');await symlink(directory,linked);await assert.rejects(()=>consumeConsole(linked,env));
  await chmod(directory,0o755);await assert.rejects(()=>consumeConsole(directory,env));
});

test('real file handoff stores only hash/salt, consumes exactly once and removes verifier files before returning', async t => {
  const {directory,target,env}=await context(t),out=output();
  const terminal=new FakeTTY([`${operator}\r`,`${operator}\r`,`${reader}\r`,`${reader}\r`]);
  await provisionConsole(directory,target,terminal,out);
  assert.deepEqual(terminal.modes,[true,false]); // No inter-field echo window.
  const stored=await readFile(join(directory,'credentials.json'),'utf8');assert.equal(stored.includes(operator),false);assert.equal(stored.includes(reader),false);
  assert.equal((await lstat(join(directory,'credentials.json'))).mode&0o777,0o600);
  const merged=await consumeConsole(directory,env);
  assert.equal(await verifyPassword(operator,merged.RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH,merged.RECOVERY_BROWSER_OPERATOR_PASSWORD_SALT),true);
  assert.equal(await exists(join(directory,'credentials.json')),false);assert.equal(await exists(join(directory,'committed')),false);
  assert.equal(await readFile(join(directory,'finished-consumed'),'utf8'),'');
  await assert.rejects(()=>consumeConsole(directory,env));await assert.rejects(()=>provisionConsole(directory,target,new FakeTTY(),output()));
  assert.equal(out.text.includes(operator),false);assert.equal(out.text.includes(reader),false);
});

test('confirmation mismatch, equal two passwords and nonTTY fail without provisioning or retained verifier', async t => {
  for(const parts of [[operator,reader],[operator,operator,operator,operator]]) {
    const {directory,target,env}=await context(t);
    await assert.rejects(()=>provisionConsole(directory,target,new FakeTTY(parts.map(value=>`${value}\r`)),output()),refusal);
    assert.equal(await exists(join(directory,'credentials.json')),false);await assert.rejects(()=>consumeConsole(directory,env));
  }
  const {directory,target}=await context(t);const input=new FakeTTY();input.isTTY=false;
  await assert.rejects(()=>provisionConsole(directory,target,input,output()),refusal);assert.equal(await exists(join(directory,'claim')),false);
});

test('malformed, extra, wrong mode, symlink and hardlink verifier files refuse and are removed', async t => {
  for(const kind of ['extra','invalid','mode','symlink','hardlink']) {
    const {root,directory,env}=await context(t);
    const values=deriveConsoleCredentials(Buffer.from(operator),Buffer.from(reader));
    if(kind==='extra')values.unexpected='not-accepted';if(kind==='invalid')values.RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH='invalid';
    if(kind==='symlink') {const outside=join(root,'external');await writeFile(outside,JSON.stringify(values),{mode:0o600});await symlink(outside,join(directory,'credentials.json'));await writeFile(join(directory,'committed'),'',{mode:0o600});}
    else {await completeFile(directory,values);if(kind==='mode')await chmod(join(directory,'credentials.json'),0o644);if(kind==='hardlink')await link(join(directory,'credentials.json'),join(root,'hardlinked'));}
    await assert.rejects(()=>consumeConsole(directory,env));assert.equal(await exists(join(directory,'credentials.json')),false);
  }
});

test('expired or stopped waiter cleans partial verifier and never emits DB or app effects', async t => {
  for(const kind of ['expiry','abort','identity']) {
    const {directory,env}=await context(t);await writeFile(join(directory,'credentials.json'),'partial',{mode:0o600});
    if(kind==='expiry') {const ready=JSON.parse(await readFile(join(directory,'ready.json'),'utf8'));ready.deadline=Date.now()-1;await writeFile(join(directory,'ready.json'),JSON.stringify(ready));}
    if(kind==='identity') {const ready=JSON.parse(await readFile(join(directory,'ready.json'),'utf8'));ready.sourceCommit='b'.repeat(40);await writeFile(join(directory,'ready.json'),JSON.stringify(ready));}
    const controller=new AbortController();if(kind==='abort')controller.abort();
    await assert.rejects(()=>consumeConsole(directory,env,controller.signal));assert.equal(await exists(join(directory,'credentials.json')),false);
    assert.equal(await readFile(join(directory,'finished-stopped'),'utf8'),'');
  }
});

test('active abort restores entire terminal session without verifier publication', async t => {
  const {directory,target,env}=await context(t),input=new FakeTTY(),out=output(),controller=new AbortController();
  const originalWrite=out.write;
  out.write=function(value){originalWrite.call(this,value);if(value.includes('entrada oculta'))setImmediate(()=>controller.abort());};
  await assert.rejects(()=>provisionConsole(directory,target,input,out,controller.signal));
  assert.deepEqual(input.modes,[true,false]);assert.equal(await exists(join(directory,'credentials.json')),false);
  await assert.rejects(()=>consumeConsole(directory,env));
});

test('FIFO cannot hang private read and parent symlink cleanup leaves outside sentinel intact', async t => {
  const {directory,env}=await context(t);
  execFileSync('mkfifo',[join(directory,'credentials.json')]);await chmod(join(directory,'credentials.json'),0o600);
  await writeFile(join(directory,'committed'),'',{mode:0o600});
  await assert.rejects(()=>consumeConsole(directory,env));assert.equal(await exists(join(directory,'credentials.json')),false);
  const other=await context(t),outside=join(other.root,'outside');
  await import('node:fs/promises').then(fs=>fs.mkdir(outside,{mode:0o700}));
  await writeFile(join(outside,'credentials.json'),'outside sentinel',{mode:0o600});
  await rm(other.directory,{recursive:true});await symlink(outside,other.directory);
  await assert.rejects(()=>consumeConsole(other.directory,other.env));
  assert.equal(await readFile(join(outside,'credentials.json'),'utf8'),'outside sentinel');
});

test('concurrent private provision claims refuse second writer without affecting first session', async t => {
  const {directory,target,env}=await context(t),first=new FakeTTY(),out=output(),controller=new AbortController();
  let reached;const ready=new Promise(resolve=>{reached=resolve;});const originalWrite=out.write;
  out.write=function(value){originalWrite.call(this,value);if(value.includes('entrada oculta'))reached();};
  const pending=provisionConsole(directory,target,first,out,controller.signal);await ready;
  await assert.rejects(()=>provisionConsole(directory,target,new FakeTTY(),output()));
  assert.equal(first.isRaw,true);controller.abort();await assert.rejects(pending);assert.equal(first.isRaw,false);
  await assert.rejects(()=>consumeConsole(directory,env));
});

test('concurrent producer and consumer use an atomic empty commit marker after complete verifier publication', async t => {
  for(let attempt=0;attempt<3;attempt++) {
    const {directory,target,env}=await context(t),input=new FakeTTY([`${operator}\r`,`${operator}\r`,`${reader}\r`,`${reader}\r`]);
    const consumer=consumeConsole(directory,env);
    const [,merged]=await Promise.all([provisionConsole(directory,target,input,output()),consumer]);
    assert.equal(await verifyPassword(reader,merged.RECOVERY_BROWSER_READER_PASSWORD_HASH,merged.RECOVERY_BROWSER_READER_PASSWORD_SALT),true);
    assert.equal(await exists(join(directory,'credentials.json')),false);assert.equal(await exists(join(directory,'committed')),false);
    assert.equal(await readFile(join(directory,'finished-consumed'),'utf8'),'');assert.equal(await exists(join(directory,'finished-stopped')),false);
  }
  const source=await readFile(new URL('../scripts/recovery-browser-console.mjs',import.meta.url),'utf8');
  assert.match(source,/privateWrite\(directory, 'committed', ''\)/);
  assert.match(source,/privateRead\(directory, 'committed'\) !== ''/);
});

test('wrapper has no HTTP, DB, generated password, auth bypass or plaintext argv/env code; unchanged gate owns execution', async () => {
  const source=await readFile(new URL('../scripts/recovery-browser-console.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/createServer|createConnection|\.query\(|fetch\(|\.toString\('base64|process\.env\.[A-Z_]*PASSWORD/);
  assert.match(source,/await startRecoveryBrowserRailway\(appEnv\)/);assert.match(source,/assertNoAmbientPostgresEnvironment\(process.env\)/);
  assert.match(source,/process\.argv\.length !== 3/);assert.match(source,/O_NOFOLLOW/);
  assert.ok(source.indexOf('appEnv = await consumeConsole(')<source.indexOf('await startRecoveryBrowserRailway(appEnv)'));
});
