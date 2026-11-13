import { createHash, timingSafeEqual } from 'node:crypto';
import { assertSyntheticWeb } from '../runtime/synthetic-web.ts';

/** Operator-supplied capability hash. This code never generates a credential. */
export function initializationAccess(request: Request, source: Record<string, string | undefined>, now = Date.now()): boolean {
  try { assertSyntheticWeb(source); } catch { return false; }
  if (source.SYNTHETIC_INIT_ENABLED !== 'true' || !/^[a-f0-9]{64}$/.test(source.SYNTHETIC_INIT_CAPABILITY_SHA256 ?? '')) return false;
  const expiry = source.SYNTHETIC_INIT_EXPIRES_AT ?? '';
  const expires = Date.parse(expiry);
  if (!Number.isFinite(now) || !Number.isFinite(expires) || new Date(expires).toISOString() !== expiry || expires <= now || expires - now > 30 * 60 * 1000) return false;
  const token = request.headers.get('x-synthetic-init-capability') ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  return timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(source.SYNTHETIC_INIT_CAPABILITY_SHA256!, 'hex'));
}
