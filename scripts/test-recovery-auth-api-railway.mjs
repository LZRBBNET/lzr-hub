// TEST ONLY: one-shot normal HTTP authentication/RBAC checks, never browser sign-in.
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertNoAmbientPostgresEnvironment, validateRailwayRecoveryTarget } from './railway-recovery-gate-target.mjs';
import { browserInputs } from './start-recovery-browser-railway.mjs';
import { FIXTURE_ACCOUNTS } from './recovery-browser-fixture.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_RUN_MS = 5 * 60 * 1000;
const AUTH_CATEGORIES = new Set(['AUTH_UNAUTH_GET','AUTH_UNAUTH_POST','AUTH_WRONG_PASSWORD','AUTH_LOGIN','AUTH_COOKIE','AUTH_IDENTITY','AUTH_ME','AUTH_SESSION_UNIQUE']);
const CATEGORIES = new Set(['TARGET_REFUSED','PORT_OCCUPIED','CHILD_FAILED','CHILD_OUTPUT','READINESS_FAILED','HTTP_FAILED','HTTP_PROTOCOL',...AUTH_CATEGORIES,'CASE_FAILED','REFERENCE_FAILED','PROMISE_FAILED','RBAC_FAILED','LOGOUT_FAILED','CLEANUP_FAILED','DEADLINE','STOPPED']);
const validStatus = value => Number.isInteger(value) && value >= 200 && value < 600;
export class ApiGateFailure extends Error {
  constructor(category, status) { super('Isolated API check stopped.'); this.category = CATEGORIES.has(category) ? category : 'TARGET_REFUSED'; this.status = AUTH_CATEGORIES.has(this.category) && validStatus(status) ? status : undefined; }
}
const fail = (category, status) => { throw new ApiGateFailure(category, status); };
const check = (condition, category, status) => { if (!condition) fail(category, status); };
export const apiFailureMessage = error => {
  const category = error instanceof ApiGateFailure && CATEGORIES.has(error.category) ? error.category : 'CHILD_FAILED';
  const status = AUTH_CATEGORIES.has(category) && validStatus(error.status) ? ` HTTP${error.status}` : '';
  return `FAIL: isolated authenticated API gate ${category}${status}. No credential, cookie or response body values logged. Inspect the disposable target; do not retry or reset automatically.`;
};

export function apiTarget(env, now = new Date()) {
  let target;
  try { target = validateRailwayRecoveryTarget(env, now); } catch { fail('TARGET_REFUSED'); }
  const ack = `${target.environmentId}:${target.databaseServiceId}:${target.nonce}`;
  check(env.RECOVERY_API_ALLOW_SYNTHETIC_CHECKS === ack && env.RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED === ack
    && /^\d+$/.test(env.PORT ?? '') && Number(env.PORT) >= 1024 && Number(env.PORT) <= 65535
    && !Object.keys(env).some(key => key.startsWith('RECOVERY_API_') && key !== 'RECOVERY_API_ALLOW_SYNTHETIC_CHECKS')
    && !Object.keys(env).some(key => key.startsWith('RECOVERY_BROWSER_') && key !== 'RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED')
    && !['NODE_OPTIONS','NODE_PATH','LD_PRELOAD'].some(key => env[key]), 'TARGET_REFUSED');
  return { target, port: Number(env.PORT), deadline: Math.min(now.getTime() + MAX_RUN_MS, Date.parse(target.expiresAt) - 20000) };
}

export function generateApiCredentials() {
  return FIXTURE_ACCOUNTS.map(account => {
    const password = randomBytes(32).toString('base64url'), salt = randomBytes(16).toString('hex');
    return { ...account, password, salt, hash: scryptSync(password, salt, 64).toString('hex') };
  });
}
export function apiChildEnvironment(env, accounts) {
  check(accounts?.length === 2 && accounts[0].password !== accounts[1].password, 'TARGET_REFUSED');
  const names = ['RECOVERY_CASE_RAILWAY_TARGET_JSON','RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL','RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION','RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED','PORT',
    'RAILWAY_PROJECT_ID','RAILWAY_ENVIRONMENT_ID','RAILWAY_ENVIRONMENT_NAME','RAILWAY_SERVICE_ID','RAILWAY_GIT_COMMIT_SHA','RAILWAY_GIT_BRANCH','RAILWAY_GIT_REPO_OWNER','RAILWAY_GIT_REPO_NAME','PATH','HOME'];
  const result = Object.fromEntries(names.filter(name => typeof env[name] === 'string').map(name => [name,env[name]]));
  for (const [i, name] of ['OPERATOR','READER'].entries()) {
    result[`RECOVERY_BROWSER_${name}_PASSWORD_HASH`] = accounts[i].hash;
    result[`RECOVERY_BROWSER_${name}_PASSWORD_SALT`] = accounts[i].salt;
  }
  // Real unchanged preflight validates generated hash/salt schema, identity and seed ACK.
  try { browserInputs(result); } catch { fail('TARGET_REFUSED'); }
  return result; // Passwords are NOT put in environment/argv/files.
}

