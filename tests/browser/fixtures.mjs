// UI-only API doubles. No handler, account, cookie or persistence E2E claim.
export function installFixtures(data) {
  const qa = window.qa = { pending: [], unexpected: [], me: null, logoutFails: false };
  const valid = { authRequired: true, authenticated: true, permissions: ['customer.read','support.write'],
    user: { id: 'qa', name: 'Operador Fictício', email: 'qa@example.invalid', role: 'Supervisor' } };
  const invalid = { authRequired: true, authenticated: false, permissions: [] };
  qa.release = (index, id) => qa.pending[index].resolve(Response.json(data[id]));
  window.fetch = async (input, init = {}) => {
    const url = new URL(input, location.origin);
    if (url.origin !== location.origin) { qa.unexpected.push('external'); throw Error('QA_EXTERNAL_BLOCKED'); }
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
    if (url.pathname === '/api/customers') {
      if (!url.searchParams.has('id')) return Response.json({ items: Object.values(data).map(v => v.customer), total: 2, pageSize: 10, scope: 'allowlist', mode: 'demo' });
      // Deliberately ignore abort: exercise a transport/body completing too late.
      return new Promise(resolve => qa.pending.push({ resolve, id: url.searchParams.get('id'), signal: init.signal }));
    }
    qa.unexpected.push(url.pathname); throw Error('QA_UNEXPECTED_API');
  };
}
