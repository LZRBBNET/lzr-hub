// Real HTTP handlers, validation, search, RBAC matrix and memory repository.
// Authentication, persistence and audit transport are synthetic; no server/DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as knowledge from '../lib/platform/knowledge-service.ts';
import { can } from '../lib/platform/rbac.ts';

const require = createRequire(import.meta.url);
const source = transformSync(readFileSync(new URL('../app/api/knowledge/route.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const INPUT = { action: 'ingest', title: 'Procedimento sintético fibra', category: 'Suporte', content: 'Para teste sintético de fibra, registre o resultado do teste cabeado.' };

function fixture() {
  const state = { role: 'Supervisor', signedIn: true, fail: false };
  const calls = { db: 0, audit: [], permissions: [] };
  const repository = new knowledge.MemoryKnowledgeRepository();
  const modules = {
    'next/server': require('next/server'),
    '@/db': { async getDb() { calls.db++; if (state.fail) throw new Error('synthetic-storage-detail'); return {}; } },
    '@/lib/platform/knowledge-service': { ...knowledge, DbKnowledgeRepository: class { constructor() { return repository; } } },
    '@/lib/platform/audit-log': { async logUnauthenticatedAction(event) { calls.audit.push(event); } },
    '@/lib/platform/session-guard': { async authorize(_request, permission) {
      calls.permissions.push(permission);
      if (!state.signedIn) return { allowed: false, status: 401, error: 'Sessão necessária' };
      return can(state.role, permission)
        ? { allowed: true, user: { id: 'synthetic-supervisor', email: 'supervisor@example.invalid', role: state.role } }
        : { allowed: false, status: 403, error: 'Acesso negado' };
    } },
  };
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', source)(name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  }, compiled, compiled.exports);
  const get = (q = '') => compiled.exports.GET(new Request(`https://synthetic.invalid/api/knowledge${q ? `?q=${encodeURIComponent(q)}` : ''}`));
  const post = body => compiled.exports.POST(new Request('https://synthetic.invalid/api/knowledge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { state, calls, repository, get, post };
}

test('rascunho → publicação → fonte buscável, sem confiar em status/versão/ator do cliente', async () => {
  const { calls, repository, get, post } = fixture();
  const created = await post({ ...INPUT, status: 'published', version: 99, actor: { email: 'forged@example.invalid' } });
  assert.equal(created.status, 201);
  const draft = await created.json();
  assert.equal(draft.status, 'draft'); assert.equal(draft.version, 1);
  assert.deepEqual((await (await get('fibra')).json()).results, []);
  assert.equal((await (await get()).json()).items[0].id, draft.id);
  const published = await post({ action: 'publish', id: draft.id });
  assert.equal(published.status, 200); assert.equal((await published.json()).version, 2);
  const hits = (await (await get('fibra')).json()).results;
  assert.equal(hits.length, 1); assert.equal(hits[0].document.id, draft.id); assert.match(hits[0].evidence, /versão 2/);
  assert.deepEqual(calls.audit.map(event => [event.action, event.result]), [['knowledge.ingest', 'success'], ['knowledge.publish', 'success']]);
  assert.ok(calls.audit.every(event => event.actor.email === 'supervisor@example.invalid'));
  repository.documents[0].validUntil = '2000-01-01';
  assert.deepEqual((await (await get('fibra')).json()).results, []);
  assert.equal((await (await get()).json()).items.length, 1, 'expired source remains available for maintenance');
});

for (const role of ['Atendente', 'Suporte', 'Cobrança', 'Comercial', 'Analista', 'Somente leitura']) {
  test(`${role}: pode ler, não pode ingerir ou publicar`, async () => {
    const { state, calls, repository, get, post } = fixture(); state.role = role;
    for (const body of [INPUT, { action: 'publish', id: 'synthetic-document' }]) assert.equal((await post(body)).status, 403);
    assert.equal(calls.db, 0); assert.deepEqual(calls.audit, []); assert.equal(repository.documents.length, 0);
    assert.equal((await get()).status, 200); assert.equal(calls.db, 1);
    assert.deepEqual(calls.permissions, ['knowledge.publish', 'knowledge.publish', 'customer.read']);
  });
}

test('sem sessão bloqueia leitura e escrita antes de persistência ou auditoria', async () => {
  const { state, calls, get, post } = fixture(); state.signedIn = false;
  assert.equal((await get('fibra')).status, 401); assert.equal((await post(INPUT)).status, 401);
  assert.equal(calls.db, 0); assert.deepEqual(calls.audit, []);
});

test('entrada inválida não cria documento nem audita sucesso; ausente retorna 404', async () => {
  const { calls, repository, post } = fixture();
  for (const body of [{ ...INPUT, title: 'x' }, { ...INPUT, content: '' }, { action: 'unknown' }, { action: 'publish' }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(repository.documents.length, 0); assert.deepEqual(calls.audit, []);
  assert.equal((await post({ action: 'publish', id: 'synthetic-missing' })).status, 404);
  assert.equal(calls.audit.length, 1); assert.equal(calls.audit[0].result, 'not_found');
});

test('falha de persistência não parece base vazia saudável nem publicação bem-sucedida', async () => {
  const { state, calls, repository, get, post } = fixture(); state.fail = true;
  for (const query of ['', 'fibra']) {
    const response = await get(query); const body = await response.json();
    assert.equal(body.available, false); assert.deepEqual(body.items, []); assert.deepEqual(body.results, []);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-storage-detail/);
  }
  for (const body of [INPUT, { action: 'publish', id: 'synthetic-document' }]) {
    const response = await post(body); assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /synthetic-storage-detail/);
  }
  assert.deepEqual(calls.audit, []); assert.equal(repository.documents.length, 0);
});
