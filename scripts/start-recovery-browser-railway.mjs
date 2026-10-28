// ONE-SHOT homologation entrypoint. Never use npm start (which auto-migrates) here.
// Runs the unchanged empty-DB gate first, seeds synthetic data, then the real app.
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { access, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { runRailwayRecoveryGate } from './test-recovery-cases-railway.mjs';
import { assertNoAmbientPostgresEnvironment, isPrivateTestAddress, normalizedAddress, RailwayGateRefusal, validateRailwayRecoveryTarget } from './railway-recovery-gate-target.mjs';
import { browserFixtureData, browserSeedStatements, FIXTURE_CUSTOMERS, FIXTURE_TOKEN, syntheticIxcResponse } from './recovery-browser-fixture.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const refuse = message => { throw new RailwayGateRefusal(`NOT RUN: ${message}`); };
export function browserInputs(env, now = new Date()) {
  const target = validateRailwayRecoveryTarget(env, now);
  if (env.RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED !== `${target.environmentId}:${target.databaseServiceId}:${target.nonce}`) refuse('explicit synthetic browser seed acknowledgement required.');
  const port = Number(env.PORT);
  if (!/^\d+$/.test(env.PORT ?? '') || !Number.isSafeInteger(port) || port < 1024 || port > 65535) refuse('explicit unprivileged test-app PORT required.');
  const credentials = [
    { hash: env.RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH, salt: env.RECOVERY_BROWSER_OPERATOR_PASSWORD_SALT },
    { hash: env.RECOVERY_BROWSER_READER_PASSWORD_HASH, salt: env.RECOVERY_BROWSER_READER_PASSWORD_SALT },
  ];
  let seed; try { seed = browserSeedStatements(credentials, now); } catch { refuse('two separately provisioned synthetic account hashes required; no passwords are generated here.'); }
  return { target, port, seed };
}

export function browserAppEnvironment(target, address, fixturePort, appPort, platform = {}) {
  if (!isPrivateTestAddress(address) || !Number.isInteger(fixturePort) || fixturePort < 1024 || fixturePort > 65535) refuse('verified private database IP and local fixture port required.');
  const host = address.includes(':') ? `[${address}]` : address;
  // pg-connection-string preserves IPv6 authority brackets as part of its host.
  // Override only that parser field with the SAME already validated/pinned IP;
  // do not introduce a new DNS target, fallback or inherited connection setting.
  const database = `postgresql://${encodeURIComponent(target.databaseUser)}:${encodeURIComponent(target.password)}@${host}:${target.databasePort}/${target.databaseName}${address.includes(':') ? `?host=${encodeURIComponent(address)}` : ''}`;
  // Build a new environment rather than spreading Railway/inherited secrets. No PG*, proxy,
  // NODE_OPTIONS, webhook tokens, real IXC, LLM, Meta, Evolution or email config survives.
  return {
    ...(platform.PATH ? { PATH: platform.PATH } : {}), ...(platform.HOME ? { HOME: platform.HOME } : {}),
    NODE_ENV: 'production', TZ: 'UTC', PORT: String(appPort), DATABASE_URL: database,
    LZR_ENV: 'staging', NEXT_PUBLIC_LZR_ENV: 'staging', LZR_RUNTIME_MODE: 'mock',
    FEATURE_AUTH: 'true', RECOVERY_CASE_SCOPE_ID: `qa-browser-${target.nonce}`,
    IXC_MODE: 'staging-readonly', IXC_BASE_URL: `http://127.0.0.1:${fixturePort}`, IXC_API_TOKEN: FIXTURE_TOKEN,
    IXC_HTTP_METHOD: 'POST', IXC_ALLOWED_CUSTOMER_IDS: FIXTURE_CUSTOMERS.join(','),
    // Whole-base queries cover only this non-proxy fixture's TWO synthetic customers.
    FEATURE_IXC_FULL_BASE: 'true', IXC_RATE_LIMIT_PER_MINUTE: '120', IXC_RETRY_LIMIT: '0', IXC_CACHE_TTL_SECONDS: '30',
    IXC_WRITE_ENABLED: 'false', FEATURE_IXC_WRITE: 'false', IXC_SYNC_SCHEDULE_ENABLED: 'false', PILOT_MODE: 'disabled',
    FEATURE_META_WHATSAPP: 'false', FEATURE_N8N_CHANNEL: 'false', FEATURE_N8N_AUTOREPLY: 'false', FEATURE_ATTENDANT_REPLY: 'false',
    FEATURE_TELEGRAM_ALERTS: 'false', FEATURE_LLM_INTENT: 'false', FEATURE_LANGFUSE: 'false', FEATURE_CHATWOOT: 'false',
    FEATURE_EVOLUTION: 'false', FEATURE_QUEUES: 'false', FEATURE_PGVECTOR: 'false', FEATURE_AGENT_HOMOLOGATION_PROFILES: 'false',
    WRANGLER_WRITE_LOGS: 'false', RAILWAY_GIT_COMMIT_SHA: target.sourceCommit,
  };
}

export async function assertBrowserSeedTarget(client, target, address, now = new Date()) {
  if (Date.parse(target.expiresAt) - now.getTime() < 60000) refuse('approval expired before synthetic seed.');
  const row = (await client.query("select current_database() as database, current_user as username, host(inet_server_addr()) as address, inet_server_port() as port, shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()")).rows[0];
  if (!row || row.database !== target.databaseName || row.username !== target.databaseUser || row.port !== target.databasePort
      || !isPrivateTestAddress(row.address) || normalizedAddress(row.address) !== normalizedAddress(address) || row.marker !== target.marker) refuse('post-gate database identity or marker changed.');
  const existing = await client.query("select 1 from users union all select 1 from sessions union all select 1 from support_tickets union all select 1 from channel_messages union all select 1 from payment_promises limit 1");
  if (existing.rowCount !== 0) refuse('browser seed tables are not empty; no reset, update or reuse is permitted.');
  const scope = await client.query('select 1 from recovery_cases where scope_id=$1 limit 1', [`qa-browser-${target.nonce}`]);
  if (scope.rowCount !== 0) refuse('browser scope already exists; inspect instead of restarting.');
}

function fixtureServer(data) {
  return createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.socket.remoteAddress !== '127.0.0.1') { send(403, { error: 'Loopback fixture only' }); return; }
    let body = '', bytes = 0;
    try {
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 16384) { send(413, { error: 'Fixture request too large' }); return; } body += chunk.toString('utf8'); }
      const result = syntheticIxcResponse({ method: request.method, path: request.url, headers: request.headers, body }, data);
      send(result.status, result.body);
    } catch { if (!response.headersSent) send(400, { error: 'Invalid fixture request' }); }
  });
}

