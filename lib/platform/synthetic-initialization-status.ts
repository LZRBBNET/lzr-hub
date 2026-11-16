import { createHash } from 'node:crypto';
import manifest from './synthetic-schema-manifest.json' with { type: 'json' };
import { IDENTITY_SQL, EMPTY_SQL, RESERVED_EMPTY_SQL } from './synthetic-inspection-sql.ts';
import type { InitializationClient } from './synthetic-initialization.ts';

export const STATUS_TABLES_SQL = `SELECT c.relname,c.relkind FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname='public' AND c.relname IN ('synthetic_init_reservation','synthetic_init_completion'))
 OR (n.nspname='drizzle' AND c.relname='__drizzle_migrations')`;
export const STATUS_RESERVATION_SQL = 'SELECT attempt,manifest,created_at FROM public.synthetic_init_reservation LIMIT 2';
export const STATUS_COMPLETION_SQL = 'SELECT attempt,manifest,completed_at FROM public.synthetic_init_completion LIMIT 2';
export const STATUS_JOURNAL_SQL = `SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id LIMIT ${manifest.length + 1}`;
const blocked = () => { throw new Error('SYNTHETIC_STATUS_UNKNOWN'); };

/** Snapshot observations only. Neither absence nor completion authorizes replay. */
export async function inspectSyntheticInitialization(client: InitializationClient, expected: { databaseOid: string; attempt: string }) {
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  let result: { state: string; reservationObserved: boolean; completionObserved: boolean; manifestMatches: boolean };
  try {
    if (!/^[1-9]\d{0,9}$/.test(expected.databaseOid) || !/^synthetic-init-[a-z0-9-]{8,64}$/.test(expected.attempt)) blocked();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL search_path = pg_catalog');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const identity = (await client.query(IDENTITY_SQL)).rows;
    if (identity.length !== 1 || identity[0].database !== 'lzr_synthetic_demo' || identity[0].owner !== 'lzr_synthetic_demo' || identity[0].oid !== expected.databaseOid) blocked();
    const tables = (await client.query(STATUS_TABLES_SQL)).rows;
    if (tables.some(t => t.relkind !== 'r') || new Set(tables.map(t=>t.relname)).size !== tables.length ||
        tables.some(t => !['synthetic_init_reservation','synthetic_init_completion','__drizzle_migrations'].includes(String(t.relname)))) blocked();
    const has = (name: string) => tables.some(t=>t.relname===name);
    if (!has('synthetic_init_reservation')) {
      if (tables.length) blocked();
      const empty = (await client.query(EMPTY_SQL)).rows;
      if (empty.length !== 1 || empty[0].objects !== 0) blocked();
      result = { state: 'absence-observed', reservationObserved: false, completionObserved: false, manifestMatches: false };
    } else {
      const reservation = (await client.query(STATUS_RESERVATION_SQL)).rows;
      const r = reservation[0];
      if (reservation.length !== 1 || r.attempt !== expected.attempt || r.manifest !== digest ||
          typeof r.created_at !== 'string' || !Number.isFinite(Date.parse(r.created_at))) blocked();
      if (has('synthetic_init_completion')) {
        if (!has('__drizzle_migrations')) blocked();
        const completion = (await client.query(STATUS_COMPLETION_SQL)).rows, c = completion[0];
        if (completion.length !== 1 || c.attempt !== r.attempt || c.manifest !== digest || c.completed_at !== r.created_at) blocked();
        const journal = (await client.query(STATUS_JOURNAL_SQL)).rows;
        if (journal.length !== manifest.length || journal.some((entry,i)=>entry.hash !== manifest[i].sha256 || String(entry.created_at) !== String(manifest[i].when))) blocked();
        result = { state: 'completion-observed', reservationObserved: true, completionObserved: true, manifestMatches: true };
      } else {
        if (has('__drizzle_migrations')) blocked();
        const remaining = (await client.query(RESERVED_EMPTY_SQL)).rows;
        if (remaining.length !== 1 || remaining[0].objects !== 0) blocked();
        result = { state: 'reservation-observed', reservationObserved: true, completionObserved: false, manifestMatches: true };
      }
    }
    await client.query('COMMIT');
  } catch {
    try { await client.query('ROLLBACK'); } catch { /* unknown remains unknown */ }
    throw new Error('SYNTHETIC_STATUS_UNKNOWN');
  } finally {
    try { await client.destroy(); } catch { throw new Error('SYNTHETIC_STATUS_UNKNOWN'); }
  }
  return { ...result, retryAllowed: false, credentialsVerified: false, expectedManifestSha256: digest };
}
