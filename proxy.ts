import { NextResponse } from 'next/server';
import { currentUser } from './lib/platform/session-guard.ts';
import { assertSyntheticWeb, syntheticWebRequested } from './lib/runtime/synthetic-web.ts';

declare const __LZR_SYNTHETIC_WEB_BUILD__: boolean | undefined;
const protectedBuild = typeof __LZR_SYNTHETIC_WEB_BUILD__ !== 'undefined' && __LZR_SYNTHETIC_WEB_BUILD__ === true;

const headers = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };
const publicReads = new Set(['/login', '/api/auth/me', '/favicon.svg']);
const ownAccount = new Set(['/api/auth/password', '/api/auth/logout']);

/** Full request boundary; individual handlers still enforce their own RBAC. */
export async function proxy(request: Request) {
  if (!protectedBuild && !syntheticWebRequested(process.env)) return NextResponse.next();
  let origin: string;
  try { origin = assertSyntheticWeb(process.env); }
  catch { return NextResponse.json({ error: 'Demonstração indisponível' }, { status: 503, headers }); }
  const path = new URL(request.url).pathname;
  const read = request.method === 'GET' || request.method === 'HEAD';
  // Do not accept browser writes from another origin, or originless jobs/webhooks.
  if (!read && request.headers.get('origin') !== origin) {
    return NextResponse.json({ error: 'Origem não autorizada' }, { status: 403, headers });
  }
  if ((read && (publicReads.has(path) || path.startsWith('/_next/static/'))) ||
      (path === '/api/auth/login' && request.method === 'POST')) return NextResponse.next({ headers });
  const user = await currentUser(request);
  if (!user) {
    if (path === '/api' || path.startsWith('/api/') || !read) return NextResponse.json({ error: 'Sessão necessária' }, { status: 401, headers });
    return NextResponse.redirect(new URL('/login', origin), { status: 307, headers });
  }
  // The root shell contains the existing forced password-change UI. Business
  // APIs remain blocked until it finishes; logout/change password stay usable.
  if (user.mustChangePassword === true && path.startsWith('/api/') && !ownAccount.has(path)) {
    return NextResponse.json({ error: 'Troque sua senha provisória' }, { status: 403, headers });
  }
  return NextResponse.next({ headers });
}

export const config = { matcher: '/:path*' };