const CHILD_LINES = [
  'PASS: exact repository migration chain applied to approved empty disposable Railway database.',
  'PASS: real concurrent active uniqueness, same-key replay and version CAS.',
  'PASS: actual FK rollback, scoped reads and close/reopen uniqueness.',
  'PASS: failed optional presentation read cannot roll back a reported successful mutation.',
  'Database intentionally retained for inspection; dispose of this test database separately. No IXC or messaging connection was used.',
  'PASS: real PostgreSQL gate completed; preparing synthetic authenticated browser stage.',
  'PASS: two synthetic accounts, two identified target conversations, forty newer unrelated conversations and one synthetic historical promise seeded. No credentials logged.',
  'Synthetic app process launched. Readiness and browser checks NOT YET VERIFIED. Expiry stops the app, not Railway billing; external cleanup remains required.',
];
export function childPhaseReader() {
  let pending = '', index = 0, poisoned = false;
  return {
    push(chunk) {
      if(poisoned) fail('CHILD_OUTPUT');
      try {
        if((!Buffer.isBuffer(chunk) && typeof chunk !== 'string') || pending.length + chunk.length > 8192) fail('CHILD_OUTPUT');
        pending += chunk.toString('utf8');
        while (pending.includes('\n')) {
          const end = pending.indexOf('\n'), line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
          if (!line) continue;
          // Never forward arbitrary child output, stack traces or response/driver values.
          if (line !== CHILD_LINES[index]) fail('CHILD_OUTPUT');
          index++;
        }
        if(index === CHILD_LINES.length && pending) fail('CHILD_OUTPUT');
      } catch {pending='';poisoned=true;fail('CHILD_OUTPUT');}
    },
    complete: () => !poisoned && index === CHILD_LINES.length && pending === '',
    bufferedLength: () => pending.length, // Numeric test observation only; never exposes output.
  };
}

/** Drain secret-bearing pipes without forwarding them; stream errors enter normal cleanup. */
export function attachApiChildStreams(child, phases, onFailure) {
  let failed=false;
  const stop=()=>{if(!failed){failed=true;onFailure();}};
  child.stdout.on('error',stop);child.stderr.on('error',stop);
  child.stdout.on('data',chunk=>{try{if(!failed)phases.push(chunk);}catch{stop();}finally{if(Buffer.isBuffer(chunk))chunk.fill(0);}});
  child.stderr.on('data',chunk=>{if(Buffer.isBuffer(chunk))chunk.fill(0);else stop();});
}

function allowedPath(path, method) {
  if (typeof path !== 'string') return false;
  if (method === 'POST') return ['/api/auth/login','/api/auth/logout','/api/billing/recovery/cases','/api/billing/promises'].includes(path);
  return method === 'GET' && (['/api/auth/me','/api/billing/promises','/api/billing/recovery/cases'].includes(path)
    || /^\/api\/billing\/recovery\/cases\?id=[A-Za-z0-9_-]{1,128}$/.test(path));
}

