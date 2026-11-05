// Component/service journey with real guard/session resolver and memory persistence.
// No browser, HTTP server or PostgreSQL is involved.
// Run with the validation-only offline guard; unexpected routes fail closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync, transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { IxcReadonlyProvider } from '../lib/integrations/ixc/readonly-provider.ts';
import { Customer360Service } from '../lib/platform/customer360-service.ts';
import { MemoryChannelRepository, processChannelMessage, CHANNEL_NAME } from '../lib/platform/n8n-channel-service.ts';
import { MemorySupportMetricsRepository } from '../lib/platform/support-metrics.ts';
import { MemoryConversationStateRepository, changeConversationState, stateKey } from '../lib/platform/conversation-state-service.ts';
import { effectiveState } from '../lib/platform/conversation-state-shared.ts';
import { loadConversationSummary } from '../lib/platform/copilot-summary-service.ts';
import * as authService from '../lib/platform/auth.ts';
import * as rbacService from '../lib/platform/rbac.ts';
import * as sessionDiagnostics from '../lib/platform/session-diagnostics.ts';
import * as copilotService from '../lib/platform/copilot-service.ts';
import * as promiseService from '../lib/platform/payment-promise-service.ts';
import { loadFreshDispatchInvoices } from '../lib/platform/collection-dispatch-source.ts';
import { MemoryCollectionDispatchRepository, resolveTodayCandidates, runTodayDispatch } from '../lib/platform/collection-dispatch-service.ts';
import { createProcessor } from '../services/queue-runtime/src/processor.mjs';
import { parseRuleInput, MemoryCollectionRulesRepository } from '../lib/platform/collection-rules-service.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const built = buildSync({ stdin: { contents: `
  export {Customer360Module} from './components/modules/customer360';
  export {AttendanceModule} from './components/modules/attendance';
  export {BillingModule} from './components/modules/billing';`, resolveDir: root, loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-dom', 'react-dom/server'], logLevel: 'silent' });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports);
const { Customer360Module, AttendanceModule, BillingModule } = compiled.exports;
const NOW = new Date('2026-11-05T15:00:00Z');
const promiseHandlerSource = transformSync(readFileSync(new URL('../app/api/billing/promises/route.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const copilotHandlerSource = transformSync(readFileSync(new URL('../app/api/copilot/route.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const CUSTOMER = '10', INVOICE = '901', CONVERSATION = 'synthetic-customer-10';
const actor = { id: 'synthetic-agent', name: 'Ana Teste', email: 'ana@example.invalid', role: 'Supervisor' };
// Use the same checked-in recipe intended for the isolated demo; no SQL seed.
const rulesRepository = new MemoryCollectionRulesRepository();
const rule = await rulesRepository.saveVersion(parseRuleInput(JSON.parse(readFileSync(new URL('../docs/demo/isolated-rule-recipe.json', import.meta.url), 'utf8'))), actor.id);
const flatten = node => node == null ? '' : Array.isArray(node) ? node.map(flatten).join(' ') : typeof node === 'object' ? flatten(node.children) : String(node);
const content = renderer => flatten(renderer.toJSON()).replace(/\s+/g, ' ');
const button = (renderer, label) => {
  const matches = renderer.root.findAllByType('button').filter(node => flatten(node).includes(label));
  assert.equal(matches.length, 1, `Expected one button: ${label}`);
  assert.notEqual(matches[0].props.disabled, true, `${label} must be enabled`);
  return matches[0];
};
const click = async (renderer, label) => act(async () => { button(renderer, label).props.onClick(); });

test('composição: Cliente 360 → humano responsável → promessa → pagamento fora da próxima régua', async t => {
  const savedGlobals = Object.fromEntries(['fetch', 'window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const flags = { FEATURE_AUTH: 'true', PILOT_MODE: 'disabled', FEATURE_LLM_INTENT: 'false', FEATURE_LANGFUSE: 'false', FEATURE_QUEUES: 'false',
    QUEUE_SERVICE_URL: 'https://queue.invalid', QUEUE_SERVICE_SECRET: 'synthetic-only', TZ: 'America/Sao_Paulo' };
  const previousFlags = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]]));
  Object.assign(process.env, flags);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const timers = new Set();
  const mounted = new Set();
  globalThis.window = {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null }, addEventListener() {}, removeEventListener() {},
    setInterval: (...args) => { const timer = setInterval(...args); timers.add(timer); return timer; },
    clearInterval: timer => { clearInterval(timer); timers.delete(timer); },
    setTimeout, clearTimeout,
  };
  globalThis.document = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} };
  t.after(async () => {
    for (const renderer of mounted) await act(async () => renderer.unmount());
    for (const timer of timers) clearInterval(timer);
    for (const [key, descriptor] of Object.entries(savedGlobals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
    for (const [key, value] of Object.entries(previousFlags)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const mount = async (Component, props = {}) => {
    let renderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)); });
    mounted.add(renderer);
    return renderer;
  };
  const unmount = async renderer => { await act(async () => renderer.unmount()); mounted.delete(renderer); };

  const state = { paid: false, outage: false, invoiceStatus: undefined };
  const transportCalls = [], uiCalls = [], violations = [], runs = [], summaries = [], queued = [];
  const promiseAudits = [], promiseResponses = [], permissions = [];
  let sends = 0, promiseDbCalls = 0, continuationCalls = 0, evidenceReads = 0;
  const reject = message => { violations.push(message); throw new Error(message); };
  const provider = new IxcReadonlyProvider({ baseUrl: 'https://ixc.invalid', token: 'synthetic',
    allowedCustomerIds: [CUSTOMER], retryLimit: 0, rateLimitPerMinute: 1000,
    fetcher: async (url, init) => {
      const endpoint = new URL(url);
      if (endpoint.hostname !== 'ixc.invalid' || init.method !== 'POST' || new Headers(init.headers).get('ixcsoft') !== 'listar') return reject('Unexpected synthetic IXC operation');
      const resource = endpoint.pathname.split('/').at(-1), body = JSON.parse(init.body);
      transportCalls.push({ resource, qtype: body.qtype, command: 'listar' });
      if (resource === 'fn_areceber' && state.outage) return new Response('synthetic outage', { status: 503 });
      const records = {
        cliente: [{ id: CUSTOMER, razao: 'Cliente sintético integrado', ativo: 'S', cnpj_cpf: 'TEST-10', cidade: '1', bairro: 'Centro', email: 'cliente@example.invalid' }],
        cidade: [{ id: '1', nome: 'Cidade sintética' }],
        cliente_contrato: [{ id: '501', id_cliente: CUSTOMER, contrato: 'Plano sintético', status: 'A' }],
        radusuarios: [{ id: '601', id_cliente: CUSTOMER, login: 'synthetic-login', online: 'S', conexao: 'OLT sintética' }],
        su_oss_chamado: [{ id: '701', id_cliente: CUSTOMER, status: 'A', assunto: 'Visita sintética', data_abertura: '2026-11-03' }],
        fn_areceber: [{ id: INVOICE, id_cliente: CUSTOMER, id_contrato: '501', status: state.invoiceStatus ?? (state.paid ? 'R' : 'A'), data_vencimento: '2026-11-04', valor: '50', valor_aberto: state.paid ? '0' : '50' }],
        fn_movim_finan: state.paid ? [{ id: '801', id_receber: INVOICE, data: '2026-11-05', valor: '50', tipo_recebimento: 'PIX' }] : [],
      };
      if (!(resource in records)) return reject(`Unexpected synthetic resource: ${resource}`);
      const openOnly = body.qtype === 'fn_areceber.id_cliente' && JSON.stringify(body.grid_param).includes('status');
      const rows = resource === 'fn_areceber' && openOnly && state.paid ? [] : records[resource];
      return Response.json({ registros: rows, total: rows.length });
    } });
  const customers = new Customer360Service(undefined, provider, [CUSTOMER], false, () => NOW);
  const channel = new MemoryChannelRepository(), metrics = new MemorySupportMetricsRepository();
  const states = new MemoryConversationStateRepository(), promises = new promiseService.MemoryPaymentPromiseRepository();
  const ledger = new MemoryCollectionDispatchRepository();
  // The real #39 GET/POST handler and real session guard; DB, runtime factory, audit and
  // wall clock are injected. Repositories and all responses remain in memory.
  const require = createRequire(import.meta.url);
  const authRepository = new authService.MemoryAuthRepository();
  authRepository.users.push({...actor,active:true,passwordHash:'unused',passwordSalt:'unused',mustChangePassword:false});
  const sessionToken = 'synthetic-journey-session';
  authRepository.sessions.set(authService.hashToken(sessionToken),{userId:actor.id,expiresAt:'2099-01-01T00:00:00Z'});
  const guardModules = {
    '../../db/index.ts': {async getDb(){return {};}},
    './auth.ts': {...authService,DbAuthRepository:class{constructor(){return authRepository;}}},
    './rbac.ts': rbacService, './session-diagnostics.ts': sessionDiagnostics,
  };
  const compiledGuard={exports:{}};
  const guardSource=transformSync(readFileSync(new URL('../lib/platform/session-guard.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
  new Function('require','module','exports',guardSource)(name=>{assert.ok(Object.hasOwn(guardModules,name));return guardModules[name];},compiledGuard,compiledGuard.exports);
  const realGuard=compiledGuard.exports;
  const withSession=init=>({...init,headers:{...Object.fromEntries(new Headers(init.headers)),cookie:`lzr_session=${sessionToken}`}});
  const handlerModules = {
    'next/server': require('next/server'), 'node:crypto': require('node:crypto'),
    '@/db': { async getDb() { promiseDbCalls++; return {}; } },
    '@/lib/integrations/ixc/runtime': { getIxcRuntime: () => ({ provider }) },
    '@/lib/platform/payment-promise-service': { ...promiseService, DbPaymentPromiseRepository: class { constructor() { return promises; } } },
    '@/lib/platform/audit-log': { async logUnauthenticatedAction(event) { promiseAudits.push(event); } },
    '@/lib/platform/session-guard': { async authorize(request, permission) { permissions.push(permission); return realGuard.authorize(request,permission); } },
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW.toISOString()])); }
    static now() { return NOW.getTime(); }
  }
  const promiseHandler = { exports: {} };
  new Function('require', 'module', 'exports', 'Date', promiseHandlerSource)(name => {
    assert.ok(Object.hasOwn(handlerModules, name), `Unexpected handler dependency: ${name}`);
    return handlerModules[name];
  }, promiseHandler, promiseHandler.exports, FixedDate);
  const conversations = {
    getMessages: async (source, id, limit) => (await channel.getHistory(source, id)).slice(-limit),
    getAudit: async (source, id) => metrics.outcomes.findLast(item => item.channel === source && item.externalConversationId === id),
  };
  const summaryState = { allowed: true, unavailable: false, dbReads: 0 };
  const copilotModules = {
    'next/server': require('next/server'),
    '@/db': { async getDb() { summaryState.dbReads++; if (summaryState.unavailable) throw new Error('synthetic-summary-storage-error'); return {}; } },
    '@/lib/platform/audit-log': { async logUnauthenticatedAction() { return reject('Unexpected summary audit'); } },
    '@/lib/platform/conversations-service': { DbConversationsRepository: class { constructor() { return conversations; } } },
    '@/lib/platform/conversation-state-service': { DbConversationStateRepository: class { constructor() { return states; } } },
    '@/lib/platform/knowledge-service': { DbKnowledgeRepository: class { constructor() { reject('Summary must not query knowledge'); } } },
    '@/lib/platform/n8n-channel-service': { CHANNEL_NAME },
    '@/lib/platform/copilot-service': copilotService,
    '@/lib/platform/copilot-summary-service': { loadConversationSummary },
    '@/lib/platform/session-guard': { async authorize(request, permission) {
      assert.equal(permission, 'customer.read');
      return summaryState.allowed ? realGuard.authorize(request,permission) : { allowed: false, status: 403, error: 'Acesso negado' };
    } },
  };
  const copilotHandler = { exports: {} };
  new Function('require', 'module', 'exports', copilotHandlerSource)(name => {
    assert.ok(Object.hasOwn(copilotModules, name), `Unexpected Copilot dependency: ${name}`);
    return copilotModules[name];
  }, copilotHandler, copilotHandler.exports);
  const summaryRequest = () => new Request('https://synthetic.invalid/api/copilot', { method: 'POST', headers: { 'content-type': 'application/json',cookie:`lzr_session=${sessionToken}` }, body: JSON.stringify({ action: 'summary', channel: CHANNEL_NAME, conversationId: CONVERSATION }) });
  const getState = async () => effectiveState(await states.get(CHANNEL_NAME, CONVERSATION), await states.lastCustomerAt(CHANNEL_NAME, CONVERSATION));

  // In-process facade, with the actual promise handler. No HTTP server,
  // SQL, Redis or BullMQ worker is started. Sessions resolve from memory.
  globalThis.fetch = async (path, init = {}) => {
    if (path === 'https://queue.invalid/v1/actions' && init.method === 'POST') {
      const action = JSON.parse(init.body);
      assert.equal(action.action, 'enqueue');
      assert.equal(action.job.queue, 'billing-reminders');
      queued.push(structuredClone(action.job));
      return Response.json({ ok: true });
    }
    if (typeof path !== 'string' || !path.startsWith('/api/')) return reject('External UI request forbidden');
    const url = new URL(path, 'https://synthetic.invalid'), method = init.method ?? 'GET';
    init=withSession(init);
    const required=method==='POST'?(url.pathname==='/api/conversations/state'||url.pathname==='/api/customers'?'support.write':'billing.write-demo'):'customer.read';
    const access=await realGuard.authorize(new Request(url,init),url.pathname==='/api/copilot'?'customer.read':required);
    assert.equal(access.allowed,true,'Synthetic session and role must authorize every UI facade request');
    const body = init.body ? JSON.parse(init.body) : {};
    uiCalls.push({ path: url.pathname, method, action: body.action });
    if (url.pathname === '/api/customers') {
      if (method === 'POST' && body.action === 'refresh' && body.id === CUSTOMER) return Response.json(await customers.refresh(CUSTOMER));
      if (method === 'GET') return Response.json(url.searchParams.has('id') ? await customers.get(url.searchParams.get('id')) : await customers.list());
    }
    if (url.pathname === '/api/agent/replies' && method === 'GET') return Response.json({ items: [] });
    if (url.pathname === '/api/conversations' && method === 'GET') {
      const messages = await channel.getHistory(CHANNEL_NAME, CONVERSATION);
      const audit = await conversations.getAudit(CHANNEL_NAME, CONVERSATION);
      if (url.searchParams.has('id')) {
        assert.equal(url.searchParams.get('id'), CONVERSATION);
        return Response.json({ messages, audit });
      }
      return Response.json({ available: true, viewer: actor, channelState: { enabled: false, autoReply: false, canReply: false }, items: [{
        channel: CHANNEL_NAME, externalConversationId: CONVERSATION, displayName: 'Cliente sintético integrado',
        lastMessage: messages.at(-1)?.content, lastRole: messages.at(-1)?.role, lastAt: messages.at(-1)?.createdAt,
        lastCustomerMessage: messages[0]?.content, lastCustomerAt: messages[0]?.createdAt,
        messages: messages.length, handoff: audit?.handoff, state: await getState(),
      }] });
    }
    if (url.pathname === '/api/conversations/state' && method === 'POST' && body.action === 'claim') {
      assert.equal(body.conversationId, CONVERSATION);
      const result = await changeConversationState(states, { channel: CHANNEL_NAME, conversationId: CONVERSATION, action: 'claim', actor });
      assert.equal(result.ok, true);
      return Response.json({ state: await getState() });
    }
    if (url.pathname === '/api/copilot' && method === 'POST' && body.action === 'summary') {
      assert.equal(body.conversationId, CONVERSATION);
      assert.equal(body.channel, CHANNEL_NAME);
      const response = await copilotHandler.exports.POST(new Request(url, init));
      assert.equal(response.status, 200);
      const result = await response.clone().json();
      assert.equal(result.available, true);
      summaries.push(result.summary);
      return response;
    }
    if (url.pathname === '/api/billing/invoices/reissue' && method === 'GET') return Response.json({ available: false, detail: 'Disabled in synthetic journey', items: [] });
    if (url.pathname === '/api/billing/promises') {
      assert.ok(['GET', 'POST'].includes(method));
      const response = await promiseHandler.exports[method](new Request(url, init));
      if (method === 'POST') promiseResponses.push({ action: body.action, status: response.status });
      return response;
    }
    if (url.pathname === '/api/billing/rules' && method === 'GET') return Response.json({ available: true, rule });
    if (url.pathname === '/api/billing/collections/dispatch') {
      try {
        const invoices = await loadFreshDispatchInvoices(provider, [CUSTOMER]);
        if (method === 'GET') return Response.json({ available: true, period: '30d', today: { scheduledFor: '2026-11-05', candidates: resolveTodayCandidates(rule, invoices, NOW).length }, indicators: { total: ledger.rows.length, byStep: {} } });
        if (method === 'POST' && body.action === 'run') {
          const result = await runTodayDispatch(rule, invoices, ledger, NOW, 'synthetic-dispatch');
          runs.push(result); return Response.json(result);
        }
      } catch { return Response.json({ error: 'Fonte indisponível: nenhuma cobrança registrada.' }, { status: 503 }); }
    }
    return reject(`Unexpected UI route: ${method} ${url.pathname}`);
  };

  await t.test('handler de resumo nega antes da leitura e sanitiza indisponibilidade', async () => {
    summaryState.allowed = false;
    assert.equal((await copilotHandler.exports.POST(summaryRequest())).status, 403);
    assert.equal(summaryState.dbReads, 0);
    summaryState.allowed = true; summaryState.unavailable = true;
    const response = await copilotHandler.exports.POST(summaryRequest());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.available, false); assert.equal(body.summary, undefined);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-summary-storage-error/);
    summaryState.unavailable = false;
  });

  await t.test('sessão ausente e senha provisória negadas antes de ler dados da jornada',async()=>{
    const before=promiseDbCalls;
    assert.equal((await promiseHandler.exports.GET(new Request('https://synthetic.invalid/api/billing/promises'))).status,401);
    authRepository.users[0].mustChangePassword=true;
    assert.equal((await copilotHandler.exports.POST(summaryRequest())).status,403);
    assert.equal(promiseDbCalls,before);authRepository.users[0].mustChangePassword=false;
  });
  let customerUi, attendanceUi, billingUi, dispatchUi;
  await t.test('cliente exibe contrato, conexão, dívida e OS do mesmo cadastro', async () => {
    customerUi = await mount(Customer360Module);
    await click(customerUi, 'Cliente sintético integrado');
    const text = content(customerUi);
    for (const expected of ['Plano sintético', 'synthetic-login', 'Online', '901', 'Visita sintética', 'R$ 50,00']) assert.ok(text.includes(expected), expected);
    assert.equal((await customers.get(CUSTOMER)).finance.overdueAmount, 50);
  });
  await t.test('pedido humano gera motivo/contexto e assumir atualiza o responsável', async () => {
    const result = await processChannelMessage(channel, { externalConversationId: CONVERSATION, text: 'Quero falar com um atendente humano sobre minha fatura 901.', idempotencyKey: 'synthetic-inbound', correlationId: 'synthetic-handoff' }, metrics, { autoReply: false, send: async () => { sends++; return reject('Sending forbidden'); } });
    assert.equal(result.handoff, true);
    states.conversations.set(stateKey(CHANNEL_NAME, CONVERSATION), (await channel.getHistory(CHANNEL_NAME, CONVERSATION))[0].createdAt);
    attendanceUi = await mount(AttendanceModule);
    await click(attendanceUi, 'Copiloto');
    await click(attendanceUi, 'Resumir para transferir');
    assert.match(content(attendanceUi), /Cliente pediu atendente/);
    assert.match(content(attendanceUi), /ainda não atribuído/);
    assert.match(content(attendanceUi), /fatura 901/);
    await click(attendanceUi, 'Assumir');
    await click(attendanceUi, 'Resumir para transferir');
    assert.match(content(attendanceUi), /Responsável atual: Ana Teste/);
    assert.equal(states.audits.length, 1);
  });
  await t.test('régua captura job em fila falsa; repetir não duplica ledger nem enqueue', async () => {
    dispatchUi = await mount(BillingModule, { view: 'regua' });
    process.env.FEATURE_QUEUES = 'true'; // Only the exact queue.invalid URL above is accepted.
    await click(dispatchUi, 'Rodar disparo');
    assert.equal(runs[0].candidates, 1); assert.equal(runs[0].recorded, 1); assert.equal(runs[0].enqueued, 1);
    assert.match(content(dispatchUi), /1 enfileirado/);
    await click(dispatchUi, 'Rodar disparo');
    assert.equal(runs[1].recorded, 0); assert.equal(runs[1].duplicates, 1);
    assert.equal(ledger.rows.length, 1); assert.equal(queued.length, 1);
    assert.equal(queued[0].payload.schemaVersion, 1); assert.equal(queued[0].payload.ruleVersion, rule.version);
    process.env.FEATURE_QUEUES = 'false';
  });
  await t.test('promessa criada pela UI preserva dia civil e rejeita data inexistente', async () => {
    billingUi = await mount(BillingModule, { view: 'acoes-cobranca' });
    await click(billingUi, 'Promessa de pagamento');
    const fill = async (predicate, value) => act(async () => billingUi.root.findAllByType('input').find(predicate).props.onChange({ target: { value } }));
    await fill(node => node.props.placeholder === 'ex.: 4821', INVOICE);
    await fill(node => node.props.placeholder === 'ex.: 21857', CUSTOMER);
    await fill(node => node.props.type === 'date', '2026-11-31');
    await click(billingUi, 'Registrar promessa');
    assert.equal(promises.rows.length, 0);
    assert.match(content(billingUi), /data válida/);
    await fill(node => node.props.type === 'date', '2026-11-05');
    const dbBefore = promiseDbCalls, auditBefore = promiseAudits.length;
    for (const [status, expected] of [['R', 409], ['C', 409], ['X', 503]]) {
      state.invoiceStatus = status;
      await click(billingUi, 'Registrar promessa');
      assert.equal(promiseResponses.at(-1).status, expected);
      assert.equal(promises.rows.length, 0);
      assert.equal(promiseDbCalls, dbBefore); assert.equal(promiseAudits.length, auditBefore);
    }
    state.invoiceStatus = undefined; state.outage = true;
    await click(billingUi, 'Registrar promessa');
    assert.equal(promiseResponses.at(-1).status, 503);
    assert.equal(promiseDbCalls, dbBefore); assert.equal(promises.rows.length, 0);
    state.outage = false;
    assert.equal((await provider.getSnapshot(CUSTOMER, 'synthetic-before-create')).invoices[0].status, 'A');
    await click(billingUi, 'Registrar promessa');
    assert.equal(promises.rows.length, 1);
    assert.equal(promiseResponses.at(-1).status, 201);
    assert.equal(promiseAudits.filter(event => event.action === 'billing.promise.create').length, 1);
    assert.match(content(billingUi), /promete pagar em 05\/11\/2026/);
  });
  await t.test('fonte indisponível preserva promessa e impede novo registro da régua', async () => {
    state.outage = true;
    await click(billingUi, 'Conferir no IXC');
    assert.match(content(billingUi), /1 sem confirmação/);
    assert.equal(promises.rows[0].status, 'pending');
    await click(dispatchUi, 'Rodar disparo');
    assert.match(content(dispatchUi), /Fonte indisponível/);
    assert.equal(ledger.rows.length, 1);
    state.outage = false;
  });
  await t.test('pagamento fresco cumpre promessa e sai da régua apesar do cache antigo', async () => {
    state.paid = true;
    assert.equal((await provider.getSnapshot(CUSTOMER, 'synthetic-cached')).invoices[0].status, 'A');
    await click(billingUi, 'Conferir no IXC');
    assert.equal(promises.rows[0].status, 'fulfilled');
    assert.match(content(billingUi), /1 cumprida/);
    assert.match(content(billingUi), /Nenhuma promessa pendente/);
    await click(dispatchUi, 'Rodar disparo');
    assert.equal(runs.at(-1).candidates, 0); assert.equal(runs.at(-1).recorded, 0); assert.equal(runs.at(-1).enqueued, 0);
    assert.equal(ledger.rows.length, 1, 'Historical ledger retained; no old-job cancellation is claimed');
    await click(customerUi, 'Ler de novo');
    assert.equal((await customers.get(CUSTOMER)).finance.overdueAmount, 0);
    assert.match(content(customerUi), /PIX/);
    assert.match(content(customerUi), /R\$ 0,00/);
  });
  await t.test('mesmo job capturado antes do pagamento é bloqueado pelo processor real', async () => {
    const input = queued[0];
    const job = { queueName: input.queue, name: input.name, attemptsMade: 0, data: structuredClone(input) };
    const processor = createProcessor('billing-reminders', {
      now: () => NOW,
      readEvidence: async (context, options) => {
        evidenceReads++;
        assert.equal(options.requestedAt, NOW.toISOString());
        const invoice = await provider.getInvoiceForCustomer(context.customerId, context.invoiceId, 'synthetic-worker-read');
        const step = rule.steps.find(item => item.id === context.stepId);
        const decision = ledger.rows.find(item => item.invoiceId === context.invoiceId && item.stepId === context.stepId && item.scheduledFor === context.scheduledFor);
        assert.ok(step); assert.ok(decision);
        return { complete: true, observedAt: NOW.toISOString(), invoice: { ...invoice, dueAt: '2026-11-04' },
          intent: { invoiceId: decision.invoiceId, customerId: decision.customerId, ruleId: rule.id,
            ruleVersion: rule.version, stepId: step.id, scheduledFor: decision.scheduledFor, channel: step.channel,
            templateId: step.templateId, idempotencyKey: `${decision.invoiceId}:${step.id}:${decision.scheduledFor}`,
            offsetDays: step.offsetDays, active: step.active, current: true, cancelled: false } };
      },
      continueEligible: async () => { continuationCalls++; return { simulated: true, delivered: false }; },
    });
    assert.equal(state.paid, true);
    await assert.rejects(processor(job), { code: 'BILLING_INVOICE_NOT_OPEN' });
    job.attemptsMade++;
    await assert.rejects(processor(job), { code: 'BILLING_INVOICE_NOT_OPEN' });
    assert.equal(evidenceReads, 2); assert.equal(continuationCalls, 0);
    await assert.rejects(createProcessor('billing-reminders', { now: () => NOW })(job), { code: 'BILLING_EVIDENCE_SOURCE_UNAVAILABLE' });
    // Control proves that eligible evidence can reach only the fake continuation.
    state.paid = false;
    assert.deepEqual(await processor(job), { simulated: true, delivered: false });
    assert.equal(continuationCalls, 1); state.paid = true;
    assert.ok(permissions.includes('billing.write-demo'));
    for (const renderer of [customerUi, attendanceUi, billingUi, dispatchUi]) await unmount(renderer);
    assert.equal(sends, 0); assert.deepEqual(violations, []);
    assert.ok(transportCalls.every(call => call.command === 'listar'));
    assert.equal(summaries.length, 2);
    t.diagnostic(JSON.stringify({ synthetic: true, uiRequests: uiCalls.length, fakeReadonlyCalls: transportCalls.length, summaries: summaries.length, sends, unexpectedRequests: violations.length, promise: promises.rows[0].status, finalCandidates: runs.at(-1).candidates, historicalLedgerRows: ledger.rows.length, capturedJobs: queued.length, blockedPaidAttempts: 2, evidenceReads, fakeEligibleContinuations: continuationCalls }));
  });
});
