import assert from 'node:assert/strict';

export async function runHandoffCases({ command, evaluate, wait, go, click, button, record }) {
  const body = () => evaluate('return document.body.innerText');
  for (const width of [1440, 390]) for (const role of ['writer', 'reader']) {
    await command('/goog/cdp/execute', { cmd: 'Emulation.setDeviceMetricsOverride', params: { width, height: 900, deviceScaleFactor: 1, mobile: false } });
    await go(`/?handoffRole=${role}&width=${width}#/atendimento`);
    await wait("document.querySelector('.inbox-item') && document.querySelector('.bubble.suggestion')");
    if (width === 390) await click('.inbox-item');
    assert.match(await body(), /CONTEXTO_FICTICIO_A/);
    assert.match(await body(), /Sugestão da IA — não enviada ao cliente/);
    assert.match(await body(), /IA pediu humano/);
    assert.match(await evaluate("return document.querySelector('.chat-actions').innerText"), /Com a IA/);
    assert.equal(await evaluate('return qa.handoff.states.length'), 0);
    if (role === 'reader') {
      assert.match(await body(), /O envio pela tela não está disponível para seu acesso/);
      assert.equal(await evaluate('return document.querySelector(\'textarea[aria-label="Resposta ao cliente"]\')'), null);
      // Known UI gap: state controls are still offered to read-only users.
      // A fictitious 403 demonstrates error rendering, NOT backend authorization.
      await button('Assumir'); await wait('qa.handoff.states.length===1');
      assert.deepEqual(await evaluate('return qa.handoff.states[0].body'), { conversationId: 'SYNTHETIC_HANDOFF_A', action: 'claim', takeOver: false });
      await evaluate("return qa.handoff.releaseState(0,'denied')");
      await wait("document.body.innerText.includes('RECUSA_FICTICIA_SEM_ESCRITA')");
      assert.match(await evaluate("return document.querySelector('.chat-actions').innerText"), /Com a IA/);
      assert.equal(await evaluate('return qa.handoff.states.length'), 1);
      await record('H02-characterization', { width, composerBlocked: true, knownGap: 'state control still offered; mocked403 only', backendAuthorization: 'not tested' });
      continue;
    }
    if (width === 390) await button('Mostrar detalhes do cliente');
    await button('Copiloto'); await button('Resumir para transferir');
    await wait('qa.handoff.summaries.length===1');
    assert.deepEqual(await evaluate('return qa.handoff.summaries[0].body'), { action: 'summary', channel: 'qa-synthetic', conversationId: 'SYNTHETIC_HANDOFF_A', question: '' });
    assert.doesNotMatch(await body(), /RESUMO_FICTICIO_A/);
    await evaluate('return qa.handoff.releaseSummary(0)');
    await wait("document.querySelector('.copilot-answer')?.innerText.includes('RESUMO_FICTICIO_A')");
    assert.equal(await evaluate("return document.querySelector('textarea').value"), '', 'summary must not become a sent message or draft');
    assert.equal(await evaluate("return document.querySelectorAll('.bubble.agent').length"), 0);
    await button('Cliente');
    assert.match(await evaluate("return document.querySelector('.facts').innerText"), /Ninguém — a IA sugere/);
    if (width === 390) await button('Fechar detalhes');
    for (const [index, label, action, outcome, expected] of [
      [0, 'Assumir', 'claim', 'claimed', 'Com você'],
      [1, 'Resolver', 'resolve', 'resolved', 'Resolvida'],
      [2, 'Reabrir', 'reopen', 'reopened', 'Com a IA'],
    ]) {
      const before = await evaluate("return document.querySelector('.chat-actions').innerText");
      await button(label); await wait(`qa.handoff.states.length===${index + 1}`);
      assert.deepEqual(await evaluate(`return qa.handoff.states[${index}].body`), { conversationId: 'SYNTHETIC_HANDOFF_A', action, takeOver: false });
      assert.equal(await evaluate("return document.querySelector('.chat-actions').innerText"), before, 'request alone must not confirm state');
      await evaluate(`return qa.handoff.releaseState(${index},'${outcome}')`);
      await wait(`document.querySelector('.chat-actions').innerText.includes('${expected}')`);
      if (action === 'claim') {
        if (width === 390) await button('Mostrar detalhes do cliente');
        assert.match(await evaluate("return document.querySelector('.facts').innerText"), /Operador Fictício \(você\)/);
        if (width === 390) await button('Fechar detalhes');
      }
      assert.equal(await evaluate('return qa.handoff.states.length'), index + 1);
      assert.match(await body(), /CONTEXTO_FICTICIO_A/);
      assert.equal(await evaluate("return document.querySelectorAll('.bubble.agent').length"), 0);
    }
    await record('H01', { width, summaryContext: true, claimResolveReopen: true, transitions: 'explicit mocked responses', sends: 0 });
  }
}
