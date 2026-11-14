// Real client application/components + production CSS; APIs are explicit UI doubles.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { Customer360Service } from '../lib/platform/customer360-service.ts';
import { openBrowser } from './qa-browser.mjs';
import { registerCleanup } from './qa-lifecycle.mjs';
import { runPaymentCases } from '../tests/browser/payment-cases.mjs';
import { runReadmissionCases } from '../tests/browser/readmission-cases.mjs';

const data = {};
for (const id of ['810001', '810002']) {
  const snapshot = { customer: { id, name: `Cadastro fictício ${id}`, document: 'SYNTHETIC', phone: '—', email: '—', address: '—', city: '—', neighborhood: '—', status: 'S' },
    contracts: [], plan: null,
    invoices: ['1', '2'].map(suffix => ({ id: id + suffix, customerId: id, status: 'A', dueAt: '2026-11-01', value: 40, valueSource: 'open-balance' })),
    payments: [], serviceOrders: [], connection: null,
    partialSources: [], metrics: { totalLatencyMs: 0, blockLatencies: {} }, fetchedAt: '2026-11-14T12:00:00Z', mode: 'staging-readonly', cache: 'miss' };
  data[id] = await new Customer360Service(undefined, { getSnapshot: async () => snapshot }, [id], false).get(id);
  data[id].mode = 'demo';
}
const built = await build({ entryPoints: ['tests/browser/entry.jsx'], bundle: true, write: false,
  platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
const cssRoot = 'work/synthetic-web/dist/client/assets';
const cssFiles = (await readdir(cssRoot)).filter(name => name.endsWith('.css'));
assert.ok(cssFiles.length, 'Run the existing synthetic build before UI QA');
const css = (await Promise.all(cssFiles.map(name => readFile(join(cssRoot, name), 'utf8')))).join('\n');
const assets = new Map([
  ['/app.js', ['text/javascript', built.outputFiles[0].text]],
  ['/fixtures.js', ['text/javascript', `window.fixtureData=${JSON.stringify(data)};`]],
  ['/style.css', ['text/css', css]],
]);
const html = '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA fictício LZR</title><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script src="/fixtures.js"></script><script src="/app.js"></script></body></html>';
const unexpected = [];
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const asset = assets.get(path);
  response.setHeader('content-security-policy', "default-src 'self'; connect-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-src 'none'");
  response.setHeader('cache-control', 'no-store');
  if (asset) { response.setHeader('content-type', asset[0]); response.end(asset[1]); }
  else if (path === '/' || path === '/login') { response.setHeader('content-type', 'text/html'); response.end(html); }
  else if (path === '/favicon.ico') { response.writeHead(204).end(); }
  else { unexpected.push(path); response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let serverClosing;
const closeServer = () => serverClosing ??= new Promise(resolve => {
  server.closeAllConnections(); server.close(resolve);
});
const unregisterServer = registerCleanup(closeServer);
let failure;
const evidence = [];
try {
  if (process.argv.includes('--build-only')) {
    assert.equal((await fetch(origin + '/login')).status, 200);
    assert.ok((await (await fetch(origin + '/app.js')).text()).includes('QA_EXTERNAL_BLOCKED'));
    console.log('UI bundle, production CSS and loopback server verified; browser NOT run.');
  } else {
    browser = await openBrowser();
    const { command, evaluate } = browser;
    const wait = async expression => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`return Boolean(${expression})`)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error(`UI condition timed out: ${expression}`);
    };
    const go = async path => { await command('/url', { url: origin + path }); await wait('window.qa'); };
    const element = async selector => {
      const el = await command('/element', { using: 'css selector', value: selector });
      return el['element-6066-11e4-a52e-4f735466cecf'];
    };
    const click = async selector => command(`/element/${await element(selector)}/click`, {});
    const fill = async (selector, text) => {
      const id = await element(selector);
      await command(`/element/${id}/clear`, {});
      await command(`/element/${id}/value`, { text });
    };
    const button = async text => {
      // Native clicks must wait for finite dialog/menu entrance animations;
      // loading skeletons may intentionally animate forever.
      await wait("document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).every(a=>a.playState!=='running')");
      const result = await command('/element', { using: 'xpath', value: `//button[normalize-space(.)='${text}' or @aria-label='${text}']` });
      await command(`/element/${result['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
    };
    const record = async (id, extra = {}) => {
      assert.deepEqual(await evaluate('return window.qa.errors()'), []);
      evidence.push({ id, ...extra, result: 'pass' }); console.log(JSON.stringify(evidence.at(-1)));
    };
    await go('/login');
    await fill('#login-email', 'qa@example.invalid'); await fill('#login-password', 'wrong'); await button('Entrar');
    await wait("document.querySelector('[role=alert]')");
    assert.equal(await evaluate('return location.pathname'), '/login');
    await fill('#login-password', 'fictitious-only'); await button('Entrar');
    await wait("location.pathname==='/' && document.querySelector('.app-shell')");
    await record('L01', { validAndInvalidLogin: true, authentication: 'API double only' });

    for (const width of [320, 390, 768, 1440]) {
      await command('/window/rect', { width, height: 1000 }); await go('/login'); await wait("document.querySelector('#login-email')");
      // CDP viewport emulation avoids platform window-decoration width differences.
      await command('/goog/cdp/execute', { cmd: 'Emulation.setDeviceMetricsOverride', params: { width, height: 900, deviceScaleFactor: 1, mobile: false } });
      const geometry = await evaluate("return {width:innerWidth,scroll:document.documentElement.scrollWidth,field:document.querySelector('input').getBoundingClientRect().width,columns:getComputedStyle(document.querySelector('.login-shell')).gridTemplateColumns.split(' ').length}");
      assert.equal(geometry.scroll, width); assert.ok(geometry.field >= 230); assert.equal(geometry.columns, width <= 900 ? 1 : 2);
      await click('#login-email');
      await command('/actions', { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE004' }, { type: 'keyUp', value: '\uE004' }] }] });
      assert.equal(await evaluate('return document.activeElement.id'), 'login-password');
      await record('L02', geometry);
    }

    for (const width of [1440, 390]) {
      await command('/goog/cdp/execute', { cmd: 'Emulation.setDeviceMetricsOverride', params: { width, height: 900, deviceScaleFactor: 1, mobile: false } });
      await go('/#/clientes'); await wait("document.querySelectorAll('button.tr.stack-sm').length===2");
      await click('button.tr.stack-sm'); await wait('qa.pending.length===1');
      // On narrow screens the modal occludes the list: close it before selecting B.
      if (width === 390) await button('Fechar');
      await click('button.tr.stack-sm:nth-of-type(2)'); await wait('qa.pending.length===2');
      await evaluate("return qa.release(1,'810002')");
      const detail = width === 390 ? '.modal[open]' : '.customer-detail';
      await wait(`document.querySelector('${detail}')?.innerText.includes('Cadastro fictício 810002')`);
      assert.equal((await evaluate("return qa.release(0,'810001')")).delivered, true);
      assert.equal(await evaluate('return qa.pending[0].signal.aborted'), true);
      assert.ok(await evaluate(`return document.querySelector('${detail}').innerText.includes('Cadastro fictício 810002')`));
      assert.ok(await evaluate(`return !document.querySelector('${detail}').innerText.includes('Cadastro fictício 810001')`));
      await record('C03', { width, staleResponseDiscarded: true });
      await button('Fechar'); await click('button.tr.stack-sm'); await wait('qa.pending.length===3');
      await button('Fechar');
      assert.equal((await evaluate("return qa.release(2,'810001')")).delivered, true);
      assert.equal(await evaluate(`return document.querySelector('${detail}')`), null);
      await click('button.tr.stack-sm'); await wait('qa.pending.length===4');
      await evaluate("return qa.release(3,'810001')");
      await wait(`document.querySelector('${detail}').innerText.includes('Cadastro fictício 810001')`);
      await record('C04', { width, closedResponseDiscarded: true, newRead: true });

      await go('/?holdMe=1#/clientes'); await wait("qa.me && document.querySelector('button.tr.stack-sm')");
      await click('button.tr.stack-sm'); await wait('qa.pending.length===1');
      // Navigation can destroy this document: claim release, not handler/render completion.
      await evaluate("sessionStorage.removeItem('qa-late-s01'); qa.me(); setTimeout(()=>{qa.pending[0].resolve(Response.json(fixtureData['810001'])); sessionStorage.setItem('qa-late-s01','released');},0); return true");
      await wait("location.pathname==='/login'");
      assert.equal(await evaluate("return sessionStorage.getItem('qa-late-s01')"), 'released');
      assert.equal(await evaluate("return document.querySelector('.app-shell')"), null);
      await record('S01', { width, invalidInitialAdmission: true, releasedBeforeNavigation: true, previousDocumentCompletion: 'not asserted' });

      await go('/#/clientes'); await wait("document.querySelector('button.tr.stack-sm')");
      await click('button.tr.stack-sm'); await wait('qa.pending.length===1');
      if (width === 390) await button('Fechar');
      await evaluate('qa.logoutFails=true; return true');
      await click('.user-trigger');
      const logout = await command('/element', { using: 'xpath', value: "//*[@role='menuitem' and contains(.,'Sair')]" });
      await command(`/element/${logout['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
      await wait("document.body.innerText.includes('pode continuar ativa')");
      assert.equal((await evaluate("return qa.release(0,'810001')")).delivered, true);
      assert.equal(await evaluate("return document.querySelector('.app-shell')"), null);
      await evaluate('qa.logoutFails=false; return true'); await button('Tentar sair novamente');
      await wait("location.pathname==='/login'");
      assert.equal(await evaluate("return localStorage.getItem('qa-session')"), null);
      await record('S04', { width, logout503ThenSuccess: true, persistence: 'UI double only' });
      // Restore a fictitious UI session for the next viewport, never a server token.
      await evaluate("localStorage.setItem('qa-session','yes'); return true");
    }
    await runPaymentCases({ command, evaluate, wait, go, click, button, record });
    await runReadmissionCases({ command, evaluate, wait, go, click, button, record });
    assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ result: 'pass', scope: 'real client components + compiled CSS; mocked APIs; NOT persistence E2E or human visual approval', cases: evidence.length }));
  }
} catch (error) { failure = error; throw error; }
finally {
  try {
    if (browser) await browser.close();
    console.log(`UI browser cleanup: ${browser ? 'session/profile closed' : 'not launched'}.`);
  } catch (error) {
    console.error('UI browser cleanup failed.');
    if (!failure) throw error;
  }
  finally {
    await closeServer(); unregisterServer();
    console.log('UI server cleanup: loopback server closed; no database created.');
  }
}
