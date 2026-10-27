// Guards for ONE explicitly approved disposable Railway target. Not an auth boundary
// against an administrator who can forge environment variables or database metadata.
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

export const PROJECT_ID = 'fd218da3-58f8-4a2a-9910-d92908acde96';
// Exact denylist retained as digests so public source does not expose production identities.
// The synthetic sentinel exercises the same comparison in public tests.
export const PROTECTED_ID_TEST_SENTINEL = '00000000-0000-0000-0000-000000000000';
const PROTECTED_ID_HASHES = new Set([
  '592b6f644ca87f01ccdd8af626f013319edd4f7bc0a5a8dd72775f47fdd7a038',
  '7d78a6b1170c634e04f54bf6d246e124eeaee750086e033bb4387eb53ee05dae',
  '2f4362541b7ff4110b1b9c3317278acf2492b41f1d1d227dd8f1145b4129492a',
  '69753effdaa3576770af21de6c02e103fb71166916da15ec9f0f6f308d783abd',
  '12b9377cbe7e5c94e8a70d9d23929523d14afa954793130f8a3959c7b849aca8',
]);
export const isProtectedIdentity = id => typeof id === 'string' && PROTECTED_ID_HASHES.has(createHash('sha256').update(id).digest('hex'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class RailwayGateRefusal extends Error {}
const refuse = message => { throw new RailwayGateRefusal(`NOT RUN: ${message}`); };
export function assertNoAmbientPostgresEnvironment(env = process.env) {
  if (Object.entries(env).some(([key,value]) => /^PG/.test(key) && value)) refuse('PG* variables must not be inherited by the dedicated test runner.');
}

export function validateRailwayRecoveryTarget(env = process.env, now = new Date()) {
  assertNoAmbientPostgresEnvironment(env);
  if (!env.RECOVERY_CASE_RAILWAY_TARGET_JSON) refuse('approved disposable target manifest is required.');
  let m; try { m = JSON.parse(env.RECOVERY_CASE_RAILWAY_TARGET_JSON); } catch { refuse('invalid target manifest JSON.'); }
  const keys = ['version','projectId','environmentId','environmentName','runnerServiceId','databaseServiceId','databaseVolumeId','databaseHost','databasePort','databaseName','databaseUser','sourceCommit','branch','nonce','approvedAt','expiresAt','maxAdditionalUsd','approvalReference'];
  if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).length !== keys.length || Object.keys(m).some(k => !keys.includes(k))) refuse('manifest fields are missing or unexpected.');
  if (m.version !== 1 || m.projectId !== PROJECT_ID) refuse('unapproved project or manifest version.');
  const ids = [m.environmentId,m.runnerServiceId,m.databaseServiceId,m.databaseVolumeId];
  if (ids.some(id => typeof id !== 'string' || !UUID.test(id) || isProtectedIdentity(id)) || new Set(ids).size !== ids.length) refuse('test identities must be distinct and cannot reference production.');
  if (typeof m.environmentName !== 'string' || !/^lzr-qa-[a-z0-9-]{6,40}$/.test(m.environmentName) || /prod/i.test(m.environmentName)) refuse('explicit disposable environment name required.');
  for (const [variable, field] of [['RAILWAY_PROJECT_ID','projectId'],['RAILWAY_ENVIRONMENT_ID','environmentId'],['RAILWAY_ENVIRONMENT_NAME','environmentName'],['RAILWAY_SERVICE_ID','runnerServiceId'],['RAILWAY_GIT_COMMIT_SHA','sourceCommit'],['RAILWAY_GIT_BRANCH','branch']]) {
    if (!env[variable] || env[variable] !== m[field] || isProtectedIdentity(env[variable])) refuse('Railway runtime identity differs from approved target.');
  }
  if (env.RAILWAY_GIT_REPO_OWNER !== 'LZRBBNET' || env.RAILWAY_GIT_REPO_NAME !== 'lzr-hub'
      || typeof m.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(m.sourceCommit)
      || typeof m.branch !== 'string' || !/^(test|qa)\/[a-z0-9][a-z0-9/_-]{3,100}$/.test(m.branch)) refuse('exact reviewed test-branch source required.');
  if (typeof m.nonce !== 'string' || !/^[a-f0-9]{24}$/.test(m.nonce)
      || m.databaseName !== `lzr_recovery_test_${m.nonce}`
      || typeof m.databaseUser !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(m.databaseUser)
      || m.databasePort !== 5432
      || typeof m.databaseHost !== 'string' || !/^lzr-qa-db-[a-z0-9-]{6,40}\.railway\.internal$/.test(m.databaseHost)) refuse('named disposable database and private test-service hostname required.');
  const approved = Date.parse(m.approvedAt), expires = Date.parse(m.expiresAt), current = now.getTime();
  if (typeof m.approvedAt !== 'string' || typeof m.expiresAt !== 'string' || !Number.isFinite(approved) || !Number.isFinite(expires)
      || !Number.isFinite(current) || approved > current || expires - approved > 24 * 60 * 60 * 1000 || expires - current < 60000
      || typeof m.maxAdditionalUsd !== 'number' || m.maxAdditionalUsd <= 0 || m.maxAdditionalUsd > 5
      || typeof m.approvalReference !== 'string' || !/^approved-[a-z0-9-]{8,80}$/.test(m.approvalReference)) refuse('explicit unexpired approval, <=24h lifetime and <=USD5 budget acknowledgement required.');
  // Refuse inherited operational configuration even though this runner never invokes send/IXC services.
  for (const [key,value] of Object.entries(env)) {
    if (value && ((/^FEATURE_/.test(key) && value !== 'false')
      || ['DATABASE_URL','IXC_BASE_URL','IXC_TOKEN','META_ACCESS_TOKEN','GROQ_API_KEY','EVOLUTION_API_KEY','RAILWAY_TOKEN','RAILWAY_API_TOKEN','LANGFUSE_SECRET_KEY'].includes(key)
      || (['IXC_MODE','IXC_TRANSPORT','PILOT_MODE'].includes(key) && value !== 'disabled')
      || (key === 'IXC_WRITE_ENABLED' && value !== 'false'))) refuse('operational variables must not be inherited by the gate runner.');
  }
  let url; try { url = new URL(env.RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL ?? ''); } catch { refuse('explicit test-only database URL required.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== m.databaseHost || Number(url.port || 5432) !== m.databasePort
      || url.pathname !== `/${m.databaseName}` || url.search || url.hash || !url.password || decodeURIComponent(url.username) !== m.databaseUser
      || env.RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION !== `${m.environmentId}:${m.databaseServiceId}:${m.nonce}`) refuse('connection or explicit migration acknowledgement differs from approved target.');
  return Object.freeze({ ...m, marker: `lzr-recovery-disposable:${PROJECT_ID}:${m.environmentId}:${m.databaseServiceId}:${m.nonce}`,
    password: decodeURIComponent(url.password) });
}

export function isPrivateTestAddress(address) {
  if (isIP(address) === 4) { const [a,b] = address.split('.').map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  return isIP(address) === 6 && (parseInt(address.split(':')[0], 16) & 0xfe00) === 0xfc00;
}
export const normalizedAddress = address => isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1,-1) : address;

/** SELECT-only readiness checks, after exact runtime/URL/DNS validation. Marker is provisioned separately. */
export async function assertRailwayDatabaseReady(client, target, pinnedAddress, now = new Date()) {
  if (Date.parse(target.expiresAt) - now.getTime() < 60000) refuse('target approval expired before migration.');
  const row = (await client.query("select current_database() as database, current_user as username, host(inet_server_addr()) as address, inet_server_port() as port, shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()")).rows[0];
  if (!row || row.database !== target.databaseName || row.username !== target.databaseUser || row.port !== target.databasePort
      || !isPrivateTestAddress(row.address) || normalizedAddress(row.address) !== normalizedAddress(pinnedAddress) || row.marker !== target.marker) refuse('database identity or separately provisioned disposable marker mismatch.');
  const existing = await client.query("select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%' and c.relkind in ('r','p','v','m','S','f') limit 1");
  if (existing.rowCount !== 0) refuse('database is not empty; no reuse, reset or production migration allowed.');
}
