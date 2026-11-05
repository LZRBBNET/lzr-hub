// Real Attendance UI + real Copilot handler/services; synthetic persistence/auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSync, transformSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import * as copilot from '../lib/platform/copilot-service.ts';
import { loadConversationSummary } from '../lib/platform/copilot-summary-service.ts';
import { CHANNEL_NAME } from '../lib/platform/n8n-channel-service.ts';

const require = createRequire(import.meta.url);
const handlerSource = transformSync(readFileSync(new URL('../app/api/copilot/route.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const uiSource = buildSync({ stdin: { contents: "export {AttendanceModule} from './components/modules/attendance';", resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom', 'react-dom/server'], logLevel: 'silent' }).outputFiles[0].text;
const ui = { exports: {} };
new Function('require', 'module', 'exports', uiSource)(require, ui, ui.exports);
const ID = 'synthetic-copilot-conversation';
const doc = (overrides = {}) => ({ id: 'synthetic-kb', title: 'Lentidão fibra', category: 'Suporte', content: 'Para lentidão em fibra, faça teste cabeado e registre o resultado. Procedimento sintético.', status: 'published', version: 3, validUntil: null, updatedAt: '2026-01-01T00:00:00.000Z', ...overrides });
const flatten = node => node == null ? '' : Array.isArray(node) ? node.map(flatten).join(' ') : typeof node === 'object' ? flatten(node.children) : String(node);
const text = renderer => flatten(renderer.toJSON()).replace(/\s+/g, ' ');

