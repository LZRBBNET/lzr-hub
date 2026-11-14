import assert from 'node:assert/strict';

// Native browser interactions with real components; admission endpoints are doubles.
export async function runReadmissionCases({ command, evaluate, wait, go, click, button, record }) {
  let number = 0;
  const open = async () => {
    await go(`/?readmissionCase=${++number}#/clientes`);
    await wait("qa.sessions.length===1 && document.querySelectorAll('button.tr.stack-sm').length===2");
    assert.equal(await evaluate('return qa.pending.length'), 0);
    await evaluate('qa.holdSession=true; return true');
    await click('button.tr.stack-sm'); await wait('qa.pending.length===1');
  };
  const detail = async () => {
    await evaluate("return qa.release(0,'810001')");
    await wait("document.querySelectorAll('.invoice-payments').length===2");
  };
  const pay = async index => {
    await wait("document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).every(a=>a.playState!=='running')");
    const element = await command('/element', { using: 'xpath', value: `(//*[@class='invoice-payments']/button)[${index + 1}]` });
    await command(`/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
  };
  const safe = async () => {
    assert.equal(await evaluate('return location.pathname'), '/');
    assert.equal(await evaluate('return qa.logoutCalls'), 0);
    assert.equal(await evaluate("return localStorage.getItem('qa-session')"), 'yes');
    assert.doesNotMatch(await evaluate('return document.body.innerText'), /SYNTHETIC_PRIVATE_ERROR/);
  };
  for (const width of [1440, 390]) {
    await command('/goog/cdp/execute', { cmd: 'Emulation.setDeviceMetricsOverride', params: { width, height: 900, deviceScaleFactor: 1, mobile: false } });
    const selected = width === 390 ? '.modal[open]' : '.customer-detail';

    await open(); await evaluate('return qa.detail401(0)'); await wait('qa.sessions.length===2');
    await evaluate("return qa.releaseSession(1,'unavailable')");
    await wait("document.body.innerText.includes('Não foi possível verificar sua sessão agora')");
    await safe();
    assert.equal(await evaluate("return document.querySelector('.app-shell')"), null);
    assert.equal(await evaluate('return qa.pending.length'), 1);
    // Reload is the actual manual recovery control, not a fake session injection.
    await button('Tentar novamente');
    await wait("qa.sessions.length===1 && document.querySelector('button.tr.stack-sm')");
    assert.equal(await evaluate('return qa.pending.length'), 0);
    assert.equal(await evaluate(`return document.querySelector('${selected}')`), null);
    await safe();
    await click('button.tr.stack-sm'); await wait('qa.pending.length===1');
    await evaluate("return qa.release(0,'810001')");
    await wait("document.querySelector('.invoice-payments')");
    await record('S02', { width, unavailable503: true, manualReloadRecovery: true, noAutomaticDetailReplay: true });

    await open(); await detail();
    await pay(0); await pay(1); await wait('qa.payments.length===2');
    await evaluate('return Promise.all([qa.payment401(0),qa.payment401(1)])');
    const bothDenied = async () => {
      const panels = await evaluate("return [...document.querySelectorAll('.invoice-payments')].map(p=>({text:p.innerText,disabled:p.querySelector('button').disabled}))");
      assert.equal(panels.length, 2);
      for (const panel of panels) {
        assert.match(panel.text, /Página não confirmada. Nenhuma ação de pagamento foi executada/);
        assert.equal(panel.disabled, false, 'each denied origin must finish loading');
      }
    };
    await bothDenied();
    assert.equal(await evaluate('return qa.sessions.length'), 2, 'two live origins must share one readmission');
    await evaluate("return qa.releaseSession(1,'same')"); await safe();
    await bothDenied();
    assert.equal(await evaluate('return qa.payments.length'), 2);
    assert.equal(await evaluate('return qa.pending.length'), 1);
    assert.equal(await evaluate("return document.querySelectorAll('.invoice-payments section').length"), 0);
    await pay(0); await wait('qa.payments.length===3');
    await evaluate("return qa.releasePayment(2,'empty')");
    assert.match(await evaluate('return document.body.innerText'), /Nenhum registro nesta página/);
    await record('S03-shared-same', { width, concurrent401s: 2, admissionRequests: 1, manualPaymentRecovery: true });

    for (const identity of ['actor', 'permissions']) {
      await open(); await detail(); await pay(0); await wait('qa.payments.length===1');
      await evaluate("return qa.paymentHeaders(0,'late')"); await wait('qa.payments[0].bodyStarted');
      await pay(1); await wait('qa.payments.length===2');
      await evaluate('return qa.payment401(1)'); await wait('qa.sessions.length===2');
      await evaluate(`return qa.releaseSession(1,'${identity}')`); await safe();
      assert.equal(await evaluate(`return document.querySelector('${selected}')`), null);
      assert.equal((await evaluate('return qa.releasePaymentBody(0)')).bodyDelivered, true);
      assert.equal(await evaluate('return qa.payments[0].signal.aborted'), true);
      assert.doesNotMatch(await evaluate('return document.body.innerText'), /SYNTHETIC_LATE_PAYMENT|Fatura 8100011/);
      assert.equal(await evaluate('return qa.payments.length'), 2);
      assert.equal(await evaluate('return qa.pending.length'), 1);
      if (identity === 'actor') {
        await click('.user-trigger');
        assert.match(await evaluate("return document.querySelector('[role=menu]').innerText"), /Operador Fictício Novo/);
        await click('.user-trigger');
      }
      await click('button.tr.stack-sm'); await wait('qa.pending.length===2');
      await evaluate("return qa.release(1,'810001')");
      await wait("document.querySelector('.invoice-payments')");
      assert.equal(await evaluate("return document.querySelector('.invoice-payments section')"), null);
      assert.equal(await evaluate('return qa.payments.length'), 2);
      await record('S03-identity', { width, change: identity, previousStateDiscarded: true, lateJSONDiscarded: true });
    }

    await open(); await evaluate('return qa.detail401(0)'); await wait('qa.sessions.length===2');
    await evaluate("return qa.sessionHeaders(1,'invalid')"); await wait('qa.sessions[1].bodyStarted');
    if (width === 390) await button('Fechar');
    await click('button.tr.stack-sm:nth-of-type(2)'); await wait('qa.pending.length===2');
    await evaluate("return qa.release(1,'810002')");
    assert.equal((await evaluate('return qa.releaseSessionBody(1)')).bodyDelivered, true);
    await safe();
    assert.ok(await evaluate(`return document.querySelector('${selected}').innerText.includes('Cadastro fictício 810002')`));
    assert.equal(await evaluate('return qa.sessions.length'), 2);
    assert.equal(await evaluate('return qa.pending.length'), 2);
    await record('S03-obsolete-origin', { width, lateInvalidJSONDiscarded: true, newerCustomerPreserved: true });
  }
}
