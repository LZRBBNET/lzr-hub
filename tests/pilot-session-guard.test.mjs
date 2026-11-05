// Real guard, session resolver, RBAC and handlers; memory repositories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as auth from '../lib/platform/auth.ts';
import * as rbac from '../lib/platform/rbac.ts';
import * as diagnostics from '../lib/platform/session-diagnostics.ts';
import * as promises from '../lib/platform/payment-promise-service.ts';
import * as conversations from '../lib/platform/conversation-state-service.ts';
import { CHANNEL_NAME } from '../lib/platform/n8n-channel-service.ts';
import { businessToday } from '../lib/platform/billing-service.ts';

const require = createRequire(import.meta.url);
function compile(path, modules) {
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const result = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`); return modules[name];
  }, result, result.exports);
  return result.exports;
}
function fixture(t, options = {}) {
  const env = { FEATURE_AUTH: options.flag ?? 'false', PILOT_MODE: options.mode ?? 'internal', PILOT_ALLOWED_USER_IDS: options.allowlist ?? 'synthetic-user,synthetic-other' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  if (options.flag === null) delete process.env.FEATURE_AUTH;
  if (options.mode === null) delete process.env.PILOT_MODE;
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const calls = { sessionDb: 0, businessDb: 0, provider: 0, audits: [] };
  const repository = new auth.MemoryAuthRepository();
  const user = { id: options.userId ?? 'synthetic-user', name: 'Operador sintético', email: 'operator@example.invalid', role: options.role ?? 'Supervisor', active: options.active ?? true, mustChangePassword: options.mustChangePassword ?? false, passwordHash: 'unused', passwordSalt: 'unused' };
  repository.users.push(user);
  const token = 'synthetic-session-only';
  repository.sessions.set(auth.hashToken(token), { userId: user.id, expiresAt: options.expired ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z' });
  const guard = compile('../lib/platform/session-guard.ts', {
    '../../db/index.ts': { async getDb() { calls.sessionDb++; if (options.lookupFails) throw new Error('synthetic-private-db-error'); return {}; } },
    './auth.ts': { ...auth, DbAuthRepository: class { constructor() { return repository; } } },
    './rbac.ts': rbac, './session-diagnostics.ts': diagnostics,
  });
  const promiseRepo = new promises.MemoryPaymentPromiseRepository();
  const stateRepo = new conversations.MemoryConversationStateRepository();
  stateRepo.conversations.set(conversations.stateKey(CHANNEL_NAME, 'synthetic-conversation'), new Date().toISOString());
  const common = {
    'next/server': require('next/server'),
    '@/db': { async getDb() { calls.businessDb++; return {}; } },
    '@/lib/platform/session-guard': guard,
  };
  const promiseRoute = compile('../app/api/billing/promises/route.ts', { ...common,
    'node:crypto': require('node:crypto'),
    '@/lib/integrations/ixc/runtime': { getIxcRuntime() { calls.provider++; return { provider: { async getInvoiceForCustomer(customerId, id) { return { id, customerId, status: 'A' }; } } }; } },
    '@/lib/platform/payment-promise-service': { ...promises, DbPaymentPromiseRepository: class { constructor() { return promiseRepo; } } },
    '@/lib/platform/audit-log': { async logUnauthenticatedAction(event) { calls.audits.push(event); } },
  });
  const stateRoute = compile('../app/api/conversations/state/route.ts', { ...common,
    '@/lib/platform/n8n-channel-service': { CHANNEL_NAME },
    '@/lib/platform/conversation-state-service': { ...conversations, DbConversationStateRepository: class { constructor() { return stateRepo; } } },
  });
  const request = (body, cookie = options.cookie === undefined ? `${auth.SESSION_COOKIE}=${token}` : options.cookie) => new Request('https://synthetic.invalid/api/test', {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { guard, calls, request, repository, promiseRepo, stateRepo, promiseRoute, stateRoute,
    create: () => promiseRoute.POST(request({ action: 'create', invoiceId: '901', customerId: '10', promisedFor: businessToday(new Date()), actor: { role: 'Administrador' } })),
    claim: () => stateRoute.POST(request({ action: 'claim', conversationId: 'synthetic-conversation', actor: { id: 'forged-user', role: 'Administrador' } })),
  };
}
function noBusiness(f) { assert.equal(f.calls.businessDb, 0); assert.equal(f.calls.provider, 0); assert.deepEqual(f.calls.audits, []); assert.equal(f.promiseRepo.rows.length, 0); assert.equal(f.stateRepo.audits.length, 0); }

for (const flag of [null, 'false', 'TRUE', 'true']) test(`piloto exige sessão mesmo com FEATURE_AUTH=${flag}`, async t => {
  const f = fixture(t, { flag, cookie: '' });
  assert.equal(f.guard.authEnforced(), true);
  assert.equal((await f.create()).status, 401); assert.equal((await f.claim()).status, 401);
  assert.equal((await f.promiseRoute.GET(f.request())).status, 401); noBusiness(f); assert.equal(f.calls.sessionDb, 0);
});
for (const options of [{ cookie: 'lzr_session=%ZZ' }, { cookie: 'lzr_session=unknown-synthetic' }, { expired: true }, { active: false }, { lookupFails: true }]) {
  test(`sessão inválida no piloto falha antes de negócio: ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options); const response = await f.create();
    assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), /synthetic-private-db-error|synthetic-session/); noBusiness(f);
  });
}
for (const flag of ['false', 'true']) test(`sessão fora da allowlist não acessa piloto, auth=${flag}`, async t => {
  const f = fixture(t, { flag, userId: 'synthetic-outsider' });
  assert.equal((await f.create()).status, 403); assert.equal((await f.claim()).status, 403);
  assert.equal((await f.promiseRoute.GET(f.request())).status, 403); noBusiness(f);
});
for (const allowlist of ['', 'synthetic-user', 'synthetic-user,synthetic-user', 'synthetic-user,b,c,d']) test(`allowlist inválida falha fechada: ${allowlist}`, async t => {
  const f = fixture(t, { allowlist }); assert.equal((await f.create()).status, 403); noBusiness(f);
});
for (const mode of ['', 'INTERNAL', 'unknown']) test(`modo piloto inválido não vira demo: ${mode}`, async t => {
  const f = fixture(t, { mode }); assert.equal((await f.create()).status, 403); noBusiness(f);
});
for (const [role, promiseStatus, claimStatus] of [['Supervisor', 201, 200], ['Cobrança', 201, 403], ['Atendente', 403, 200], ['Somente leitura', 403, 403]]) {
  test(`piloto aplica permissões reais de ${role}`, async t => {
    const f = fixture(t, { role });
    assert.equal((await f.create()).status, promiseStatus); assert.equal((await f.claim()).status, claimStatus);
    if (promiseStatus === 201) { assert.equal(f.promiseRepo.rows[0].registeredBy, 'operator@example.invalid'); assert.equal(f.calls.audits[0].actor.role, role); }
    if (claimStatus === 200) { assert.equal(f.stateRepo.audits.length, 1); assert.equal(f.stateRepo.audits[0].actor.id, 'synthetic-user'); }
    if (promiseStatus === 403 && claimStatus === 403) noBusiness(f);
  });
}
test('allowlist normaliza espaços e duplicatas sem aceitar coincidência parcial', async t => {
  const f = fixture(t, { allowlist: ' synthetic-user , synthetic-other,synthetic-other ' });
  assert.equal((await f.create()).status, 201);
  process.env.PILOT_ALLOWED_USER_IDS = 'synthetic-user-extra,synthetic-other';
  assert.equal((await f.claim()).status, 403);
});
for (const mode of [null, 'disabled']) test(`demo sem piloto mantém contrato anterior: ${mode}`, async t => {
  const f = fixture(t, { mode, cookie: '' });
  assert.equal(f.guard.authEnforced(), false); assert.deepEqual(await f.guard.authorize(f.request(), 'customer.read'), { allowed: true });
  assert.equal(f.calls.sessionDb, 0);
});
test('fora do piloto FEATURE_AUTH=true ainda exige sessão', async t => {
  const f = fixture(t, { mode: 'disabled', flag: 'true', cookie: '' });
  assert.equal((await f.create()).status, 401); noBusiness(f);
});


