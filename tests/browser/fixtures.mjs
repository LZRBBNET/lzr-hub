// UI-only API doubles. No handler, account, cookie or persistence E2E claim.
export function installFixtures(data) {
  const ledgerKey = 'qa-errors';
  const errors = () => JSON.parse(sessionStorage.getItem(ledgerKey) || '[]');
  const recordError = kind => sessionStorage.setItem(ledgerKey, JSON.stringify([...errors(), kind]));
  const qa = window.qa = { pending: [], payments: [], errors, me: null, logoutFails: false };
  for (const kind of ['error', 'unhandledrejection', 'securitypolicyviolation']) {
    window.addEventListener(kind, () => recordError(kind));
  }
  const valid = { authRequired: true, authenticated: true, permissions: ['customer.read','support.write'],
    user: { id: 'qa', name: 'Operador Fictício', email: 'qa@example.invalid', role: 'Supervisor' } };
  const invalid = { authRequired: true, authenticated: false, permissions: [] };
  const settle = async () => {
    // Let application continuations and React paint work run before assertions.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const release = async (pending, response) => {
    pending.resolve(response); await pending.delivered; await settle();
    return { delivered: true, aborted: pending.signal.aborted };
  };
  qa.release = (index, id) => release(qa.pending[index], Response.json(data[id]));
  const paymentPayload = (pending, kind) => ({
    mode: 'demo', scope: 'invoice-page', customerId: pending.id, invoiceId: pending.invoiceId,
    page: pending.page, pageSize: 10, total: kind === 'unknown' ? null : kind === 'empty' ? 0 : 1,
    hasMore: kind === 'unknown' ? null : false, observedAt: '2026-11-14T12:00:00Z',
    items: kind === 'empty' ? [] : [{ id: kind === 'late' ? 'SYNTHETIC_LATE_PAYMENT' : 'SYNTHETIC_UNCONFIRMED',
      invoiceId: pending.invoiceId, paidAt: null, value: kind === 'unknown' ? null : 40, method: 'Fictício' }],
  });
  qa.releasePayment = (index, kind) => release(qa.payments[index], Response.json(
    kind === 'error' ? { error: 'SYNTHETIC_PRIVATE_ERROR' } : paymentPayload(qa.payments[index], kind),
    { status: kind === 'error' ? 503 : 200 },
  ));
  qa.paymentHeaders = async (index, kind) => {
    const pending = qa.payments[index];
    pending.bodyPayload = paymentPayload(pending, kind);
    let acknowledge;
    pending.bodyDelivered = new Promise(resolve => { acknowledge = resolve; });
    return release(pending, { ok: true, status: 200, json: async () => {
      pending.bodyStarted = true;
      const payload = await new Promise(resolve => { pending.resolveBody = resolve; });
      acknowledge(); return payload;
    } });
  };
  qa.releasePaymentBody = async index => {
    const pending = qa.payments[index];
    if (!pending.bodyStarted) throw Error('QA_BODY_NOT_STARTED');
    pending.resolveBody(pending.bodyPayload); await pending.bodyDelivered; await settle();
    return { bodyDelivered: true, aborted: pending.signal.aborted };
  };
  window.fetch = async (input, init = {}) => {
    const url = new URL(input, location.origin);
    if (url.origin !== location.origin) { recordError('external'); throw Error('QA_EXTERNAL_BLOCKED'); }
    if (url.pathname === '/api/auth/login') {
      const body = JSON.parse(init.body);
      const ok = body.email === 'qa@example.invalid' && body.password === 'fictitious-only';
      if (ok) localStorage.setItem('qa-session', 'yes');
      return Response.json(ok ? { ok: true } : { error: 'Credenciais fictícias inválidas' }, { status: ok ? 200 : 401 });
    }
    if (url.pathname === '/api/auth/me') {
      if (location.search.includes('holdMe')) return new Promise(resolve => { qa.me = () => resolve(Response.json(invalid)); });
      return Response.json(localStorage.getItem('qa-session') === 'yes' ? valid : invalid);
    }
    if (url.pathname === '/api/auth/logout') {
      if (qa.logoutFails) return Response.json({ error: 'Falha fictícia' }, { status: 503 });
      localStorage.removeItem('qa-session'); return Response.json({ ok: true });
    }
    if (url.pathname === '/api/conversations') return Response.json({ items: [] });
    if (url.pathname === '/api/customers' || url.pathname === '/api/customers/payments') {
      if (url.pathname === '/api/customers' && !url.searchParams.has('id')) return Response.json({ items: Object.values(data).map(v => v.customer), total: 2, pageSize: 10, scope: 'allowlist', mode: 'demo' });
      // Deliberately ignore abort: exercise a transport/body completing too late.
      let acknowledge;
      const delivered = new Promise(resolve => { acknowledge = resolve; });
      const queue = url.pathname.endsWith('/payments') ? qa.payments : qa.pending;
      const response = await new Promise(resolve => queue.push({ resolve, delivered, id: url.searchParams.get('id'),
        invoiceId: url.searchParams.get('invoiceId'), page: Number(url.searchParams.get('page')), signal: init.signal }));
      acknowledge();
      return response;
    }
    recordError('unexpected-api:' + url.pathname); throw Error('QA_UNEXPECTED_API');
  };
}
