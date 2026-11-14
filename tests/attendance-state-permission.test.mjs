import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { create, act } from 'react-test-renderer';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = buildSync({ stdin: { contents: "export{LzrHubApp}from'./components/lzr-hub-app';export{AttendanceModule}from'./components/modules/attendance';", resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, logLevel: 'silent' });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { LzrHubApp, AttendanceModule } = compiled.exports;
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node ? text(node.children) : '';

async function harness(run, initialPermission = true) {
  const old = Object.fromEntries(['window', 'document', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, globalThis[key]]));
  let ui, permission = initialPermission, reads = 0;
  const pending = [];
  const state = { status: 'open', reopened: false, assigneeId: null, assigneeName: null, assignedAt: null, resolvedAt: null, resolvedBy: null };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = { location: { hash: '#/atendimento', href: 'unchanged' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {} };
  globalThis.document = { title: 'Fictício', documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input, 'https://fixture.invalid');
    if (url.pathname === '/api/auth/me') return Response.json({ authRequired: true, authenticated: true, permissions: permission ? ['customer.read', 'support.write'] : ['customer.read'], user: { id: 'qa', name: 'Fictício', email: 'qa@example.invalid', role: permission ? 'Atendente' : 'Somente leitura' } });
    if (url.pathname === '/api/agent/replies') return Response.json({ items: [] });
    if (url.pathname === '/api/conversations') {
      reads++;
      return Response.json(url.searchParams.has('id') ? { messages: [], audit: null, replyWindow: null } : { available: true, channelState: { enabled: false, autoReply: false, canReply: false }, viewer: { id: 'qa', name: 'Fictício' }, items: [{ channel: 'qa', externalConversationId: 'SYNTHETIC', displayName: 'Fictício', lastAt: '2026-11-14T00:00:00Z', messages: 0, lastMessage: '', lastRole: 'customer', state }] });
    }
    if (url.pathname === '/api/conversations/state') return new Promise(resolve => pending.push({ resolve, body: JSON.parse(init.body) }));
    throw Error('UNEXPECTED_API:' + url.pathname);
  };
  const controls = () => ui.root.findAllByType('button').filter(button => /^(Assumir|Resolver|Reabrir|Devolver à IA)/.test(text(button)) || button.props['aria-label'] === 'Resolver sem assumir');
  try {
    await act(async () => { ui = create(React.createElement(LzrHubApp)); });
    await run({ ui, pending, controls, reads: () => reads, readmit: async nextPermission => {
      permission = nextPermission;
      const access = ui.root.findByType(AttendanceModule).props.access;
      await act(async () => { await access.revalidate(access.generation, () => true); });
    } });
  } finally {
    if (ui) await act(async () => ui.unmount());
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
}

test('read-only session offers no state controls or writes with transport disabled', () => harness(async f => {
  assert.equal(f.ui.root.findByType(AttendanceModule).props.canManageState, false);
  assert.equal(f.controls().length, 0); assert.equal(f.pending.length, 0);
  assert.match(text(f.ui.toJSON()), /envio pela tela não está disponível/);
}, false));

test('writer can request state with transport disabled; revocation discards old callback and JSON', () => harness(async f => {
  assert.equal(f.ui.root.findByType(AttendanceModule).props.canManageState, true);
  const claim = f.controls().find(button => text(button) === 'Assumir').props.onClick;
  await act(async () => claim());
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].body.action, 'claim');
  let releaseBody, bodyStarted = false;
  await act(async () => f.pending[0].resolve({ ok: true, status: 200, json: () => { bodyStarted = true; return new Promise(resolve => { releaseBody = resolve; }); } }));
  assert.equal(bodyStarted, true);
  await f.readmit(false);
  assert.equal(f.ui.root.findByType(AttendanceModule).props.canManageState, false);
  assert.equal(f.controls().length, 0);
  const reads = f.reads();
  await act(async () => { claim(); releaseBody({ state: { status: 'open', assigneeId: 'qa', assigneeName: 'STALE_OWNER' } }); });
  assert.equal(f.pending.length, 1); assert.equal(f.reads(), reads);
  assert.doesNotMatch(text(f.ui.toJSON()), /STALE_OWNER|Conversa assumida/);
}));

test('same-permission readmission discards old state response without leaving controls busy', () => harness(async f => {
  await act(async () => f.controls().find(button => text(button) === 'Assumir').props.onClick());
  assert.equal(f.pending.length, 1);
  let releaseBody, bodyStarted = false;
  await act(async () => f.pending[0].resolve({ ok: true, status: 200, json: () => { bodyStarted = true; return new Promise(resolve => { releaseBody = resolve; }); } }));
  assert.equal(bodyStarted, true);
  await f.readmit(true);
  const reads = f.reads();
  await act(async () => releaseBody({ state: { status: 'open', assigneeId: 'qa', assigneeName: 'STALE_OWNER' } }));
  assert.doesNotMatch(text(f.ui.toJSON()), /STALE_OWNER|Conversa assumida/);
  assert.equal(f.reads(), reads);
  const claim = f.controls().find(button => text(button) === 'Assumir');
  assert.equal(claim.props.disabled, false);
  await act(async () => claim.props.onClick());
  assert.equal(f.pending.length, 2);
}));
