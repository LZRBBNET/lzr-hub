import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createInitializationController } from '../../../../lib/platform/synthetic-initialization-controller.ts';
import { loadSyntheticSchema } from '../../../../scripts/prepare-synthetic-initialization.mjs';
import { initializationTarget } from '../../../../lib/platform/synthetic-initialization-target.ts';

const handle = createInitializationController({
  source: () => process.env,
  processId: randomUUID(), // Public freshness identifier, not a credential.
  now: () => new Date(),
  schema: loadSyntheticSchema,
  async connect(source) {
    const client = new Client(initializationTarget(source));
    client.on('error', () => { /* Dedicated client: never reconnect or log credential-bearing errors. */ });
    try { await client.connect(); }
    catch { try { await client.end(); } catch { /* permanently discard */ } throw new Error('SYNTHETIC_INIT_CONNECT_NOT_CONFIRMED'); }
    return { query: async (sql, values) => client.query(sql, values), destroy: () => client.end() };
  },
});

export const GET = handle;
export const POST = handle;
