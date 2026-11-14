// Explicit UI doubles, not a backend authorization or persistence implementation.
export function installHandoffFixtures() {
  const readOnly = new URLSearchParams(location.search).get('handoffRole') === 'reader';
  const id = 'SYNTHETIC_HANDOFF_A', channel = 'qa-synthetic';
  const viewer = { id: 'qa', name: 'Operador Fictício' };
  const at = new Date().toISOString();
  const initial = { status: 'open', reopened: false, assigneeId: null, assigneeName: null, assignedAt: null, resolvedAt: null, resolvedBy: null };
  const state = { ...initial };
  const qa = window.qa;
  qa.handoff = { states: [], summaries: [], reads: 0 };
  const messages = [
    { role: 'customer', content: 'CONTEXTO_FICTICIO_A: preciso de uma pessoa para conferir meu pedido.', createdAt: at },
    { role: 'suggestion', content: 'SUGESTAO_FICTICIA_A: encaminhar para atendimento humano.', createdAt: at },
  ];
  const settle = async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const hold = async (queue, body) => {
    let acknowledge;
    const delivered = new Promise(resolve => { acknowledge = resolve; });
    const response = await new Promise(resolve => queue.push({ body, resolve, delivered }));
    acknowledge(); return response;
  };
  qa.handoff.releaseState = async (index, outcome) => {
    const request = qa.handoff.states[index];
    // Test supplies outcome explicitly; a request alone never changes the fixture.
    if (outcome === 'claimed') Object.assign(state, initial, { assigneeId: viewer.id, assigneeName: viewer.name, assignedAt: at });
    else if (outcome === 'resolved') Object.assign(state, { status: 'resolved', resolvedAt: at, resolvedBy: viewer.name });
    else if (outcome === 'reopened') Object.assign(state, initial);
    else if (outcome !== 'denied') throw Error('QA_UNKNOWN_STATE_OUTCOME');
    request.resolve(Response.json(outcome === 'denied' ? { error: 'RECUSA_FICTICIA_SEM_ESCRITA' } : { state: { ...state } }, { status: outcome === 'denied' ? 403 : 200 }));
    await request.delivered; await settle(); return { delivered: true };
  };
  qa.handoff.releaseSummary = async index => {
    const request = qa.handoff.summaries[index];
    request.resolve(Response.json({ summary: 'RESUMO_FICTICIO_A: pedido de pessoa; contexto preservado; ainda sem envio.' }));
    await request.delivered; await settle(); return { delivered: true };
  };
  qa.handoffFetch = (url, init) => {
    if (url.pathname === '/api/auth/me') return Response.json({ authRequired: true, authenticated: true,
      permissions: readOnly ? ['customer.read'] : ['customer.read', 'support.write'], user: { ...viewer, email: 'qa@example.invalid', role: readOnly ? 'Leitor' : 'Supervisor' } });
    if (url.pathname === '/api/conversations' && (!init.method || init.method === 'GET')) {
      qa.handoff.reads++;
      if (url.searchParams.has('id')) {
        if (url.searchParams.get('id') !== id || url.searchParams.get('channel') !== channel) throw Error('QA_WRONG_CONVERSATION');
        return Response.json({ messages, audit: { intent: 'human_handoff', finalStatus: 'handoff', handoff: true, handoffReason: 'human_requested', intentSource: 'rules', intentConfidence: null, intentModel: null, appVersion: 'qa', correlationId: 'SYNTHETIC', createdAt: at },
          replyWindow: { lastCustomerAt: at, closesAt: new Date(Date.now() + 3600000).toISOString(), open: true } });
      }
      return Response.json({ available: true, viewer, channelState: { enabled: true, autoReply: false, canReply: !readOnly }, items: [{ channel, externalConversationId: id, displayName: 'Conversa Fictícia A', lastMessage: messages[1].content, lastCustomerMessage: messages[0].content, lastRole: 'suggestion', lastAt: at, lastCustomerAt: at, messages: 2, handoff: true, finalStatus: 'handoff', intent: 'human_handoff', state: { ...state } }] });
    }
    if (url.pathname === '/api/agent/replies') return Response.json({ items: [] });
    if (url.pathname === '/api/conversations/state' && init.method === 'POST') return hold(qa.handoff.states, JSON.parse(init.body));
    if (url.pathname === '/api/copilot' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.action === 'summary' && body.channel === channel && body.conversationId === id) return hold(qa.handoff.summaries, body);
    }
    return null; // Base fixture ledger rejects unexpected APIs, including send paths.
  };
}
