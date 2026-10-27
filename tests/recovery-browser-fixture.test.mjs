import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IxcReadonlyProvider } from '../lib/integrations/ixc/readonly-provider.ts';
import { Customer360Service } from '../lib/platform/customer360-service.ts';
import { PROJECT_ID, PROTECTED_ID_TEST_SENTINEL, RailwayGateRefusal } from '../scripts/railway-recovery-gate-target.mjs';
import { browserFixtureData, browserSeedStatements, FIXTURE_ACCOUNTS, FIXTURE_ATTENDANCES, FIXTURE_CUSTOMERS, FIXTURE_TOKEN, syntheticIxcResponse } from '../scripts/recovery-browser-fixture.mjs';
import { assertBrowserSeedTarget, browserAppEnvironment, browserInputs, startRecoveryBrowserRailway } from '../scripts/start-recovery-browser-railway.mjs';

const now = new Date('2026-10-27T21:00:00Z');
const hashes = [{ hash: 'a'.repeat(128), salt: 'b'.repeat(32) }, { hash: 'c'.repeat(128), salt: 'd'.repeat(32) }]; // Constructor fixtures, never real credentials.
const manifest = () => ({version:1,projectId:PROJECT_ID,environmentId:'10000000-0000-0000-0000-000000000001',environmentName:'lzr-qa-fixture',runnerServiceId:'10000000-0000-0000-0000-000000000002',databaseServiceId:'10000000-0000-0000-0000-000000000003',databaseVolumeId:'10000000-0000-0000-0000-000000000004',databaseHost:'lzr-qa-db-fixture.railway.internal',databasePort:5432,databaseName:'lzr_recovery_test_1234567890abcdef12345678',databaseUser:'postgres',sourceCommit:'a'.repeat(40),branch:'test/recovery-gate',nonce:'1234567890abcdef12345678',approvedAt:'2026-10-27T20:59:00Z',expiresAt:'2026-10-28T20:59:00Z',maxAdditionalUsd:5,approvalReference:'approved-synthetic-fixture'});
function environment(m = manifest()) {
  return { RECOVERY_CASE_RAILWAY_TARGET_JSON:JSON.stringify(m),RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL:`postgres://postgres:synthetic-test-only@${m.databaseHost}:5432/${m.databaseName}`,RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION:`${m.environmentId}:${m.databaseServiceId}:${m.nonce}`,RAILWAY_PROJECT_ID:m.projectId,RAILWAY_ENVIRONMENT_ID:m.environmentId,RAILWAY_ENVIRONMENT_NAME:m.environmentName,RAILWAY_SERVICE_ID:m.runnerServiceId,RAILWAY_GIT_COMMIT_SHA:m.sourceCommit,RAILWAY_GIT_BRANCH:m.branch,RAILWAY_GIT_REPO_OWNER:'LZRBBNET',RAILWAY_GIT_REPO_NAME:'lzr-hub',
    RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED:`${m.environmentId}:${m.databaseServiceId}:${m.nonce}`, PORT:'3000',
    RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH:hashes[0].hash,RECOVERY_BROWSER_OPERATOR_PASSWORD_SALT:hashes[0].salt,RECOVERY_BROWSER_READER_PASSWORD_HASH:hashes[1].hash,RECOVERY_BROWSER_READER_PASSWORD_SALT:hashes[1].salt };
}
const refused = error => error instanceof RailwayGateRefusal && !error.message.includes('synthetic-test-only');
function context() {
  const data = browserFixtureData(now), calls = [];
  const fetcher = async (url, init) => {
    const request = { method: init.method, path: new URL(url).pathname, headers: Object.fromEntries(new Headers(init.headers)), body: init.body };
    calls.push(request);
    const result = syntheticIxcResponse(request, data);
    return Response.json(result.body, { status: result.status });
  };
  const provider = new IxcReadonlyProvider({ baseUrl: 'http://127.0.0.1:19999', token: FIXTURE_TOKEN, allowedCustomerIds: FIXTURE_CUSTOMERS, fullBase: true, fetcher, retryLimit: 0, rateLimitPerMinute: 120, now: () => now.getTime() });
  return { provider, data, calls };
}