export async function startRecoveryBrowserRailway(env = process.env) {
  assertNoAmbientPostgresEnvironment(process.env);
  const { target, port, seed } = browserInputs(env);
  // vinext start loads these files even with a sanitized child environment.
  const files = await readdir(ROOT);
  if (files.some(name => ['.env', '.env.local', '.env.production', '.env.production.local'].includes(name))) refuse('dotenv files must be absent from the isolated deployment artifact.');
  await access(new URL('../dist/server/index.js', import.meta.url));
  await access(new URL('../node_modules/vinext/dist/cli.js', import.meta.url));
  // This promise must resolve in THIS invocation. No env boolean or hand-written PASS receipt.
  // Restart after migration will fail the unchanged empty-database check, by design.
  await runRailwayRecoveryGate(env);
  console.log('PASS: real PostgreSQL gate completed; preparing synthetic authenticated browser stage.');
  const addresses = await lookup(target.databaseHost, { all: true });
  if (!addresses.length || addresses.some(row => !isPrivateTestAddress(row.address))) refuse('post-gate database DNS is not private.');
  const address = addresses[0].address;
  const pool = new Pool({ host: address, port: target.databasePort, database: target.databaseName, user: target.databaseUser, password: target.password,
    options: '-c search_path=public', ssl: false, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 10000, application_name: 'lzr-recovery-browser-synthetic-seed' });
  let client;
  try {
    client = await pool.connect(); await client.query('begin');
    const lock = await client.query("select pg_try_advisory_xact_lock(hashtext('lzr-recovery-disposable-gate')) as locked");
    if (lock.rows[0]?.locked !== true) refuse('another disposable gate runner is active.');
    await assertBrowserSeedTarget(client, target, address);
    for (const statement of seed) await client.query(statement.text, statement.values);
    await client.query('commit');
  } catch (error) { if (client) await client.query('rollback').catch(() => {}); throw error; }
  finally { if (client) client.release(); await pool.end(); }
  console.log('PASS: two synthetic accounts, two identified target conversations, forty newer unrelated conversations and one synthetic historical promise seeded. No credentials logged.');
  const fixture = fixtureServer(browserFixtureData());
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  let child, timer, forceTimer;
  const stop = () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000); forceTimer.unref(); } };
  try {
    const childEnv = browserAppEnvironment(target, address, fixture.address().port, port, env);
    child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vinext/dist/cli.js', import.meta.url)), 'start', '--hostname', '0.0.0.0', '--port', String(port)], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    // Product errors may contain request/driver details. Keep this QA process log secret-free.
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    timer = setTimeout(stop, Math.max(0, Date.parse(target.expiresAt) - Date.now()));
    console.log('Synthetic app process launched. Readiness and browser checks NOT YET VERIFIED. Expiry stops the app, not Railway billing; external cleanup remains required.');
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (code !== 0) throw new Error('Synthetic test app stopped; inspect approved environment without printing secrets.');
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); stop();
    fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startRecoveryBrowserRailway().catch(error => {
    console.error(error instanceof RailwayGateRefusal ? error.message : 'Browser homologation failed. No browser success or cleanup assumed. Inspect the isolated environment before retrying.');
    process.exitCode = 1;
  });
}
