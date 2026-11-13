import { createHash } from 'node:crypto';
import manifest from './synthetic-schema-manifest.json' with { type: 'json' };
import { assertSyntheticWeb } from '../runtime/synthetic-web.ts';
import { prepareSyntheticHandoffFixture } from './synthetic-handoff-fixture.ts';

export interface InitializationClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** Must destroy this dedicated connection, never return it to a pool. */
  destroy(): Promise<void>;
}
export interface InitializationApproval {
  databaseOid: string;
  attempt: string;
  confirmation: 'CREATE_EMPTY_SYNTHETIC_DATABASE_V1';
}
export interface SyntheticLoginMaterial { hash: string; salt: string }

export { IDENTITY_SQL, EMPTY_SQL, RESERVED_EMPTY_SQL } from './synthetic-inspection-sql.ts';
import { IDENTITY_SQL, EMPTY_SQL, RESERVED_EMPTY_SQL } from './synthetic-inspection-sql.ts';
export const RESERVATION_SQL = 'SELECT attempt,manifest,created_at FROM public.synthetic_init_reservation';
const fail = () => { throw new Error('SYNTHETIC_INITIALIZATION_REFUSED'); };

export function verifySyntheticJournal(journal: { version: string; dialect: string; entries: Array<{ tag: string; when: number; idx: number; version: string; breakpoints: boolean }> }) {
  if (journal?.version !== '7' || journal.dialect !== 'postgresql' || !Array.isArray(journal.entries) || journal.entries.length !== manifest.length) fail();
  for (const [i, entry] of journal.entries.entries()) {
    if (`${entry.tag}.sql` !== manifest[i].name || entry.when !== manifest[i].when || entry.idx !== i || entry.version !== '7' || entry.breakpoints !== true) fail();
  }
}

/** Pin exact repository migrations; callers cannot supply arbitrary SQL. */
export function verifySyntheticSchema(files: Array<{ name: string; sql: string }>) {
  if (files.length !== manifest.length) fail();
  const bundle = manifest.map((entry, i) => {
    const file = files[i];
    if (file?.name !== entry.name || createHash('sha256').update(file.sql).digest('hex') !== entry.sha256) fail();
    const statements = file.sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
    if (statements.some(s => !/^(CREATE (?:TABLE|(?:UNIQUE )?INDEX) |ALTER TABLE "\w+" ADD COLUMN )/.test(s) || /\b(DROP|DELETE|TRUNCATE|UPDATE|GRANT|REVOKE|COPY)\b/i.test(s))) fail();
    return { ...entry, statements };
  });
  return bundle;
}

/**
 * Explicit in-process operation. Never auto-invoked by startup or jobs.
 * HTTP use must go through the separately disabled manual controller.
 * One invocation per instance even if the first read/BEGIN/COMMIT is uncertain.
 * A future caller must require a fresh manual approval, never auto-call on restart.
 */
