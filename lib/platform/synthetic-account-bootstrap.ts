import { randomUUID } from 'node:crypto';
import { hashPassword } from './auth.ts';
import { assertSyntheticDemo } from '../integrations/ixc/synthetic-demo.ts';

/** Dedicated transaction client supplied by caller. This module never connects. */
export interface SyntheticBootstrapClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<{ id: string }> }>;
}
export interface SyntheticAccountInput { email: string; password: string; name: string; role: 'Supervisor' | 'Atendente' | 'Cobrança' | 'Somente leitura' }

/** Add-only: existing accounts are a conflict, never updated or deleted. */
export async function bootstrapSyntheticAccounts(
  client: SyntheticBootstrapClient,
  accounts: SyntheticAccountInput[],
  source: Record<string, string | undefined>,
) {
  assertSyntheticDemo(source);
  if (source.SYNTHETIC_DATABASE_CONFIRMATION !== 'isolated-synthetic-postgres-v1') throw new Error('SYNTHETIC_DATABASE_CONFIRMATION_REQUIRED');
  const roles = ['Supervisor', 'Atendente', 'Cobrança', 'Somente leitura'];
  if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 4) throw new Error('SYNTHETIC_ACCOUNTS_INVALID');
  const emails = new Set<string>();
  for (const account of accounts) {
    if (!account || typeof account.email !== 'string' || !/^[a-z0-9._+-]+@example\.invalid$/.test(account.email) || emails.has(account.email) ||
      typeof account.password !== 'string' || account.password.length < 16 || account.password.length > 256 ||
      typeof account.name !== 'string' || !account.name.startsWith('DEMO ') || account.name.length > 100 || !roles.includes(account.role)) throw new Error('SYNTHETIC_ACCOUNTS_INVALID');
    emails.add(account.email);
  }
  const prepared = await Promise.all(accounts.map(async account => ({ ...account, id: randomUUID(), ...await hashPassword(account.password) })));
  try { await client.query('BEGIN'); } catch { throw new Error('SYNTHETIC_BOOTSTRAP_BEGIN_NOT_CONFIRMED_DISCARD_CLIENT'); }
  try {
    for (const account of prepared) {
      const result = await client.query(`INSERT INTO users
        (id,email,name,role,password_hash,password_salt,active,must_change_password,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,true,true,$7,$7)
        ON CONFLICT (email) DO NOTHING RETURNING id`,
      [account.id, account.email, account.name, account.role, account.hash, account.salt, new Date().toISOString()]);
      if (result.rows.length !== 1 || result.rows[0].id !== account.id) throw new Error('SYNTHETIC_ACCOUNT_CONFLICT');
    }
    await client.query('COMMIT');
  } catch {
    try { await client.query('ROLLBACK'); } catch { /* connection outcome is not assumed */ }
    throw new Error('SYNTHETIC_BOOTSTRAP_NOT_CONFIRMED_DO_NOT_RETRY_AUTOMATICALLY');
  }
  return { synthetic: true, created: prepared.map(account => ({ id: account.id, email: account.email, role: account.role })), credentialsReturned: false };
}
