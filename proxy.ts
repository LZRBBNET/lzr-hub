import { NextResponse } from 'next/server';
import { sessionState } from './lib/platform/session-guard.ts';
import { assertSyntheticWeb, syntheticWebRequested } from './lib/runtime/synthetic-web.ts';
import { browserSetupRequested } from './lib/platform/browser-initialization.ts';
import { initializationAccess } from './lib/platform/synthetic-initialization-access.ts';

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
  const browserSetup = browserSetupRequested(process.env);
  if (browserSetup && request.method === 'GET' && ['/first-access','/first-access/browser.js'].includes(path)) {
    return NextResponse.next({ headers }); // Static page/assets only; no pool or session lookup.
  }
  if (path === '/api/demo/browser-setup') {
    if (browserSetup && ['GET','POST'].includes(request.method) && initializationAccess(request,process.env)) return NextResponse.next({ headers });
    return NextResponse.json({ error:'Indisponível', retryAllowed:false },{status:404,headers});
  }
  // Browser mode must not be bypassed through the older capability-only endpoint.
  if (browserSetup && path === '/api/demo/initialize') return NextResponse.json({ error:'Indisponível', retryAllowed:false },{status:404,headers});
  if (path === '/api/demo/initialize' && ['GET','POST'].includes(request.method) && initializationAccess(request, process.env)) {
    return NextResponse.next({ headers });
  }
  // Exclusive bootstrap window: anonymous login must not open application pool
  // connections while emptiness/exclusive ownership is being established.
  if (process.env.SYNTHETIC_INIT_ENABLED !== undefined && process.env.SYNTHETIC_INIT_ENABLED !== 'false') {
    return NextResponse.json({ error: 'Inicialização isolada em revisão', retryAllowed: false }, { status: 503, headers });
  }
  if ((read && (publicReads.has(path) || path.startsWith('/_next/static/'))) ||
      (path === '/api/auth/login' && request.method === 'POST')) return NextResponse.next({ headers });
  const {user, unavailable} = await sessionState(request);
  if (unavailable) return NextResponse.json({ error: "Autenticação temporariamente indisponível" }, { status: 503, headers });
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