test('senha provisória bloqueia leitura/mutações pelo guard até troca confirmada no repositório',async t=>{
  const f=fixture(t,{flag:'true',mustChangePassword:true});
  const user=await f.guard.currentUser(f.request());
  assert.equal(user.mustChangePassword,true);
  assert.equal((await f.create()).status,403);assert.equal((await f.claim()).status,403);
  assert.equal((await f.promiseRoute.GET(f.request())).status,403);noBusiness(f);
  // Password endpoint uses currentUser, not authorize, so identity remains available.
  assert.equal(user.id,'synthetic-user');
  f.repository.users[0].mustChangePassword=false;
  assert.equal((await f.create()).status,201);assert.equal((await f.claim()).status,200);
});

for(const role of ['Supervisor','Somente leitura'])test(`handler real de troca de senha permanece acessível: ${role}`,async t=>{
  const f=fixture(t,{flag:'true'});f.repository.users.length=0;
  const password='synthetic-password-only-123';const replacement='synthetic-replacement-only-456';
  const user=await f.repository.addUser('password-test@example.invalid',password,role,'DEMO Password',true,true);
  f.repository.sessions.set(auth.hashToken('synthetic-session-only'),{userId:user.id,expiresAt:'2099-01-01T00:00:00Z'});
  process.env.PILOT_ALLOWED_USER_IDS=`${user.id},synthetic-other`;
  assert.equal((await f.create()).status,403);noBusiness(f);
  const route=compile('../app/api/auth/password/route.ts',{
    'next/server':require('next/server'),'@/db':{async getDb(){return {};}},
    '@/lib/platform/auth':{...auth,DbAuthRepository:class{constructor(){return f.repository;}}},
    '@/lib/platform/session-guard':f.guard,'@/lib/platform/audit-log':{async logUnauthenticatedAction(){}},
  });
  assert.equal((await route.POST(f.request({currentPassword:'wrong',newPassword:replacement}))).status,400);
  assert.equal((await f.create()).status,403);noBusiness(f);
  const changed=await route.POST(f.request({currentPassword:password,newPassword:replacement}));
  assert.equal(changed.status,200);assert.equal((await changed.json()).changed,true);
  assert.equal((await f.create()).status,role==='Supervisor'?201:403);assert.equal((await f.claim()).status,role==='Supervisor'?200:403);
});
