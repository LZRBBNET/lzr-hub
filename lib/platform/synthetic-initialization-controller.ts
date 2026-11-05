import { initializationTarget } from './synthetic-initialization-target.ts';
import { initializationAccess } from './synthetic-initialization-access.ts';
import { createSyntheticInitializer, IDENTITY_SQL, EMPTY_SQL, type InitializationClient } from './synthetic-initialization.ts';
import { createHash } from 'node:crypto';

type Dependencies = {
  source(): Record<string, string | undefined>;
  /** Non-secret process identity, different after restart; never an auth token. */
  processId: string;
  schema(): Promise<Array<{ name: string; sql: string }>>;
  connect(source: Readonly<Record<string, string | undefined>>): Promise<InitializationClient>;
  now(): Date;
};
const headers = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' };
const reply = (body: unknown, status: number) => Response.json(body, { status, headers });

/** Manual POST only. No startup hook, timer, retry, job, shell or new service. */
export function createInitializationController(deps: Dependencies) {
  const initialize = createSyntheticInitializer();
  let consumed = false;
  let busy = false;
  let observedOid: string | undefined;
  let observedTarget: string | undefined;
  const target = (source: Record<string, string | undefined>) => createHash('sha256')
    .update(JSON.stringify([source.DATABASE_URL, source.SYNTHETIC_INIT_DATABASE_HOST])).digest('hex');
  async function accepted(request: Request, source: Record<string, string | undefined>) {
    if (request.method === 'GET') {
      if (consumed) return reply({ available: false, retryAllowed: false }, 409);
      let client: InitializationClient | undefined;
      try {
        client = await deps.connect(source);
        await client.query('SET search_path = pg_catalog');
        const identity = (await client.query(IDENTITY_SQL)).rows;
        const empty = (await client.query(EMPTY_SQL)).rows;
        if (identity.length !== 1 || identity[0].database !== 'lzr_synthetic_demo' || identity[0].owner !== 'lzr_synthetic_demo' ||
            typeof identity[0].oid !== 'string' || !/^[1-9]\d{0,9}$/.test(identity[0].oid) || identity[0].peers !== 0 ||
            empty.length !== 1 || empty[0].objects !== 0) throw new Error();
        const owned = client; client = undefined; await owned.destroy();
        observedOid = identity[0].oid as string;
        observedTarget = target(source);
        return reply({ processId: deps.processId, databaseOid: observedOid, available: true,
          freshManualApprovalRequired: true, retryAllowed: false }, 200);
      } catch {
        observedOid = undefined;
        observedTarget = undefined;
        if (client) { try { await client.destroy(); } catch { /* permanently discard */ } }
        return reply({ available: false, retryAllowed: false }, 503);
      }
    }
    if (request.method !== 'POST') return reply({ error: 'Método não permitido' }, 405);
    if (request.headers.get('origin') !== source.SYNTHETIC_DEMO_ORIGIN) return reply({ available: false }, 403);
    if (consumed) return reply({ status: 'blocked', retryAllowed: false }, 409);
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 2048) throw new Error();
      body = JSON.parse(raw);
      if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'attempt,confirmation,databaseOid,hash,processId,salt' ||
          body.processId !== deps.processId) throw new Error();
      if (!observedOid || target(source) !== observedTarget || body.databaseOid !== observedOid || !/^[1-9]\d{0,9}$/.test(body.databaseOid) ||
          body.confirmation !== 'CREATE_EMPTY_SYNTHETIC_DATABASE_V1' || !/^synthetic-init-[a-z0-9-]{8,64}$/.test(body.attempt) ||
          !/^[a-f0-9]{128}$/.test(body.hash) || !/^[a-f0-9]{32}$/.test(body.salt)) throw new Error();
    } catch { return reply({ status: 'refused', retryAllowed: false }, 400); }
    consumed = true; // Burn before filesystem or DB I/O; never clear on failure.
    try {
      const files = await deps.schema();
      const current = { ...deps.source() };
      if (!initializationAccess(request, current) || target(current) !== target(source) || current.SYNTHETIC_DEMO_ORIGIN !== source.SYNTHETIC_DEMO_ORIGIN) throw new Error();
      initializationTarget(current);
      const client = await deps.connect(source);
      let disposed = false;
      const destroy = async () => { if (!disposed) { disposed = true; await client.destroy(); } };
      try {
        const result = await initialize({ query: (sql, values) => client.query(sql, values), destroy }, source, body, files,
          { hash: body.hash, salt: body.salt }, deps.now());
        return reply(result, 201);
      } finally { await destroy(); }
    } catch {
      return reply({ status: 'not-confirmed', retryAllowed: false, freshManualApprovalRequired: true }, 503);
    }
  }
  return async function handle(request: Request) {
    const source = { ...deps.source() };
    if (!initializationAccess(request, source)) return reply({ available: false }, 404);
    try { initializationTarget(source); } catch { return reply({ available: false }, 400); }
    if (!['GET','POST'].includes(request.method)) return reply({ error: 'Método não permitido' }, 405);
    if (busy || consumed) return reply({ status: 'blocked', retryAllowed: false }, 409);
    busy = true; // Acquire synchronously, before request.text/connect/any await.
    try { return await accepted(request, source); } finally { busy = false; }
  };
}