/** Direct node:http, no proxies, redirects, configurable host or browser cookie injection. */
export function createApiClient(port, { request = httpRequest, timeoutMs = 10000, maxBytes = 1024 * 1024, signal } = {}) {
  check(Number.isInteger(port) && port >= 1024 && port <= 65535, 'TARGET_REFUSED');
  return async (path, { method = 'GET', body, cookie } = {}) => {
    check(allowedPath(path, method) && (cookie === undefined || /^lzr_session=[a-f0-9]{64}$/.test(cookie)), 'HTTP_PROTOCOL');
    if (signal?.aborted) fail('STOPPED');
    let encoded;
    try { encoded = body === undefined ? undefined : JSON.stringify(body); } catch { fail('HTTP_PROTOCOL'); }
    check(encoded === undefined || Buffer.byteLength(encoded) <= 8192, 'HTTP_PROTOCOL');
    return await new Promise((resolve, reject) => {
      let req, settled = false, timer;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
        if (error) { req?.destroy(); reject(error); } else resolve(value);
      };
      const aborted = () => finish(new ApiGateFailure('STOPPED'));
      try {
        req = request({ hostname: '127.0.0.1', port, path, method, agent: false, headers: {
          accept: 'application/json', ...(encoded === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }), ...(cookie ? { cookie } : {}),
        } }, response => {
          if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 600
              || (response.statusCode >= 300 && response.statusCode < 400) || response.headers.location) { response.destroy(); finish(new ApiGateFailure('HTTP_PROTOCOL')); return; }
          const chunks = []; let bytes = 0;
          response.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { response.destroy(); finish(new ApiGateFailure('HTTP_PROTOCOL')); } else chunks.push(chunk); });
          response.on('error', () => finish(new ApiGateFailure('HTTP_FAILED')));
          response.on('aborted', () => finish(new ApiGateFailure('HTTP_FAILED')));
          response.on('end', () => {
            if (settled) return;
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              check(value && typeof value === 'object', 'HTTP_PROTOCOL');
              const cookies = response.headers['set-cookie'] ?? [];
              check(Array.isArray(cookies), 'HTTP_PROTOCOL');
              let sessionCookie;
              const login = method === 'POST' && path === '/api/auth/login' && response.statusCode === 200;
              const session = cookies.filter(row => typeof row === 'string' && row.startsWith('lzr_session='));
              if (login) {
                check(session.length === 1 && /^lzr_session=[a-f0-9]{64};/.test(session[0])
                  && /;\s*HttpOnly(?:;|$)/i.test(session[0]) && /;\s*Secure(?:;|$)/i.test(session[0])
                  && /;\s*SameSite=Lax(?:;|$)/i.test(session[0]) && /;\s*Path=\/(?:;|$)/i.test(session[0]), 'AUTH_COOKIE', response.statusCode);
                sessionCookie = session[0].split(';')[0];
              } else if (path !== '/api/auth/logout') check(session.length === 0, 'HTTP_PROTOCOL');
              const cleared = session.length === 1 && /^lzr_session=;/.test(session[0]) && /;\s*Max-Age=0(?:;|$)/i.test(session[0]);
              finish(undefined, { status: response.statusCode, body: value, sessionCookie, cleared });
            } catch (error) { finish(error instanceof ApiGateFailure ? error : new ApiGateFailure('HTTP_PROTOCOL')); }
            finally { for (const chunk of chunks) chunk.fill?.(0); }
          });
        });
        req.on('error', () => finish(new ApiGateFailure('HTTP_FAILED')));
        timer = setTimeout(() => finish(new ApiGateFailure('HTTP_FAILED')), timeoutMs);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) { aborted(); return; }
        req.end(encoded);
      } catch { finish(new ApiGateFailure('HTTP_FAILED')); }
    });
  };
}

