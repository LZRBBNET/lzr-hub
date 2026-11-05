import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import * as auth from '../lib/platform/auth.ts';
import * as rbac from '../lib/platform/rbac.ts';
import * as diagnostics from '../lib/platform/session-diagnostics.ts';
import * as web from '../lib/runtime/synthetic-web.ts';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';
import { runSyntheticWeb } from '../scripts/synthetic-web.mjs';
import { initializationAccess } from '../lib/platform/synthetic-initialization-access.ts';

const require = createRequire(import.meta.url);
const { executeMiddleware } = await import(new URL('./server/middleware-runtime.js', import.meta.resolve('vinext')));
const source = () => ({ ...stagingDemoRequirements, ...Object.fromEntries(['FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])), NODE_ENV: 'production', FEATURE_AUTH: 'true', FEATURE_IXC_FULL_BASE: 'false',
  FEATURE_SYNTHETIC_INVOICES: 'true', DEMO_DATASET: 'isolated-invoices-v1', SYNTHETIC_WEB_DEMO: 'true',
  SYNTHETIC_DATABASE_CONFIRMATION: 'isolated-synthetic-postgres-v1', SYNTHETIC_DEMO_ORIGIN: 'https://demo.example.invalid' });
function compile(path, modules) {
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const result = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; }, result, result.exports);
  return result.exports;
}

test('configuração web é explícita; produção, origem inválida e integrações falham fechadas', () => {
  assert.equal(web.assertSyntheticWeb(source()), source().SYNTHETIC_DEMO_ORIGIN);
  for (const override of [{ SYNTHETIC_WEB_DEMO: undefined }, { SYNTHETIC_WEB_DEMO: 'false' }, { FEATURE_AUTH: 'false' },
    { LZR_ENV: 'production' }, { NODE_ENV: 'development' }, { FEATURE_QUEUES: 'true' }, { FEATURE_PGVECTOR: 'true' },
    { FEATURE_AGENT_HOMOLOGATION_PROFILES: 'true' }, { META_ACCESS_TOKEN: 'invented-not-a-secret' },
    { SYNTHETIC_DATABASE_CONFIRMATION: '' }, ...['', 'http://demo.example.invalid', 'https://demo.example.invalid/',
      'https://demo.example.invalid/path', 'https://demo.example.invalid?x=1', 'https://user:invented@demo.example.invalid'].map(SYNTHETIC_DEMO_ORIGIN => ({ SYNTHETIC_DEMO_ORIGIN }))]) {
    assert.throws(() => web.assertSyntheticWeb({ ...source(), ...override }));
  }
  assert.equal(web.syntheticWebRequested({}), false);
  assert.equal(web.syntheticWebRequested({ SYNTHETIC_WEB_DEMO: 'false' }), true);
  assert.equal(web.syntheticWebRequested({ FEATURE_SYNTHETIC_INVOICES: 'true' }), true);
  assert.throws(() => web.assertSyntheticWebDatabase(source()));
  assert.throws(() => web.assertSyntheticWebDatabase({ ...source(), DATABASE_URL: 'https://db.example.invalid' }));
  web.assertSyntheticWebDatabase({ ...source(), DATABASE_URL: 'postgresql://synthetic:invented@db.example.invalid/demo' });
});

