import { assertSyntheticWebDatabase } from '../runtime/synthetic-web.ts';

/** Fixed internal direct connection; no URI query overrides or PG env fallback. */
export function initializationTarget(source: Record<string, string | undefined>) {
  assertSyntheticWebDatabase(source);
  const url = new URL(source.DATABASE_URL!);
  if (!source.SYNTHETIC_INIT_DATABASE_HOST || url.hostname !== source.SYNTHETIC_INIT_DATABASE_HOST ||
      !/^[a-z0-9][a-z0-9.-]*$/.test(url.hostname) || url.search || url.hash || (url.port && url.port !== '5432') ||
      url.pathname !== '/lzr_synthetic_demo' || decodeURIComponent(url.username) !== 'lzr_synthetic_demo') {
    throw new Error('SYNTHETIC_INITIALIZATION_TARGET_REFUSED');
  }
  const password = decodeURIComponent(url.password);
  if (!password || password.includes('\0')) throw new Error('SYNTHETIC_INITIALIZATION_TARGET_REFUSED');
  return { host: url.hostname, port: 5432, user: 'lzr_synthetic_demo', password, database: 'lzr_synthetic_demo',
    ssl: false as const, options: '-c search_path=pg_catalog',
    connectionTimeoutMillis: 5000, query_timeout: 17000, statement_timeout: 15000 };
}
