// UI-only responses: no rule engine, ledger, DB, IXC or queue runs here.
export function installBillingFixtures() {
  const qa = window.qa;
  let clock = '2026-11-16T15:00:00Z', promise = null, paid = false;
  const billing = qa.billing = { requests: [], reads: [], clock: () => clock };
  billing.setClock = iso => { if (!Number.isFinite(Date.parse(iso))) throw Error('QA_BAD_CLOCK'); clock = iso; };
  billing.preparePaid = () => { paid = true; return { fixtureOnly: true, synthetic: true, delivered: false }; };
  const settle = async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const hold = async (path, body) => {
    let acknowledge;
    const delivered = new Promise(resolve => { acknowledge = resolve; });
    const response = await new Promise(resolve => billing.requests.push({ path, body, resolve, delivered }));
    acknowledge(); return response;
  };
  billing.release = async (index, outcome) => {
    const request = billing.requests[index];
    let payload;
    if (outcome === 'created') {
      if (request.path !== '/api/billing/promises' || request.body.action !== 'create') throw Error('QA_WRONG_CREATE');
      promise = { id: 'SYNTHETIC_PROMISE', invoiceId: request.body.invoiceId, customerId: request.body.customerId, promisedFor: request.body.promisedFor, status: 'pending' };
      payload = { ok: true, promise };
    } else if (outcome === 'fulfilled') {
      if (!paid || !promise || request.path !== '/api/billing/promises' || request.body.action !== 'review') throw Error('QA_WRONG_REVIEW');
      promise = { ...promise, status: 'fulfilled' };
      payload = { fulfilled: [promise.id], broken: [], stillPending: [] };
    } else {
      if (request.path !== '/api/billing/collections/dispatch' || request.body.action !== 'run' || !['paused', 'paid', 'outside', 'queue-off'].includes(outcome)) throw Error('QA_WRONG_DISPATCH');
      // Outcomes are supplied explicitly. This is NOT executing server eligibility.
      payload = { scheduledFor: clock.slice(0, 10), businessHour: outcome !== 'outside', candidates: ['outside', 'queue-off'].includes(outcome) ? 1 : 0,
        recorded: outcome === 'queue-off' ? 1 : 0, duplicates: 0, enqueued: 0, queueEnabled: false, pausedByPromise: outcome === 'paused' ? 1 : 0 };
    }
    request.resolve(Response.json(payload)); await request.delivered; await settle();
    return { delivered: true, payload };
  };
  qa.billingFetch = (url, init) => {
    const method = init.method || 'GET';
    if (method === 'GET') billing.reads.push(url.pathname);
    if (url.pathname === '/api/auth/me' && method === 'GET') return Response.json({ authRequired: true, authenticated: true, permissions: ['customer.read', 'billing.write-demo'], user: { id: 'qa-billing', name: 'Cobrança Fictícia', email: 'billing@example.invalid', role: 'Cobrança' } });
    if (url.pathname === '/api/conversations' && method === 'GET') return Response.json({ items: [] });
    if (url.pathname === '/api/billing/invoices/reissue' && method === 'GET') return Response.json({ writeEnabled: false });
    if (url.pathname === '/api/billing/promises') {
      if (method === 'GET') return Response.json({ available: true, pending: promise?.status === 'pending' ? [promise] : [] });
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        if (['create', 'review'].includes(body.action)) return hold(url.pathname, body);
      }
    }
    if (url.pathname === '/api/billing/rules' && method === 'GET') return Response.json({ available: true, rule: { name: 'Régua FICTÍCIA', version: 1, updatedAt: clock, authorId: 'qa-billing', steps: [{ offsetDays: 1, channel: 'WhatsApp', templateId: 'SYNTHETIC_ONLY', attempts: 1, active: true }] } });
    if (url.pathname === '/api/billing/collections/dispatch') {
      if (method === 'GET' && !url.searchParams.has('format')) return Response.json({ available: true, period: '30d', scope: 'allowlist', today: { scheduledFor: clock.slice(0, 10), candidates: paid || promise?.status === 'pending' ? 0 : 1 }, indicators: { total: 0, byStep: {} } });
      if (method === 'POST') { const body = JSON.parse(init.body); if (body.action === 'run') return hold(url.pathname, body); }
    }
    return null;
  };
}