export async function exerciseAuthenticatedApi(client, accounts, now = new Date()) {
  const cookies = []; let stages = 0;
  const cases = '/api/billing/recovery/cases', promises = '/api/billing/promises';
  const key = () => randomUUID(), future = new Date(now.getTime() + 2 * 86400000).toISOString().slice(0,10);
  const post = (path, body, i = 0) => client(path, { method: 'POST', body, cookie: cookies[i] });
  const detail = async id => {
    const r = await client(`${cases}?id=${id}`, { cookie: cookies[0] });
    check(r.status === 200 && r.body.item?.id === id && Array.isArray(r.body.events), 'CASE_FAILED'); return r.body;
  };
  const unchanged = async (id, before, action, status, category) => {
    const result = await action(); check(result.status === status, category);
    const after = await detail(id); check(after.item.version === before.item.version && after.events.length === before.events.length, category);
  };
  try {
    const unauthGet = await client(cases);
    check(unauthGet.status === 401, 'AUTH_UNAUTH_GET', unauthGet.status);
    const unauthPost = await client(cases, { method:'POST', body:{action:'open',customerId:'910001',reason:'debt',idempotencyKey:key()} });
    check(unauthPost.status === 401, 'AUTH_UNAUTH_POST', unauthPost.status);
    const wrong = await client('/api/auth/login', {method:'POST',body:{email:accounts[0].email,password:accounts[1].password}});
    check(wrong.status === 401 && !wrong.sessionCookie, 'AUTH_WRONG_PASSWORD', wrong.status);
    for (const [i, account] of accounts.entries()) {
      const login = await client('/api/auth/login', {method:'POST',body:{email:account.email,password:account.password}});
      check(login.status === 200 && !!login.sessionCookie, 'AUTH_LOGIN', login.status);
      cookies[i] = login.sessionCookie;
      check(login.body.user?.id === account.id && login.body.user?.role === account.role, 'AUTH_IDENTITY', login.status);
      const me = await client('/api/auth/me', {cookie:cookies[i]});
      check(me.status === 200 && me.body.authenticated === true && me.body.authRequired === true && me.body.user?.id === account.id && me.body.user?.role === account.role, 'AUTH_ME', me.status);
    }
    check(cookies[0] !== cookies[1], 'AUTH_SESSION_UNIQUE'); stages++;
    for (const i of [0,1]) {
      const list = await client(cases, {cookie:cookies[i]});
      check(list.status === 200 && list.body.available === true && list.body.canWrite === (i === 0) && list.body.currentActorId === accounts[i].id && list.body.total === 0, 'RBAC_FAILED');
    }
    const open = {action:'open',customerId:'910001',reason:'debt',idempotencyKey:key()};
    const opened = await post(cases,open); let item = opened.body.item;
    check(opened.status === 201 && item?.customerId === '910001' && /^[A-Za-z0-9_-]{1,128}$/.test(item.id) && item.version === 1, 'CASE_FAILED');
    const replay = await post(cases,open);
    check(replay.status === 201 && replay.body.replay === true && replay.body.item?.id === item.id, 'CASE_FAILED');
    let before = await detail(item.id); check(before.events.length === 1, 'CASE_FAILED');
    await unchanged(item.id,before,()=>post(cases,{...open,idempotencyKey:key()}),409,'CASE_FAILED');
    const note = {action:'note',caseId:item.id,version:item.version,text:'SINTÉTICO QA — registro manual API, não é recebimento.',idempotencyKey:key()};
    const saved = await post(cases,note); check(saved.status === 200 && saved.body.item?.version === 2, 'CASE_FAILED'); item = saved.body.item;
    const noteReplay = await post(cases,note); check(noteReplay.status === 200 && noteReplay.body.replay === true, 'CASE_FAILED');
    before = await detail(item.id); check(before.events.length === 2 && before.events.every(e=>e.evidence?.receiptConfirmed === false), 'CASE_FAILED');
    await unchanged(item.id,before,()=>post(cases,{...note,idempotencyKey:key()}),409,'CASE_FAILED');
    await unchanged(item.id,before,()=>post(cases,{...note,version:item.version,idempotencyKey:key()},1),403,'RBAC_FAILED'); stages++;
    async function mutate(action, fields = {}) {
      const r = await post(cases,{action,caseId:item.id,version:item.version,idempotencyKey:key(),...fields});
      check(r.status === 200 && r.body.item?.id === item.id && r.body.item.version === item.version + 1, 'CASE_FAILED'); item = r.body.item; return r.body;
    }
    await mutate('claim'); check(item.ownerId === accounts[0].id, 'CASE_FAILED');
    await mutate('schedule',{nextActionOn:future}); check(item.nextActionOn === future && item.status === 'waiting', 'CASE_FAILED');
    await mutate('link_invoice',{invoiceId:'940021'});
    check(item.invoiceIds.includes('940021'), 'REFERENCE_FAILED');
    before = await detail(item.id);
    for (const invoiceId of ['950001','999999']) await unchanged(item.id,before,()=>post(cases,{action:'link_invoice',caseId:item.id,version:item.version,invoiceId,idempotencyKey:key()}),503,'REFERENCE_FAILED');
    await mutate('link_attendance',{protocol:'20261027000001'});
    check(item.attendance?.protocol === '20261027000001' && item.attendance?.conversationId === '5500000910001', 'REFERENCE_FAILED');
    before = await detail(item.id);
    await unchanged(item.id,before,()=>post(cases,{action:'link_attendance',caseId:item.id,version:item.version,protocol:'20261027000002',idempotencyKey:key()}),409,'REFERENCE_FAILED'); stages++;
    const promise = await post(promises,{action:'create',customerId:'910001',invoiceId:'940021',promisedFor:future});
    check(promise.status === 201 && /^[A-Za-z0-9_-]{1,128}$/.test(promise.body.id) && promise.body.status === 'pending', 'PROMISE_FAILED');
    const pendingBefore = await client(promises,{cookie:cookies[0]}); check(pendingBefore.body.available === true && pendingBefore.body.pendingCount === 2, 'PROMISE_FAILED');
    for (const [invoiceId,status] of [['940001',409],['940002',409],['940003',503],['950001',404],['999999',404]]) {
      const refused = await post(promises,{action:'create',customerId:'910001',invoiceId,promisedFor:future});
      check(refused.status === status, 'PROMISE_FAILED');
    }
    check((await post(promises,{action:'create',customerId:'910001',invoiceId:'940021',promisedFor:future},1)).status === 403, 'RBAC_FAILED');
    check((await post(promises,{action:'review'},1)).status === 403, 'RBAC_FAILED');
    const pendingAfter = await client(promises,{cookie:cookies[0]}); check(pendingAfter.body.pendingCount === 2, 'PROMISE_FAILED');
    await mutate('link_promise',{promiseId:promise.body.id}); check(item.promiseIds.includes(promise.body.id), 'PROMISE_FAILED');
    const reviewed = await post(promises,{action:'review'});
    check(reviewed.status === 200 && reviewed.body.fulfilled?.includes('qa-promise-received') && reviewed.body.stillPending?.includes(promise.body.id) && reviewed.body.unverified?.length === 0, 'PROMISE_FAILED');
    const reconciled = await client(promises,{cookie:cookies[0]});
    check(reconciled.status === 200 && reconciled.body.available === true && reconciled.body.pendingCount === 1
      && reconciled.body.pending?.length === 1 && reconciled.body.pending[0].id === promise.body.id && reconciled.body.pending[0].status === 'pending', 'PROMISE_FAILED');
    before = await detail(item.id); check(before.events.every(e=>e.evidence?.receiptConfirmed === false), 'PROMISE_FAILED'); stages++;
    await mutate('close',{reason:'SINTÉTICO QA — encerramento manual, sem recibo.'}); check(item.status === 'closed', 'CASE_FAILED');
    const second = await post(cases,{...open,idempotencyKey:key()}); check(second.status === 201 && second.body.item?.id !== item.id, 'CASE_FAILED');
    before = await detail(item.id);
    await unchanged(item.id,before,()=>post(cases,{action:'reopen',caseId:item.id,version:item.version,idempotencyKey:key()}),409,'CASE_FAILED');
    const closedSecond = await post(cases,{action:'close',caseId:second.body.item.id,version:second.body.item.version,reason:'SINTÉTICO QA — término manual.',idempotencyKey:key()}); check(closedSecond.status === 200,'CASE_FAILED');
    await mutate('reopen'); check(item.status === 'open','CASE_FAILED'); stages++;
    for (const cookie of cookies) {
      const result = await client('/api/auth/logout',{method:'POST',cookie});
      check(result.status === 200 && result.cleared === true, 'LOGOUT_FAILED');
      check((await client(cases,{cookie})).status === 401, 'LOGOUT_FAILED');
      const me = await client('/api/auth/me',{cookie}); check(me.body.authenticated === false, 'LOGOUT_FAILED');
    }
    cookies.length = 0; stages++;
    return { stages, browser: 'NOT_RUN', realIxc: 'NOT_USED' };
  } finally {
    // Best effort through the ordinary logout route on any failed assertion. Never SQL/session injection.
    for (const cookie of cookies) await client('/api/auth/logout',{method:'POST',cookie}).catch(()=>{});
    cookies.length = 0;
  }
}