test('real readonly provider reads synthetic customer, contracts and partial20of21 snapshot through the pure HTTP fixture', async () => {
  const { provider } = context();
  const snapshot = await provider.getSnapshot('910001', 'fixture');
  assert.match(snapshot.customer.name, /SINTÉTICO/); assert.equal(snapshot.customer.status, 'S');
  assert.deepEqual(snapshot.contracts.map(row => row.status), ['A', 'CA']);
  assert.equal(snapshot.invoices.length, 20); assert.equal(snapshot.coverage.invoices.total, 21); assert.equal(snapshot.coverage.invoices.complete, false);
  assert.deepEqual(snapshot.partialSources, []); assert.equal(snapshot.payments.length, 1);
  assert.equal(snapshot.invoices.some(row => row.id === '940021'), false);
  const customer = await new Customer360Service(undefined, provider, FIXTURE_CUSTOMERS, true, () => now).get('910001');
  assert.equal(customer.reading.contractSelection, 'ambiguous'); assert.equal(customer.reading.financeComplete, false);
});
test('exact point lookup outside20, wrong-customer rejection, unknown/received/cancelled statuses remain distinct', async () => {
  const { provider } = context();
  assert.deepEqual(await provider.getInvoiceForCustomer('910001', '940021', 'fixture'), { id: '940021', customerId: '910001', status: 'A' });
  assert.equal(await provider.getInvoiceForCustomer('910002', '940021', 'fixture'), undefined);
  assert.equal(await provider.getInvoiceForCustomer('910001', '999999', 'fixture'), undefined);
  for (const [id, status] of [['940001','R'], ['940002','C'], ['940003','?']]) assert.equal((await provider.getInvoiceForCustomer('910001', id, 'fixture')).status, status);
});
test('same synthetic phone identifies Attendance customer and another unknown phone does not', async () => {
  const { provider } = context();
  for (const attendance of FIXTURE_ATTENDANCES) assert.equal((await provider.findCustomerByPhone(attendance.conversationId, 'fixture'))?.id, attendance.customerId);
  assert.equal(await provider.findCustomerByPhone('5500000999999', 'fixture'), undefined);
});
test('fixture pagination and combined overdue filters are applied rather than ignored', async () => {
  const { provider } = context();
  const invoices = await provider.listOverdueInvoices('2026-10-27', 'fixture');
  assert.equal(invoices.rows.length, 18); assert.equal(invoices.total, 18); assert.equal(invoices.truncated, false);
  assert.equal(invoices.rows.some(row => ['940001', '940002', '940003', '940004'].includes(row.id)), false);
  const first = await provider.listCustomers('', 1, 1, 'fixture'), second = await provider.listCustomers('', 2, 1, 'fixture');
  assert.equal(first.total, 2); assert.equal(first.items[0].id, '910001'); assert.equal(second.items[0].id, '910002');
});
test('fixture rejects writes, unknown resources/filters, bad tokens and malformed requests; never proxies', async () => {
  const { data } = context();
  const base = { method: 'POST', path: '/webservice/v1/cliente', headers: { authorization: `Basic ${FIXTURE_TOKEN}`, ixcsoft: 'listar' }, body: JSON.stringify({ qtype: 'id', query: '910001', oper: '=', page: '1', rp: '20', sortname: 'id', sortorder: 'asc' }) };
  assert.equal(syntheticIxcResponse(base, data).status, 200);
  for (const change of [{method:'DELETE'}, {method:'PUT'}, {path:'/webservice/v1/cliente/inserir'}, {path:'https://production.invalid/webservice/v1/cliente'}, {path:'/webservice/v1/cliente?redirect=external'}, {headers:{...base.headers,ixcsoft:'inserir'}}, {headers:{...base.headers,authorization:'Basic wrong'}}, {body:'invalid'}, {body:JSON.stringify({ ...JSON.parse(base.body), qtype:'fn_areceber.id' })}, {body:JSON.stringify({...JSON.parse(base.body),rp:'100000'})}]) assert.ok(syntheticIxcResponse({...base,...change}, data).status >= 400);
  const source = await readFile(new URL('../scripts/recovery-browser-fixture.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\(|https?:\/\/|createConnection|\.connect\(/);
});
test('seed is insert-only, parameterized, no precreated sessions/cases or destructive repair', () => {
  const statements = browserSeedStatements(hashes, now);
  assert.equal(statements.length, 47); assert.ok(statements.every(item => item.text.startsWith('insert into ')));
  assert.ok(statements.every(item => !/delete |truncate |update |on conflict|insert into (sessions|recovery_cases)/i.test(item.text)));
  assert.equal(statements[0].values[1], FIXTURE_ACCOUNTS[0].email); assert.equal(statements[1].values[3], 'Somente leitura');
  assert.equal(statements.some(item => item.text.includes(hashes[0].hash)), false);
  for (const invalid of [[], [hashes[0]], [hashes[0], hashes[0]], [{hash:'password',salt:'bad'}, hashes[1]]]) assert.throws(() => browserSeedStatements(invalid, now));
});
test('seed places the legitimate linked Attendance outside the default newest40 without future timestamps', () => {
  const statements = browserSeedStatements(hashes, now).filter(item => item.text.startsWith('insert into channel_messages'));
  const newest = [...statements].sort((a,b) => b.values[3].localeCompare(a.values[3])).slice(0,40);
  assert.equal(statements.length,42); assert.equal(newest.length,40);
  assert.ok(newest.every(item => !FIXTURE_ATTENDANCES.some(ticket => ticket.conversationId === item.values[1])));
  assert.ok(statements.every(item => Date.parse(item.values[3]) <= now.getTime()));
  assert.equal(new Set(statements.map(item=>item.values[1])).size,42);
});
test('browser bootstrap retains strict gate identity and requires separate seed acknowledgement and credential hashes', async () => {
  assert.equal(browserInputs(environment(), now).port, 3000);
  for (const overrides of [{RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED:'yes'}, {RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH:''}, {PORT:'80'}, {PORT:'3000evil'}, {RAILWAY_ENVIRONMENT_ID:PROTECTED_ID_TEST_SENTINEL}, {FEATURE_AUTH:'true'}, {PGOPTIONS:'bad'}]) assert.throws(() => browserInputs({...environment(),...overrides}, now), refused);
  await assert.rejects(() => startRecoveryBrowserRailway({}), refused); // rejects before DNS, DB, seed or spawn
});
test('child app env has real auth, pinned privateDB, only loopback syntheticIXC and no inherited secrets/side effects', () => {
  const {target} = browserInputs(environment(), now);
  const child = browserAppEnvironment(target, 'fd12::1', 19999, 3000, { PATH:'/usr/bin', HOME:'/tmp/qa', IXC_BASE_URL:'https://production.invalid', META_ACCESS_TOKEN:'must-not-pass', PGOPTIONS:'bad', NODE_OPTIONS:'bad', DATABASE_URL:'bad', HTTPS_PROXY:'bad', RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH:hashes[0].hash });
  assert.equal(child.IXC_BASE_URL, 'http://127.0.0.1:19999'); assert.equal(child.FEATURE_AUTH, 'true');
  assert.equal(new URL(child.DATABASE_URL).hostname, '[fd12::1]'); assert.equal(child.RECOVERY_CASE_SCOPE_ID, `qa-browser-${target.nonce}`);
  for (const name of ['META_ACCESS_TOKEN','PGOPTIONS','NODE_OPTIONS','HTTPS_PROXY','RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH']) assert.equal(child[name], undefined);
  for (const [name,value] of Object.entries(child)) if (name.startsWith('FEATURE_') && !['FEATURE_AUTH','FEATURE_IXC_FULL_BASE'].includes(name)) assert.equal(value, 'false');
  assert.equal(child.IXC_WRITE_ENABLED, 'false'); assert.equal(child.PILOT_MODE, 'disabled'); assert.equal(child.IXC_API_TOKEN, FIXTURE_TOKEN);
  assert.throws(() => browserAppEnvironment(target, '8.8.8.8', 19999, 3000), refused);
});
function ready(changes = {}, count = 0, scopeCount = 0) {
  const {target} = browserInputs(environment(), now), calls = [];
  const row = {database:target.databaseName,username:target.databaseUser,address:'fd12::1',port:5432,marker:target.marker,...changes};
  const client = {query:async(sql, values)=>{calls.push({sql,values});return calls.length===1?{rows:[row]}:{rowCount:calls.length===2?count:scopeCount};}};
  return {target,client,calls};
}
test('postgate seed readiness is read-only and rejects marker/identity/expiry/reuse before inserts', async () => {
  const good = ready(); await assertBrowserSeedTarget(good.client, good.target, 'fd12::1', now); assert.equal(good.calls.length, 3); assert.ok(good.calls.every(call => call.sql.startsWith('select ')));
  for (const change of [{marker:null}, {database:'production'}, {username:'other'}, {address:'fd12::2'}, {port:6543}]) { const bad=ready(change);await assert.rejects(()=>assertBrowserSeedTarget(bad.client,bad.target,'fd12::1',now),refused);assert.equal(bad.calls.length,1); }
  for (const [count, scopeCount] of [[1,0],[0,1]]) { const bad=ready({},count,scopeCount);await assert.rejects(()=>assertBrowserSeedTarget(bad.client,bad.target,'fd12::1',now),refused); }
  const expired=ready();await assert.rejects(()=>assertBrowserSeedTarget(expired.client,expired.target,'fd12::1',new Date('2026-10-29')),refused);assert.equal(expired.calls.length,0);
});
test('runner source executes unchanged gate before seed or servers, rejects dotenv, sanitizes logs and does not auto-migrate product start', async () => {
  const source = await readFile(new URL('../scripts/start-recovery-browser-railway.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('await runRailwayRecoveryGate(env)') < source.indexOf('await pool.connect()'));
  assert.ok(source.indexOf("await client.query('commit')") < source.indexOf('fixture.listen('));
  assert.match(source, /\.env\.production\.local/); assert.match(source, /fixture\.listen\(0, '127\.0\.0\.1'/);
  assert.match(source, /pg_try_advisory_xact_lock/); assert.doesNotMatch(source, /console\.error\(error\.message\)|spawn\(['"]npm|randomBytes\(|hashPassword\(/);
});