test('proxy executado pelo runtime vinext verifica sessão real e fecha páginas/APIs antes dos handlers', async t => {
  const values = source(), previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const repository = new auth.MemoryAuthRepository();
  const user = { id: 'synthetic-web-user', name: 'DEMO Operador', email: 'operator@example.invalid', role: 'Supervisor', active: true,
    passwordHash: 'unused', passwordSalt: 'unused', mustChangePassword: false };
  repository.users.push(user);
  const token = 'synthetic-web-session';
  repository.sessions.set(auth.hashToken(token), { userId: user.id, expiresAt: '2099-01-01T00:00:00Z' });
  let reads = 0, unavailable = false;
  const guard = compile('../lib/platform/session-guard.ts', {
    '../../db/index.ts': { async getDb() { reads++; if (unavailable) throw new Error('synthetic-storage-error'); return {}; } },
    './auth.ts': { ...auth, DbAuthRepository: class { constructor() { return repository; } } },
    './rbac.ts': rbac, './session-diagnostics.ts': diagnostics,
  });
  const proxyModule = compile('../proxy.ts', { 'next/server': require('next/server'), './lib/platform/session-guard.ts': guard, './lib/runtime/synthetic-web.ts': web,
    './lib/platform/synthetic-initialization-access.ts': { initializationAccess } });
  const request = (path, options = {}) => new Request(`https://demo.example.invalid${path}`, options);
  const sessionHeaders = { cookie: `lzr_session=${token}`, origin: values.SYNTHETIC_DEMO_ORIGIN };
  const run = (path, options) => executeMiddleware({ module: proxyModule, isProxy: true, request: request(path, options) });

  await t.test('sem sessão: página redireciona; API/health/job/arquivo falso recusados, inclusive RSC/prefetch', async () => {
    for (const path of ['/', '/private', '/private?_rsc=synthetic']) {
      const result = await run(path, { headers: { rsc: '1', 'next-router-prefetch': '1', 'oai-authenticated-user-email': user.email } });
      assert.equal(result.continue, false); assert.equal(result.redirectStatus, 307);
      assert.equal(result.redirectUrl, `${values.SYNTHETIC_DEMO_ORIGIN}/login`);
    }
    for (const path of ['/api/customers', '/api/health', '/api/jobs/whatever', '/api/customers.js', '/api/auth/login/extra']) {
      const result = await run(path); assert.equal(result.continue, false); assert.equal(result.response.status, 401);
      assert.match(result.response.headers.get('cache-control'), /no-store/);
    }
    assert.equal(reads, 0);
  });
  await t.test('normalização e headers internos falsos não contornam a barreira', async () => {
    for (const path of ['/api%2fcustomers', '/%61pi/customers', '/login%2f..%2fapi%2fcustomers', '/_next/static/../../api/customers']) {
      const result = await run(path, { headers: { 'x-middleware-next': '1', 'x-middleware-subrequest': 'proxy:proxy:proxy:proxy:proxy',
        'x-middleware-override-headers': 'cookie', 'x-middleware-request-cookie': sessionHeaders.cookie } });
      assert.equal(result.continue, false, path);
      assert.ok(result.redirectStatus === 307 || [400,401].includes(result.response?.status), path);
    }
    assert.equal(reads, 0);
  });
  await t.test('login/assets/identidade públicos exatos, mas escrita exige origem configurada', async () => {
    for (const path of ['/login', '/_next/static/chunk.js', '/api/auth/me', '/favicon.svg']) assert.equal((await run(path)).continue, true);
    assert.equal((await run('/api/auth/login', { method: 'POST', headers: { origin: values.SYNTHETIC_DEMO_ORIGIN } })).continue, true);
    for (const origin of [undefined, 'https://other.example.invalid', 'null']) {
      const headers = { cookie: sessionHeaders.cookie }; if (origin !== undefined) headers.origin = origin;
      const result = await run('/api/billing/promises', { method: 'POST', headers });
      assert.equal(result.response.status, 403);
    }
    assert.equal(reads, 0);
  });
  await t.test('cookie inventado/ilegível/expirado/revogado/usuário inativo nunca libera acesso', async () => {
    for (const cookie of ['lzr_session=%ZZ', 'lzr_session=invented']) assert.equal((await run('/api/customers', { headers: { cookie } })).response.status, 401);
    repository.sessions.get(auth.hashToken(token)).expiresAt = '2000-01-01T00:00:00Z';
    assert.equal((await run('/api/customers', { headers: sessionHeaders })).response.status, 401);
    repository.sessions.set(auth.hashToken(token), { userId: user.id, expiresAt: '2099-01-01T00:00:00Z' });
    user.active = false; assert.equal((await run('/', { headers: sessionHeaders })).redirectStatus, 307); user.active = true;
    repository.sessions.delete(auth.hashToken(token));
    assert.equal((await run('/api/customers', { headers: sessionHeaders })).response.status, 401);
    repository.sessions.set(auth.hashToken(token), { userId: user.id, expiresAt: '2099-01-01T00:00:00Z' });
  });
  await t.test('sessão válida continua; senha provisória só permite shell e operações próprias; RBAC permanece', async () => {
    assert.equal((await run('/', { headers: sessionHeaders })).continue, true);
    user.mustChangePassword = true;
    assert.equal((await run('/', { headers: sessionHeaders })).continue, true);
    assert.equal((await run('/api/customers', { headers: sessionHeaders })).response.status, 403);
    for (const path of ['/api/auth/password', '/api/auth/logout']) assert.equal((await run(path, { method: 'POST', headers: sessionHeaders })).continue, true);
    user.mustChangePassword = false; user.role = 'Somente leitura';
    assert.equal((await run('/api/billing/promises', { method: 'POST', headers: sessionHeaders })).continue, true);
    assert.equal((await guard.authorize(request('/api/billing/promises', { headers: sessionHeaders }), 'billing.write-demo')).allowed, false);
    assert.equal((await guard.authorize(request('/api/customers', { headers: sessionHeaders }), 'customer.read')).allowed, true);
  });
  await t.test('configuração perdida recusa até login e assets, antes de ler sessão', async () => {
    const before = reads; process.env.FEATURE_AUTH = 'false';
    for (const path of ['/', '/login', '/api/auth/login', '/api/health', '/_next/static/chunk.js']) assert.equal((await run(path)).response.status, 503);
    assert.equal(reads, before); process.env.FEATURE_AUTH = 'true';
    unavailable = true;
    const failed = await run('/api/customers', { headers: sessionHeaders });
    assert.equal(failed.response.status, 401); assert.doesNotMatch(await failed.response.text(), /synthetic-storage-error/);
    unavailable = false;
    repository.sessions.delete(auth.hashToken(token));
    assert.equal((await run('/api/customers', { headers: sessionHeaders })).response.status, 401);
  });
  await t.test('build legado sem opt-in conserva o contrato, sem ler sessão ou alterar produção', async () => {
    const before = reads;
    delete process.env.SYNTHETIC_WEB_DEMO; delete process.env.FEATURE_SYNTHETIC_INVOICES;
    process.env.LZR_ENV = 'production';
    const result = await run('/api/customers'); assert.equal(result.continue, true); assert.equal(reads, before);
    Object.assign(process.env, values);
  });
  await t.test('capability de inicialização só libera rota exata quando opt-in, sem conceder acesso ao negócio', async () => {
    const keys=['SYNTHETIC_INIT_ENABLED','SYNTHETIC_INIT_CAPABILITY_SHA256'];
    const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
    const token='c'.repeat(64),headers={'x-synthetic-init-capability':token,origin:values.SYNTHETIC_DEMO_ORIGIN};
    try {
      process.env.SYNTHETIC_INIT_ENABLED='true';process.env.SYNTHETIC_INIT_CAPABILITY_SHA256=createHash('sha256').update(token).digest('hex');
      assert.equal((await run('/api/demo/initialize',{headers})).continue,true);
      assert.equal((await run('/api/demo/initialize',{method:'POST',headers})).continue,true);
      for(const path of ['/api/customers','/api/demo/initialize/extra','/login','/api/auth/me'])assert.equal((await run(path,{headers})).response.status,503);
      assert.equal((await run('/api/auth/login',{method:'POST',headers})).response.status,503);
      delete process.env.SYNTHETIC_INIT_ENABLED;
      assert.equal((await run('/api/demo/initialize',{headers})).response.status,401);
    } finally {for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
  });
  // The launcher check never opens DB/listen; missing DB also blocks start before imports.
  await runSyntheticWeb('check');
  await assert.rejects(runSyntheticWeb('unknown-command'));
  const oldDb = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  try { await assert.rejects(runSyntheticWeb('start')); } finally { if (oldDb !== undefined) process.env.DATABASE_URL = oldDb; }
  const oldPort = process.env.PORT;
  process.env.DATABASE_URL = 'postgresql://synthetic:invented@db.example.invalid/demo'; process.env.PORT = '0';
  try { await assert.rejects(runSyntheticWeb('start'), /SYNTHETIC_WEB_PORT_BLOCKED/); }
  finally { if (oldDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldDb;
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort; }
});
