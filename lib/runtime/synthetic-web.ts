import { assertSyntheticDemo } from '../integrations/ixc/synthetic-demo.ts';

/** Only the isolated web demo opts in. A partial opt-in must not open access. */
export function syntheticWebRequested(source: Record<string, string | undefined>): boolean {
  return source.SYNTHETIC_WEB_DEMO !== undefined || source.FEATURE_SYNTHETIC_INVOICES === 'true';
}

export function assertSyntheticWeb(source: Record<string, string | undefined>): string {
  assertSyntheticDemo(source);
  if (source.SYNTHETIC_WEB_DEMO !== 'true' || source.NODE_ENV !== 'production' ||
      source.FEATURE_PGVECTOR !== 'false' || source.FEATURE_AGENT_HOMOLOGATION_PROFILES !== 'false' ||
      source.SYNTHETIC_DATABASE_CONFIRMATION !== 'isolated-synthetic-postgres-v1') {
    throw new Error('SYNTHETIC_WEB_CONFIGURATION_BLOCKED');
  }
  const origin = new URL(source.SYNTHETIC_DEMO_ORIGIN ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== source.SYNTHETIC_DEMO_ORIGIN) {
    throw new Error('SYNTHETIC_WEB_CONFIGURATION_BLOCKED');
  }
  return origin.origin;
}

/** Syntax and deliberate declaration only; cannot prove the database is isolated. */
export function assertSyntheticWebDatabase(source: Record<string, string | undefined>): void {
  assertSyntheticWeb(source);
  const target = new URL(source.DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname ||
      !target.username || !target.password || target.pathname === '/' || target.hash) {
    throw new Error('SYNTHETIC_WEB_DATABASE_CONFIGURATION_BLOCKED');
  }
}