export async function assertUnusedPort(port) {
  const server = createServer();
  await new Promise((resolve,reject)=>{server.once('error',()=>reject(new ApiGateFailure('PORT_OCCUPIED')));server.listen(port,'127.0.0.1',resolve);});
  await new Promise((resolve,reject)=>server.close(error=>error?reject(new ApiGateFailure('PORT_OCCUPIED')):resolve()));
}
const groupKill = (pid, signal) => { try { process.kill(-pid,signal); } catch (error) { if (error.code !== 'ESRCH') fail('CLEANUP_FAILED'); } };
const groupExists = pid => { try { process.kill(-pid,0); return true; } catch (error) { if(error.code === 'ESRCH') return false; fail('CLEANUP_FAILED'); } };
export async function stopApiChild(child, exited, { kill = groupKill, exists = groupExists, graceMs = 5000 } = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return;
  kill(child.pid,'SIGTERM');
  const waitExit = () => new Promise(resolve => {const timer=setTimeout(()=>resolve(false),graceMs);exited.then(()=>{clearTimeout(timer);resolve(true);});});
  const graceful = await waitExit();
  // Kill remaining descendants even if their immediate parent exited already.
  kill(child.pid,'SIGKILL');
  if (!graceful) check(await waitExit(), 'CLEANUP_FAILED');
  const until=Date.now()+graceMs;
  while(exists(child.pid)&&Date.now()<until)await sleep(25);
  check(!exists(child.pid),'CLEANUP_FAILED');
}