function fixture(t, documents = [doc()]) {
  const previousFlag = process.env.FEATURE_COPILOT_LLM;
  process.env.FEATURE_COPILOT_LLM = 'false';
  t.after(() => { if (previousFlag === undefined) delete process.env.FEATURE_COPILOT_LLM; else process.env.FEATURE_COPILOT_LLM = previousFlag; });
  const state = { documents, allowed: true, unavailable: false, clipboardFails: false };
  const calls = { db: 0, knowledge: 0, history: 0, audit: [], permission: [], copies: [], requests: [], violations: [] };
  const messages = [{ role: 'customer', content: 'Minha fibra está com lentidão, como faço o teste cabeado?', createdAt: new Date().toISOString() }];
  const modules = {
    'next/server': require('next/server'),
    '@/db': { async getDb() { calls.db++; return {}; } },
    '@/lib/platform/audit-log': { async logUnauthenticatedAction(event) { calls.audit.push(event); } },
    '@/lib/platform/conversations-service': { DbConversationsRepository: class {
      async getMessages(channel, id, limit) { assert.equal(channel, CHANNEL_NAME); assert.equal(id, ID); assert.equal(limit, 200); calls.history++; return messages; }
      async getOutcome(channel, id) { assert.equal(channel, CHANNEL_NAME); assert.equal(id, ID); return { intent: 'technical_slow' }; }
    } },
    '@/lib/platform/knowledge-service': { DbKnowledgeRepository: class {
      async list(limit) { assert.equal(limit, 200); calls.knowledge++; if (state.unavailable) throw new Error('synthetic-private-error'); return state.documents; }
    } },
    '@/lib/platform/n8n-channel-service': { CHANNEL_NAME },
    '@/lib/platform/copilot-service': copilot,
    '@/lib/platform/copilot-summary-service': { loadConversationSummary },
    '@/lib/platform/conversation-state-service': { DbConversationStateRepository: class {} },
    '@/lib/platform/session-guard': { async authorize(_request, permission) {
      calls.permission.push(permission);
      return state.allowed ? { allowed: true, user: { id: 'synthetic-operator', email: 'operator@example.invalid', role: 'Atendente' } } : { allowed: false, status: 403, error: 'Acesso negado' };
    } },
  };
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', handlerSource)(name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected handler dependency: ${name}`);
    return modules[name];
  }, compiled, compiled.exports);
  const post = body => compiled.exports.POST(new Request('https://synthetic.invalid/api/copilot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: CHANNEL_NAME, conversationId: ID, ...body }) }));
  return { state, calls, messages, post };
}

for (const action of ['ask', 'suggest']) test(`${action}: documento vencido não sustenta resposta no handler real`, async t => {
  const { post } = fixture(t, [doc({ validUntil: '2000-01-01' })]);
  const response = await post({ action, question: 'lentidão fibra teste cabeado' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.written, 'none'); assert.deepEqual(body.sources, []);
  assert.equal(body.answer, copilot.NOT_FOUND_ANSWER);
});

for (const action of ['ask', 'suggest', 'used']) test(`${action}: sem permissão não lê banco nem registra auditoria`, async t => {
  const { state, calls, post } = fixture(t); state.allowed = false;
  const response = await post({ action, question: 'lentidão fibra', kind: 'answer' });
  assert.equal(response.status, 403); assert.equal(calls.db, 0); assert.equal(calls.knowledge, 0); assert.equal(calls.history, 0); assert.deepEqual(calls.audit, []);
  assert.deepEqual(calls.permission, ['customer.read']);
});

test('suggest ignora pergunta/histórico/ator enviados pelo navegador', async t => {
  const { post, calls } = fixture(t);
  const body = await (await post({ action: 'suggest', question: 'desconto secreto', history: [{ role: 'customer', content: 'desconto secreto' }], actor: { role: 'admin' } })).json();
  assert.match(body.question, /teste cabeado/); assert.doesNotMatch(body.question, /desconto/);
  assert.equal(body.sources[0].id, 'synthetic-kb'); assert.equal(calls.history, 1);
});

test('UI pergunta, sugere e copia com fonte real do handler, sem envio', async t => {
  const { state, calls, post, messages } = fixture(t);
  const names = ['fetch', 'window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const intervals = new Set();
  let renderer;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = { matchMedia: () => ({ matches: true }), localStorage: { getItem: () => null }, addEventListener() {}, removeEventListener() {},
    setInterval: (...args) => { const timer = setInterval(...args); intervals.add(timer); return timer; }, clearInterval: timer => { clearInterval(timer); intervals.delete(timer); }, setTimeout, clearTimeout };
  globalThis.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText(value) { if (state.clipboardFails) throw new Error('synthetic clipboard denied'); calls.copies.push(value); } } } });
  globalThis.fetch = async (path, init = {}) => {
    if (path === '/api/copilot' && init.method === 'POST') { const body = JSON.parse(init.body); calls.requests.push(body.action); return post(body); }
    if (path === '/api/agent/replies') return Response.json({ items: [] });
    if (typeof path === 'string' && path.startsWith('/api/conversations')) {
      const url = new URL(path, 'https://synthetic.invalid');
      if (url.searchParams.has('id')) return Response.json({ messages, audit: null });
      return Response.json({ available: true, channelState: { enabled: false, autoReply: false, canReply: false }, items: [{ channel: CHANNEL_NAME, externalConversationId: ID, displayName: 'Cliente sintético Copiloto', lastMessage: messages[0].content, lastRole: 'customer', lastAt: messages[0].createdAt, messages: 1 }] });
    }
    calls.violations.push(String(path)); throw new Error('Unexpected request');
  };
  t.after(async () => {
    if (renderer) await act(async () => renderer.unmount());
    for (const timer of intervals) clearInterval(timer);
    for (const [name, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  await act(async () => { renderer = TestRenderer.create(React.createElement(ui.exports.AttendanceModule)); });
  const click = async label => act(async () => {
    const found = renderer.root.findAllByType('button').filter(node => flatten(node).trim() === label);
    assert.equal(found.length, 1, `Button: ${label}`); assert.notEqual(found[0].props.disabled, true); found[0].props.onClick();
  });
  const ask = async question => {
    await act(async () => renderer.root.findAllByType('input').find(node => node.props['aria-label'] === 'Pergunta ao copiloto').props.onChange({ target: { value: question } }));
    await act(async () => renderer.root.findAllByType('form').find(node => node.props.className === 'copilot-ask').props.onSubmit({ preventDefault() {} }));
  };
  await click('Copiloto');
  await ask('lentidão fibra teste cabeado');
  assert.match(text(renderer), /Lentidão fibra/); assert.match(text(renderer), /versão 3/); assert.match(text(renderer), /Procedimento sintético/);
  assert.equal(calls.audit.length, 0);
  state.clipboardFails = true; await click('Copiar');
  assert.match(text(renderer), /Não consegui copiar/); assert.equal(calls.audit.length, 0); assert.equal(calls.copies.length, 0);
  state.clipboardFails = false; await click('Copiar');
  assert.match(text(renderer), /Copiado/); assert.equal(calls.audit.length, 1); assert.equal(calls.copies.length, 1);
  assert.equal(calls.audit[0].action, 'copilot.suggestion.used'); assert.equal(calls.audit[0].actor.email, 'operator@example.invalid');
  assert.doesNotMatch(JSON.stringify(calls.audit), /Procedimento sintético|teste cabeado/);
  await click('Sugerir resposta');
  assert.match(text(renderer), /Respondendo a:.*teste cabeado/); assert.equal(calls.history, 1);
  for (const excluded of [{ status: 'draft' }, { validUntil: '2000-01-01' }, { validUntil: '2099-02-30' }]) {
    state.documents = [doc(excluded)];
    await ask('lentidão fibra teste cabeado');
    assert.match(text(renderer), /Prefiro dizer que não sei/); assert.doesNotMatch(text(renderer), /versão 3/);
  }
  state.documents = [doc()]; state.unavailable = true;
  await ask('lentidão fibra teste cabeado');
  assert.match(text(renderer), /Copiloto indisponível/); assert.doesNotMatch(text(renderer), /synthetic-private-error/);
  assert.equal(renderer.root.findAllByType('button').filter(node => flatten(node).trim() === 'Copiar').length, 0);
  assert.deepEqual(calls.violations, []);
  assert.equal(calls.requests.filter(action => action === 'used').length, 1);
  t.diagnostic(JSON.stringify({ uiActions: calls.requests, copied: calls.copies.length, audit: calls.audit.length, unexpectedRequests: calls.violations.length, externalLlm: false }));
});
