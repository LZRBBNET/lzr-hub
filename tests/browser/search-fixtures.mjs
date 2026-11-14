// Explicit list API double; the component owns debounce and obsolete-result discard.
export function installSearchFixtures(data) {
  const qa = window.qa;
  qa.searches = [];
  qa.searchInputs = [];
  window.addEventListener('input', event => {
    if (event.target.getAttribute('aria-label') === 'Buscar cliente') {
      qa.searchInputs.push({ value: event.target.value, at: performance.now() });
    }
  });
  qa.searchFetch = async url => {
    let delivered;
    const request = { query: url.searchParams.get('q'), risk: url.searchParams.get('risk'),
      page: url.searchParams.get('page'), at: performance.now(),
      delivered: new Promise(resolve => { delivered = resolve; }) };
    qa.searches.push(request);
    const response = await new Promise(resolve => { request.resolve = resolve; });
    delivered();
    return response;
  };
  qa.releaseSearch = async (index, kind) => {
    const request = qa.searches[index];
    if (!request || request.released) throw Error('QA_SEARCH_RELEASE_INVALID');
    request.released = true;
    const items = kind === 'empty' || kind === 'error' ? [] : kind.map(id => data[id].customer);
    const response = Response.json({ items, total: items.length, pageSize: 10, scope: 'allowlist', mode: 'demo' },
      { status: kind === 'error' ? 503 : 200 });
    let consumed;
    const body = new Promise(resolve => { consumed = resolve; });
    const json = response.json.bind(response);
    response.json = async () => { const result = await json(); consumed(); return result; };
    request.resolve(response);
    await request.delivered;
    if (response.ok) await body;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 0));
    return { delivered: true, bodyConsumed: response.ok };
  };
}