export async function runRecoveryAuthApi(env = process.env) {
  assertNoAmbientPostgresEnvironment(process.env);
  check(process.platform === 'linux', 'TARGET_REFUSED');
  const { port, deadline } = apiTarget(env);
  await assertUnusedPort(port);
  let accounts = [], childEnv = {};
  const controller = new AbortController(); let child, exited, ended = false, childFailure = false, outputFailure = false, timer;
  const stop = () => controller.abort();
  for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.once(signal,stop);
  const phases = childPhaseReader();
  function alive() {
    if (outputFailure) fail('CHILD_OUTPUT');
    if (ended || childFailure) fail('CHILD_FAILED');
    if (controller.signal.aborted) fail(Date.now() >= deadline ? 'DEADLINE' : 'STOPPED');
    if (Date.now() >= deadline) fail('DEADLINE');
  }
  try {
    timer = setTimeout(stop,Math.max(0,deadline-Date.now()));
    accounts=generateApiCredentials(); childEnv=apiChildEnvironment(env,accounts); alive();
    child = spawn(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('./start-recovery-browser-railway.mjs',import.meta.url))],{cwd:ROOT,env:childEnv,detached:true,stdio:['ignore','pipe','pipe']});
    exited = new Promise(resolve=>{child.once('error',()=>{childFailure=true;ended=true;controller.abort();resolve();});child.once('exit',()=>{ended=true;controller.abort();resolve();});});
    attachApiChildStreams(child,phases,()=>{outputFailure=true;controller.abort();});
    while (!phases.complete()) {alive();await sleep(100,undefined,{signal:controller.signal}).catch(()=>{});}
    alive(); console.log('PASS: child completed real empty-DB gate and synthetic seed; normal HTTP authentication remains to be checked.');
    const client = createApiClient(port,{signal:controller.signal});
    let ready=false;
    const readyUntil=Math.min(deadline,Date.now()+30000);
    while(!ready && Date.now()<readyUntil) {
      alive();
      try {const r=await client('/api/auth/me');ready=r.status===200&&r.body.authenticated===false&&r.body.authRequired===true;}
      catch(error){if(!(error instanceof ApiGateFailure)||error.category!=='HTTP_FAILED')throw error;}
      if(!ready)await sleep(100,undefined,{signal:controller.signal}).catch(()=>{});
    }
    check(ready,'READINESS_FAILED'); alive();
    const checkedClient = async (...args) => {alive();const result=await client(...args);alive();return result;};
    const result = await exerciseAuthenticatedApi(checkedClient,accounts);
    alive(); return result;
  } catch(error) {if(outputFailure)fail('CHILD_OUTPUT');throw error;} finally {
    clearTimeout(timer);
    try {
      if(child&&exited){await stopApiChild(child,exited);try{await assertUnusedPort(port);}catch{fail('CLEANUP_FAILED');}}
    }
    finally {
      for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.removeListener(signal,stop);
      for(const account of accounts){account.password='';account.hash='';account.salt='';}
      for(const name of Object.keys(childEnv))if(/^RECOVERY_BROWSER_.*PASSWORD_(HASH|SALT)$/.test(name))delete childEnv[name];
    }
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==2){console.error(apiFailureMessage(new ApiGateFailure('TARGET_REFUSED')));process.exitCode=1;}
  else runRecoveryAuthApi().then(()=>console.log('PASS: normal password login, verified roles, synthetic case/promise safeguards, reader403 and logout; child processes stopped. Browser UI NOT RUN. Dispose of approved QA resources separately.')).catch(error=>{console.error(apiFailureMessage(error));process.exitCode=1;});
}
