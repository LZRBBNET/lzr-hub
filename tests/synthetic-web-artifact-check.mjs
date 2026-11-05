// Explicit post-build verification. No listen/socket/DB and no production target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';

test('artefato Node: acesso anônimo bloqueado antes do HTML/API, login público e drift recusado', async () => {
  const flags = { ...stagingDemoRequirements, ...Object.fromEntries(['FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])), NODE_ENV: 'production', FEATURE_AUTH: 'true', FEATURE_IXC_FULL_BASE: 'false',
    FEATURE_SYNTHETIC_INVOICES: 'true', DEMO_DATASET: 'isolated-invoices-v1', SYNTHETIC_WEB_DEMO: 'true',
    SYNTHETIC_DATABASE_CONFIRMATION: 'isolated-synthetic-postgres-v1', SYNTHETIC_DEMO_ORIGIN: 'https://demo.example.invalid' };
  const saved = Object.fromEntries(Object.keys(flags).map(k => [k, process.env[k]]));
  Object.assign(process.env, flags);
  try {
    const copied = await readdir(new URL('../work/synthetic-web/', import.meta.url));
    for (const forbidden of ['.env', '.openai', 'wrangler.jsonc', 'worker', 'vite.config.ts']) assert.equal(copied.includes(forbidden), false);
    const client = new URL('../work/synthetic-web/dist/client/assets/', import.meta.url);
    for (const file of await readdir(client)) if (file.endsWith('.js')) {
      assert.doesNotMatch(await readFile(new URL(file, client), 'utf8'), /DATABASE_URL|postgres(?:ql)?:\/\//);
    }
    const { default: entry } = await import('../work/synthetic-web/dist/server/index.js');
    const fetch = request => typeof entry === 'function' ? entry(request) : entry.fetch(request);
    const request = (path, init) => new Request(`https://demo.example.invalid${path}`, init);
    for (const headers of [{}, { rsc: '1', 'next-router-prefetch': '1' },
      { 'oai-authenticated-user-email': 'operator@example.invalid', 'x-middleware-subrequest': 'proxy:proxy:proxy:proxy:proxy' }]) {
      const response = await fetch(request('/', { headers }));
      assert.equal(response.status, 307); assert.equal(response.headers.get('location'), 'https://demo.example.invalid/login');
      assert.doesNotMatch(await response.text(), /Central Inteligente|Dashboard|Cliente 360/);
    }
    for (const path of ['/api/customers', '/api/billing/promises', '/api/conversations', '/api/health', '/api/unknown.js']) {
      const response = await fetch(request(path)); assert.equal(response.status, 401, path);
      assert.match(response.headers.get('cache-control'), /no-store/);
    }
    const loginPage = await fetch(request('/login'));
    assert.equal(loginPage.status, 200); assert.match(await loginPage.text(), /login-password/);
    const me = await fetch(request('/api/auth/me')); assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { authenticated: false, authRequired: true });
    assert.equal((await fetch(request('/api/auth/login', { method: 'POST', headers: { origin: flags.SYNTHETIC_DEMO_ORIGIN, 'content-type': 'application/json' }, body: '{}' }))).status, 400);
    assert.equal((await fetch(request('/api/auth/login', { method: 'POST', body: '{}' }))).status, 403);
    const initKeys=['SYNTHETIC_INIT_ENABLED','SYNTHETIC_INIT_CAPABILITY_SHA256','SYNTHETIC_INIT_DATABASE_HOST','DATABASE_URL'];
    const initSaved=Object.fromEntries(initKeys.map(k=>[k,process.env[k]]));
    try {
      const token='c'.repeat(64);
      process.env.SYNTHETIC_INIT_ENABLED='true';process.env.SYNTHETIC_INIT_CAPABILITY_SHA256=createHash('sha256').update(token).digest('hex');
      delete process.env.DATABASE_URL; // Invalid target must refuse before connect.
      const refused=await fetch(request('/api/demo/initialize',{headers:{'x-synthetic-init-capability':token}}));
      assert.equal(refused.status,400);
      assert.equal((await fetch(request('/api/customers',{headers:{'x-synthetic-init-capability':token}}))).status,503);
    } finally {for(const [k,v] of Object.entries(initSaved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
    process.env.FEATURE_AUTH = 'false';
    assert.equal((await fetch(request('/login'))).status, 503);
    for (const key of Object.keys(flags)) if (key !== 'NODE_ENV') delete process.env[key];
    assert.equal((await fetch(request('/'))).status, 503, 'protected build cannot opt out by losing flags');
    assert.equal((await fetch(request('/api/customers'))).status, 503);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
