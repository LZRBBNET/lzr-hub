import assert from 'node:assert/strict';

export async function runSearchCases({ command, evaluate, wait, go, click, button, record }) {
  for (const width of [1440, 390]) {
    await command('/goog/cdp/execute', { cmd: 'Emulation.setDeviceMetricsOverride', params: { width, height: 900, deviceScaleFactor: 1, mobile: false } });
    await go(`/?searchCase=${width}#/clientes`);
    await wait('qa.searches.length===1');
    await evaluate("return qa.releaseSearch(0,['810001','810002'])");
    await wait("document.querySelectorAll('button.tr.stack-sm').length===2");
    const type = async text => {
      const el = await command('/element', { using: 'css selector', value: '[aria-label="Buscar cliente"]' });
      const path = `/element/${el['element-6066-11e4-a52e-4f735466cecf']}`;
      await command(path + '/click', {});
      // Native keyboard replacement (no JS input assignment or synthetic events).
      await command(path + '/value', { text: '\uE009a\uE000' + text });
    };
    await type('cad & 810002');
    await wait('qa.searches.length===2');
    const search = await evaluate('return {requests:qa.searches.map(({query,risk,page,at})=>({query,risk,page,at})), input:qa.searchInputs.at(-1)}');
    assert.equal(search.requests.length, 2);
    assert.equal(search.requests[0].query, '');
    assert.equal(search.requests[1].query, 'cad & 810002');
    assert.equal(search.requests[1].risk, 'all'); assert.equal(search.requests[1].page, '1');
    assert.equal(search.input.value, 'cad & 810002');
    assert.ok(search.requests[1].at - search.input.at >= 330, '350ms debounce must follow the last native input');
    await evaluate("return qa.releaseSearch(1,['810002'])");
    await wait("document.querySelectorAll('button.tr.stack-sm').length===1");
    assert.match(await evaluate("return document.querySelector('button.tr.stack-sm').innerText"), /810002/);
    await record('C01-keyboard-debounce', { width, source: 'fictitious list API', queryEncoding: true });

    await type('sem resultado'); await wait('qa.searches.length===3');
    await evaluate("return qa.releaseSearch(2,'empty')");
    await wait("document.body.innerText.includes('Nenhum cliente encontrado')");
    assert.equal(await evaluate("return document.querySelectorAll('button.tr.stack-sm').length"), 0);
    await type('erro'); await wait('qa.searches.length===4');
    await evaluate("return qa.releaseSearch(3,'error')");
    await wait("document.body.innerText.includes('Não foi possível carregar os clientes')");
    assert.equal(await evaluate("return document.body.innerText.includes('Nenhum cliente encontrado')"), false);
    await record('C01-empty-error', { width });

    await type('antiga'); await wait('qa.searches.length===5');
    await type('atual'); await wait('qa.searches.length===6');
    await evaluate("return qa.releaseSearch(5,['810002'])");
    await wait("document.querySelectorAll('button.tr.stack-sm').length===1");
    await click('button.tr.stack-sm'); await wait('qa.pending.length===1');
    await evaluate("return qa.release(0,'810002')");
    const detail = width === 390 ? '.modal[open]' : '.customer-detail';
    await wait(`document.querySelector('${detail}')?.innerText.includes('Cadastro fictício 810002')`);
    assert.deepEqual(await evaluate("return qa.releaseSearch(4,['810001'])"), { delivered: true, bodyConsumed: true });
    assert.match(await evaluate(`return document.querySelector('${detail}').innerText`), /Cadastro fictício 810002/);
    assert.equal(await evaluate("return document.querySelectorAll('button.tr.stack-sm').length"), 1);
    assert.match(await evaluate("return document.querySelector('button.tr.stack-sm').innerText"), /810002/);
    assert.equal(await evaluate('return qa.searches.length'), 6);
    await button('Fechar');
    await record('C01-out-of-order-selection', { width, lateBodyConsumed: true });
  }
}
