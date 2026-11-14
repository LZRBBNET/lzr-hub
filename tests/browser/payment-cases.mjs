import assert from 'node:assert/strict';

// Actual InvoicePaymentPages inside Customer360Module; only API responses are doubles.
export async function runPaymentCases({ command, evaluate, wait, go, click, button, record }) {
  let caseNumber = 0;
  const openA = async () => {
    // A unique query forces a new document; same-URL hash navigation may retain state.
    await go(`/?paymentCase=${++caseNumber}#/clientes`); await wait("document.querySelectorAll('button.tr.stack-sm').length===2");
    assert.equal(await evaluate('return qa.pending.length'), 0);
    await click('button.tr.stack-sm'); await wait('qa.pending.length===1');
    await evaluate("return qa.release(0,'810001')");
    await wait("document.querySelector('.invoice-payments button')");
    assert.equal(await evaluate('return qa.payments.length'), 0, 'payments must remain idle until requested');
    await button('Consultar pagamentos desta fatura'); await wait('qa.payments.length===1');
  };
  const text = () => evaluate("return document.querySelector('.invoice-payments').innerText");
  for (const width of [1440, 390]) {
    await command('/goog/cdp/execute', { cmd: 'Emulation.setDeviceMetricsOverride', params: { width, height: 900, deviceScaleFactor: 1, mobile: false } });
    const detail = width === 390 ? '.modal[open]' : '.customer-detail';
    for (const kind of ['empty', 'unknown', 'error']) {
      await openA();
      assert.equal((await evaluate(`return qa.releasePayment(0,'${kind}')`)).delivered, true);
      const visible = await text();
      if (kind === 'empty') {
        assert.match(visible, /Nenhum registro nesta página/);
        assert.match(visible, /Total informado nesta fatura: 0/);
        assert.match(visible, /Não é o histórico total do cliente/);
        assert.match(visible, /sem somar pagamentos nem confirmar quitação/);
        assert.match(visible, /Fonte sintética/);
      } else if (kind === 'unknown') {
        assert.match(visible, /Total informado nesta fatura: não confirmado/);
        assert.match(visible, /Valor não confirmado/);
        assert.doesNotMatch(visible, /R\$ 0,00|Nenhum registro nesta página|Total informado nesta fatura: 0/);
        assert.equal(await evaluate("return [...document.querySelectorAll('.invoice-payments button')].find(b=>b.textContent==='Próxima').disabled"), true);
      } else {
        assert.match(visible, /Página não confirmada. Nenhuma ação de pagamento foi executada/);
        assert.doesNotMatch(visible, /SYNTHETIC_PRIVATE_ERROR|Nenhum registro nesta página|Total informado nesta fatura/);
        assert.equal(await evaluate("return document.querySelector('.invoice-payments section')"), null);
      }
      assert.equal(await evaluate('return qa.payments.length'), 1, 'no automatic payment retry');
      await record('C02-payments', { width, response: kind, scope: 'invoice page only' });
    }

    for (const phase of ['transport', 'json']) for (const action of ['switch', 'close']) {
      await openA();
      if (phase === 'json') {
        await evaluate("return qa.paymentHeaders(0,'late')");
        await wait('qa.payments[0].bodyStarted');
        assert.match(await text(), /Consultando/);
        assert.equal(await evaluate("return document.querySelector('.invoice-payments section')"), null);
      }
      if (action === 'close' || width === 390) await button('Fechar');
      if (action === 'switch') {
        await click('button.tr.stack-sm:nth-of-type(2)'); await wait('qa.pending.length===2');
        await evaluate("return qa.release(1,'810002')");
        await wait(`document.querySelector('${detail}')?.innerText.includes('Cadastro fictício 810002')`);
      }
      assert.equal(await evaluate('return qa.payments[0].signal.aborted'), true);
      const result = await evaluate(phase === 'json' ? 'return qa.releasePaymentBody(0)' : "return qa.releasePayment(0,'late')");
      assert.equal(result[phase === 'json' ? 'bodyDelivered' : 'delivered'], true);
      assert.equal(result.aborted, true);
      assert.doesNotMatch(await evaluate('return document.body.innerText'), /SYNTHETIC_LATE_PAYMENT/);
      if (action === 'switch') {
        assert.ok(await evaluate(`return document.querySelector('${detail}').innerText.includes('Cadastro fictício 810002')`));
        assert.equal(await evaluate("return document.querySelector('.invoice-payments section')"), null);
      } else {
        assert.equal(await evaluate(`return document.querySelector('${detail}')`), null);
        await click('button.tr.stack-sm'); await wait('qa.pending.length===2');
        await evaluate("return qa.release(1,'810001')");
        await wait("document.querySelector('.invoice-payments button')");
        assert.equal(await evaluate('return qa.payments.length'), 1, 'reopening must not replay payment read');
        assert.equal(await evaluate("return document.querySelector('.invoice-payments section')"), null);
        await button('Consultar pagamentos desta fatura'); await wait('qa.payments.length===2');
        await evaluate("return qa.releasePayment(1,'empty')");
        assert.match(await text(), /Nenhum registro nesta página/);
        assert.doesNotMatch(await text(), /SYNTHETIC_LATE_PAYMENT/);
      }
      await record(action === 'switch' ? 'C03-payments' : 'C04-payments', { width, phase, stalePaymentDiscarded: true });
    }
  }
}
