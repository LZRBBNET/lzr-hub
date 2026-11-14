import assert from 'node:assert/strict';

export async function runBillingCases({ command, evaluate, wait, go, click, button, fill, record }) {
  const body = () => evaluate('return document.body.innerText');
  const candidates = () => evaluate("return [...document.querySelectorAll('.stat')].find(s=>s.querySelector('.stat-label')?.textContent.startsWith('Faturas para hoje')).querySelector('.stat-value').textContent");
  const promiseTab = async () => {
    await click('.tabs a[href="#/acoes-cobranca"]');
    await wait("document.querySelector('[aria-label=Operação]')");
    await click('[aria-label=Operação] button:nth-child(3)');
    await wait("document.body.innerText.includes('Registrar promessa') && document.querySelector('input[type=date]')");
  };
  const ruleTab = async () => {
    await click('.tabs a[href="#/regua"]');
    await wait("document.querySelector('.stat-value') && document.body.innerText.includes('Disparo de hoje')");
  };
  const dispatch = async (index, outcome) => {
    const previous = await evaluate("return document.querySelector('.dispatch-result')?.textContent ?? null");
    await button('Rodar disparo'); await wait(`qa.billing.requests.length===${index + 1}`);
    assert.deepEqual(await evaluate(`return qa.billing.requests[${index}].body`), { action: 'run' });
    assert.equal(await evaluate(`return qa.billing.requests[${index}].path`), '/api/billing/collections/dispatch');
    assert.equal(await evaluate("return document.querySelector('.dispatch-result')?.textContent ?? null"), previous, 'pending request must not confirm a new result');
    const result = await evaluate(`return qa.billing.release(${index},'${outcome}')`);
    assert.equal(result.delivered, true); assert.equal(result.payload.enqueued, 0);
    await wait("document.querySelector('.dispatch-result')");
    return result.payload;
  };
  for (const width of [1440, 390]) {
    await command('/goog/cdp/execute', { cmd: 'Emulation.setDeviceMetricsOverride', params: { width, height: 900, deviceScaleFactor: 1, mobile: false } });
    await go(`/?billingCase=promise-${width}#/regua`);
    await wait("document.querySelector('.stat-value')");
    assert.equal(await candidates(), '1');
    await promiseTab(); await wait("document.body.innerText.includes('Nenhuma promessa pendente')");
    await fill('input[placeholder="ex.: 4821"]', '901');
    await fill('input[placeholder="ex.: 21857"]', '10');
    // Native value setter + DOM event avoids browser/OS-specific date keystrokes.
    await evaluate("const input=document.querySelector('input[type=date]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'2026-11-20');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true");
    await button('Registrar promessa'); await wait('qa.billing.requests.length===1');
    assert.deepEqual(await evaluate('return qa.billing.requests[0].body'), { action: 'create', invoiceId: '901', customerId: '10', promisedFor: '2026-11-20' });
    assert.equal(await evaluate('return qa.billing.requests[0].path'), '/api/billing/promises');
    assert.doesNotMatch(await body(), /Promessa registrada\./);
    assert.equal(await evaluate("return document.querySelector('.row-main')"), null);
    assert.equal((await evaluate("return qa.billing.release(0,'created')")).delivered, true);
    await wait("document.querySelector('.row-main')?.innerText.includes('Fatura 901')");
    assert.match(await body(), /Pendente/);
    assert.match(await body(), /Promessa quebrada não dispara mensagem/);
    await record('B01', { width, createRequestVerified: true, pendingRendered: true, storage: 'fixture only' });

    await ruleTab(); assert.equal(await candidates(), '0');
    const paused = await dispatch(1, 'paused');
    assert.equal(paused.pausedByPromise, 1);
    assert.match(await body(), /0 candidato\(s\)/);
    assert.match(await body(), /nada foi enfileirado/);
    assert.match(await body(), /não a entrega/);
    await record('B02', { width, candidatesRendered: 0, pauseDecision: 'fixture only; pausedByPromise not displayed', realLedger: 'not tested' });

    assert.deepEqual(await evaluate('return qa.billing.preparePaid()'), { fixtureOnly: true, synthetic: true, delivered: false });
    await promiseTab(); await wait("document.querySelector('.row-main')?.innerText.includes('Fatura 901')");
    await button('Conferir no IXC'); await wait('qa.billing.requests.length===3');
    assert.deepEqual(await evaluate('return qa.billing.requests[2].body'), { action: 'review' });
    assert.doesNotMatch(await body(), /1 cumprida\(s\)/);
    await evaluate("return qa.billing.release(2,'fulfilled')");
    await wait("document.body.innerText.includes('1 cumprida(s)') && document.body.innerText.includes('Nenhuma promessa pendente')");
    assert.equal(await evaluate("return document.querySelector('.row-main')"), null);
    await ruleTab(); assert.equal(await candidates(), '0');
    await dispatch(3, 'paid'); assert.match(await body(), /0 candidato\(s\)/);
    await record('B03', { width, paymentPreparation: 'fixture API, no payment button', reviewRendered: true, candidateExclusion: 'fixture response only' });

    await go(`/?billingCase=hours-${width}#/regua`); await wait("document.querySelector('.stat-value')");
    assert.equal(await candidates(), '1');
    await evaluate("qa.billing.setClock('2026-11-17T02:00:00Z');return true");
    const outside = await dispatch(0, 'outside');
    assert.equal(outside.recorded, 0);
    assert.match(await body(), /Fora do horário comercial: 1 candidato\(s\)/);
    assert.match(await body(), /nada foi registrado/);
    assert.match(await body(), /entre 8h e 20h/);
    await evaluate("qa.billing.setClock('2026-11-17T15:00:00Z');return true");
    await dispatch(1, 'queue-off');
    assert.match(await body(), /1 candidato\(s\)/);
    assert.match(await body(), /A fila de envio está desligada/);
    assert.match(await body(), /nada foi enfileirado/);
    assert.doesNotMatch(await evaluate("return document.querySelector('.dispatch-result').innerText"), /Fora do horário comercial/);
    assert.equal(await evaluate('return qa.billing.requests.length'), 2);
    await record('B04', { width, outsideHoursAndQueueOffRendered: true, clock: 'fixture only', schedulingPolicy: 'not executed by UI' });
  }
}
