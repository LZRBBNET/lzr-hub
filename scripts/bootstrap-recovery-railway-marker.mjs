// Separate ONE-SHOT provisioning step, only after control-plane target verification.
// Does not migrate, seed, create/drop/reset a database, or make the real gate pass.
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { assertNoAmbientPostgresEnvironment, isPrivateTestAddress, normalizedAddress, RailwayGateRefusal, validateRailwayRecoveryTarget } from './railway-recovery-gate-target.mjs';

const refuse = message => { throw new RailwayGateRefusal(`NOT RUN: ${message}`); };
export function markerBootstrapTarget(env, now = new Date()) {
  const target = validateRailwayRecoveryTarget(env, now);
  if (env.RECOVERY_CASE_RAILWAY_ALLOW_MARKER_BOOTSTRAP !== `verified-empty:${target.environmentId}:${target.databaseServiceId}:${target.databaseVolumeId}:${target.nonce}`) refuse('separate verified-empty target acknowledgement required for marker provisioning.');
  return target;
}

export async function provisionDisposableMarker(client, target, address, now = new Date()) {
  // Target is always the result of markerBootstrapTarget in the executable path.
  if (Date.parse(target.expiresAt) - now.getTime() < 60000) refuse('approval expired before marker provisioning.');
  const row = (await client.query("select current_database() as database, current_user as username, host(inet_server_addr()) as address, inet_server_port() as port, shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()")).rows[0];
  if (!row || row.database !== target.databaseName || row.username !== target.databaseUser || row.port !== target.databasePort
      || !isPrivateTestAddress(row.address) || normalizedAddress(row.address) !== normalizedAddress(address) || row.marker !== null) refuse('new database identity mismatch or pre-existing marker; no overwrite permitted.');
  const existing = await client.query("select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%' and c.relkind in ('r','p','v','m','S','f') limit 1");
  if (existing.rowCount !== 0) refuse('marker provisioning requires an empty database; no reset permitted.');
  // PostgreSQL COMMENT does not accept parameters for identifier/literal positions.
  // Recheck their strict alphabets here even though the manifest already validates them.
  if (!/^lzr_recovery_test_[a-f0-9]{24}$/.test(target.databaseName)
      || !/^lzr-recovery-disposable:[a-f0-9-]{36}:[a-f0-9-]{36}:[a-f0-9-]{36}:[a-f0-9]{24}$/.test(target.marker)) refuse('unsafe marker identifier or literal.');
  await client.query(`COMMENT ON DATABASE "${target.databaseName}" IS '${target.marker}'`);
  const confirmed = (await client.query("select shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()")).rows[0];
  if (confirmed?.marker !== target.marker) refuse('marker write was not confirmed; inspect target before retry.');
}

export async function bootstrapRailwayMarker(env = process.env) {
  assertNoAmbientPostgresEnvironment(process.env);
  const target = markerBootstrapTarget(env);
  const addresses = await lookup(target.databaseHost, { all: true });
  if (!addresses.length || addresses.some(row => !isPrivateTestAddress(row.address))) refuse('marker target DNS must resolve only to private Railway addresses.');
  const address = addresses[0].address;
  const pool = new Pool({ host: address, port: target.databasePort, database: target.databaseName, user: target.databaseUser,
    password: target.password, options: '-c search_path=public', ssl: false, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 10000,
    query_timeout: 15000, application_name: 'lzr-recovery-disposable-marker-bootstrap' });
  let client;
  try {
    client = await pool.connect(); await client.query('begin');
    const lock = await client.query("select pg_try_advisory_xact_lock(hashtext('lzr-recovery-disposable-gate')) as locked");
    if (lock.rows[0]?.locked !== true) refuse('another gate or bootstrap holds the target.');
    await provisionDisposableMarker(client, target, address);
    await client.query('commit');
    console.log('PASS: disposable marker provisioned on the separately verified empty test target. No migration or browser test has run.');
  } catch (error) { if (client) await client.query('rollback').catch(() => {}); throw error; }
  finally { if (client) client.release(); await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapRailwayMarker().catch(error => {
    console.error(error instanceof RailwayGateRefusal ? error.message : 'Marker bootstrap failed. Do not assume success; inspect only the approved test target before retrying.');
    process.exitCode = 1;
  });
}