export function createSyntheticInitializer() {
  let consumed = false;
  return async function initialize(client: InitializationClient, source: Record<string, string | undefined>,
    approval: InitializationApproval, files: Array<{ name: string; sql: string }>, login: SyntheticLoginMaterial, now: Date) {
    assertSyntheticWeb(source);
    if (consumed || approval.confirmation !== 'CREATE_EMPTY_SYNTHETIC_DATABASE_V1' ||
        !/^[1-9]\d{0,9}$/.test(approval.databaseOid) || !/^synthetic-init-[a-z0-9-]{8,64}$/.test(approval.attempt) ||
        !/^[a-f0-9]{128}$/.test(login.hash) || !/^[a-f0-9]{32}$/.test(login.salt) ||
        !Number.isFinite(now.getTime())) fail();
    const bundle = verifySyntheticSchema(files);
    const fixture = prepareSyntheticHandoffFixture(source, now);
    const at = now.toISOString();
    const hash = login.hash, salt = login.salt;
    const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    consumed = true; // Burn before any I/O. Never clear on error.
    let transaction = false;
    let phase = 'identity';
    try {
      await client.query('SET search_path = pg_catalog');
      const identity = (await client.query(IDENTITY_SQL)).rows;
      if (identity.length !== 1 || identity[0].database !== 'lzr_synthetic_demo' || identity[0].owner !== 'lzr_synthetic_demo' ||
          identity[0].oid !== approval.databaseOid || identity[0].peers !== 0) fail();
      const lock = (await client.query('SELECT pg_try_advisory_lock(181994, 901) AS locked')).rows;
      if (lock.length !== 1 || lock[0].locked !== true) fail();
      const empty = (await client.query(EMPTY_SQL)).rows;
      if (empty.length !== 1 || empty[0].objects !== 0) fail();
      assertSyntheticWeb(source);
      phase = 'reservation';
      await client.query('BEGIN'); transaction = true;
      await client.query('SET LOCAL search_path = pg_catalog');
      await client.query('SET LOCAL lock_timeout = \'3s\'');
      await client.query('SET LOCAL statement_timeout = \'15s\'');
      const stillEmpty = (await client.query(EMPTY_SQL)).rows;
      if (stillEmpty.length !== 1 || stillEmpty[0].objects !== 0) fail();
      await client.query('SET LOCAL search_path = public, pg_catalog');
      await client.query('CREATE TABLE public.synthetic_init_reservation (attempt text PRIMARY KEY, manifest text NOT NULL, created_at text NOT NULL)');
      await client.query('INSERT INTO public.synthetic_init_reservation (attempt,manifest,created_at) VALUES ($1,$2,$3)',[approval.attempt,digest,at]);
      await client.query('COMMIT'); transaction = false;
      // Reservation deliberately survives any later rollback. A subsequent
      // invocation sees a nonempty DB and refuses, including after a restart.
      phase = 'schema-and-data';
      assertSyntheticWeb(source);
      await client.query('BEGIN'); transaction = true;
      await client.query('SET LOCAL search_path = pg_catalog');
      await client.query('SET LOCAL lock_timeout = \'3s\'');
      await client.query('SET LOCAL statement_timeout = \'15s\'');
      const again = (await client.query(IDENTITY_SQL)).rows;
      if (again.length !== 1 || again[0].oid !== approval.databaseOid || again[0].peers !== 0 || again[0].database !== 'lzr_synthetic_demo' || again[0].owner !== 'lzr_synthetic_demo') fail();
      const exclusive = (await client.query(RESERVED_EMPTY_SQL)).rows;
      const reservation = (await client.query(RESERVATION_SQL)).rows;
      if (exclusive.length !== 1 || exclusive[0].objects !== 0 || reservation.length !== 1 || reservation[0].attempt !== approval.attempt ||
          reservation[0].manifest !== digest || reservation[0].created_at !== at) fail();
      await client.query('SET LOCAL search_path = public, pg_catalog');
      await client.query('CREATE SCHEMA drizzle');
      await client.query('CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
      for (const migration of bundle) {
        for (const sql of migration.statements) await client.query(sql);
        await client.query('INSERT INTO drizzle.__drizzle_migrations (hash,created_at) VALUES ($1,$2)',[migration.sha256,migration.when]);
      }
      await client.query(`INSERT INTO public.users (id,email,name,role,password_hash,password_salt,active,must_change_password,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,true,true,$7,$7)`,['synthetic-demo-supervisor','supervisor@example.invalid','DEMO Supervisor','Supervisor',hash,salt,at]);
      for (const statement of fixture.statements) {
        // Fresh DB: collision must abort; DO NOTHING would hide incomplete data.
        await client.query(statement.sql.replace(/ ON CONFLICT[^]*$/, ''), statement.values);
      }
      await client.query('INSERT INTO public.collection_rules (id,name,status,version,author_id,created_at,updated_at) VALUES ($1,$2,$3,1,$4,$5,$5)',
        ['synthetic-demo-rule-v1','DEMO — régua fictícia sem envio','draft','synthetic-demo-supervisor',at]);
      await client.query('INSERT INTO public.collection_rule_steps (id,rule_id,offset_days,channel,template_id,attempts,active,created_at,updated_at) VALUES ($1,$2,1,$3,$4,1,true,$5,$5)',
        ['synthetic-demo-step-v1','synthetic-demo-rule-v1','WhatsApp','DEMO-NO-DELIVERY',at]);
      await client.query('CREATE TABLE public.synthetic_init_completion (attempt text PRIMARY KEY, manifest text NOT NULL, completed_at text NOT NULL)');
      await client.query('INSERT INTO public.synthetic_init_completion (attempt,manifest,completed_at) VALUES ($1,$2,$3)',[approval.attempt,digest,at]);
      phase = 'commit';
      await client.query('COMMIT'); transaction = false;
      return { status: 'confirmed', synthetic: true, retryAllowed: false, credentialsReturned: false, delivered: false } as const;
    } catch {
      if (transaction) { try { await client.query('ROLLBACK'); } catch { /* still uncertain */ } }
      throw new Error(`SYNTHETIC_INITIALIZATION_NOT_CONFIRMED_${phase.toUpperCase().replaceAll('-','_')}_NO_RETRY`);
    } finally {
      // Destroy also releases the session advisory lock. Disposal failure must
      // not turn an uncertain result into permission to retry.
      try { await client.destroy(); } catch { throw new Error('SYNTHETIC_INITIALIZATION_DISPOSAL_NOT_CONFIRMED_NO_RETRY'); }
    }
  };
}
