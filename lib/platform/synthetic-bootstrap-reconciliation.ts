import { assertSyntheticDemo } from '../integrations/ixc/synthetic-demo.ts';

interface ExpectedAccount { id: string; email: string; role: string }
interface ReadClient { query(sql: string, values: unknown[]): Promise<{ rows: Array<{ id: string; email: string; role: string; name: string; active: boolean }> }> }

/** Observation only. Never authorizes retry or verifies a password. */
export async function inspectSyntheticBootstrap(client: ReadClient, expected: ExpectedAccount[], source: Record<string, string | undefined>) {
  assertSyntheticDemo(source);
  if (source.SYNTHETIC_DATABASE_CONFIRMATION !== 'isolated-synthetic-postgres-v1' || !Array.isArray(expected) || expected.length < 1 || expected.length > 4 ||
    new Set(expected.map(item => item?.email)).size !== expected.length || new Set(expected.map(item => item?.id)).size !== expected.length || expected.some(item => !item || typeof item.id !== 'string' || !item.id.trim() || typeof item.email !== 'string' || !/^[a-z0-9._+-]+@example\.invalid$/.test(item.email) || !['Supervisor','Atendente','Cobrança','Somente leitura'].includes(item.role))) throw new Error('SYNTHETIC_RECONCILIATION_SCOPE_INVALID');
  const base = { retryAllowed: false as const, credentialsVerified: false as const };
  try {
    const { rows } = await client.query('SELECT id,email,role,name,active FROM users WHERE email = ANY($1::text[]) LIMIT 5', [expected.map(item => item.email)]);
    if (!Array.isArray(rows) || rows.length > expected.length || rows.some(row => !row || typeof row.id !== 'string' || !row.id || typeof row.email !== 'string' || typeof row.role !== 'string' || typeof row.name !== 'string' || typeof row.active !== 'boolean') || rows.some(row => !expected.some(item => item.email === row.email)) || new Set(rows.map(row => row.email)).size !== rows.length) return { ...base, state: 'unknown' as const, accounts: [] };
    return { ...base, state: 'observed' as const, accounts: expected.map(item => {
      const row = rows.find(row => row.email === item.email);
      return { email: item.email, state: !row ? 'absent' : row.id === item.id && row.role === item.role && row.name.startsWith('DEMO ') && row.active === true ? 'matching' : 'conflict' };
    }) };
  } catch { return { ...base, state: 'unknown' as const, accounts: [] }; }
}
