// Opt-in startup gate only. Never imports a migrator, seeds or application handlers.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client } from 'pg';

let category = 'configuration';
let client;
let stopping = false;
let connectionBroken = false;
const report = (status, reason) => {
  try { console.info(JSON.stringify({ event: 'diagnostic.ledgerGate', version: 1, status, reason })); } catch { /* No raw error output. */ }
};
const deadline = setTimeout(() => { report('refused', 'deadline-exceeded'); process.exit(1); }, 20000);
deadline.unref();
const close = async () => { if (client) { const current = client; client = undefined; await current.end(); } };
const stop = signal => {
  stopping = true;
  report('refused', 'interrupted');
  // Exit nonzero even if the signal arrives after verification: shell && cannot start server.
  const timer = setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 1000);
  timer.unref();
  void close().catch(() => {}).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));

try {
  if (process.env.DIAGNOSTIC_READONLY_LEDGER_START !== 'true' || !process.env.DATABASE_URL) throw Error();
  // pg merges URL query parameters over constructor options. Refuse overrides
  // of the verifier's read-only/time bounds rather than silently accepting them.
  const target = new URL(process.env.DATABASE_URL);
  const protectedOptions = new Set(['options', 'query_timeout', 'connectionTimeoutMillis', 'statement_timeout', 'lock_timeout']);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || [...target.searchParams.keys()].some(key => protectedOptions.has(key))) throw Error();
  category = 'manifest-invalid';
  const folder = new URL('../drizzle/', import.meta.url);
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', folder), 'utf8'));
  if (journal.dialect !== 'postgresql' || !Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length > 1000) throw Error();
  const expected = [];
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.idx !== index || typeof entry.tag !== 'string' || !/^\d{4}_[a-z_]+$/.test(entry.tag) ||
        !entry.tag.startsWith(String(index).padStart(4, '0') + '_') || !Number.isSafeInteger(entry.when) || entry.when <= 0 ||
        (index > 0 && entry.when <= expected[index - 1].when)) throw Error();
    // Same hashing semantics as installed Drizzle: UTF-8 text, no normalization.
    const sql = await readFile(new URL(entry.tag + '.sql', folder), 'utf8');
    expected.push({ when: entry.when, hash: createHash('sha256').update(sql).digest('hex') });
  }
  if (stopping) throw Error();
  category = 'connection-or-read-failed';
  client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 6000,
    // Applies only to this short-lived verifier connection, never the web server.
    options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000',
  });
  client.on('error', () => { connectionBroken = true; });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const mode = await client.query("SELECT current_setting('transaction_read_only') AS mode");
  if (mode.rows.length !== 1 || mode.rows[0].mode !== 'on') throw Error();
  // Fully qualified metadata table only. Missing schema/table is an error, never created.
  const ledger = await client.query('SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC, id ASC LIMIT $1', [expected.length + 1]);
  category = 'ledger-mismatch';
  if (ledger.rows.length !== expected.length) throw Error();
  const ids = new Set();
  for (const [index, row] of ledger.rows.entries()) {
    if (!Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id) || typeof row.created_at !== 'string' ||
        !/^[1-9]\d*$/.test(row.created_at) || !Number.isSafeInteger(Number(row.created_at)) ||
        Number(row.created_at) !== expected[index].when || typeof row.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.hash) || row.hash !== expected[index].hash) throw Error();
    ids.add(row.id);
  }
  category = 'connection-or-read-failed';
  await client.query('ROLLBACK');
  await close();
  if (stopping || connectionBroken) throw Error();
  report('verified', 'ledger-matches-code');
} catch {
  report('refused', category);
  process.exitCode = 1;
} finally {
  // Closing a connection also rolls back any still-open read-only transaction.
  try { await close(); } catch { report('refused', 'connection-close-failed'); process.exitCode = 1; }
}
