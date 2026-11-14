// Uses only the runner's preinstalled Chrome/ChromeDriver and Node built-ins.
// Never fall back to disabling browser sandboxing or changing host security.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

export async function openBrowser() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const profile = await mkdtemp(join(tmpdir(), 'lzr-browser-'));
  const driver = spawn('/usr/bin/chromedriver', [`--port=${port}`, '--allowed-ips=127.0.0.1'], {
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure, session;
  driver.on('error', error => { failure = error; });
  driver.stdout.resume(); driver.stderr.resume();
  const closed = new Promise(resolve => driver.once('close', resolve));
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) throw Error(JSON.stringify(result.value));
    return result.value;
  };
  const close = async () => {
    try { if (session) await request(`/session/${session}`, undefined, 'DELETE'); }
    finally {
      if (driver.exitCode === null && driver.signalCode === null) driver.kill('SIGTERM');
      const timer = setTimeout(() => driver.kill('SIGKILL'), 2000);
      await closed; clearTimeout(timer);
      await rm(profile, { recursive: true, force: true });
    }
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (failure) throw failure;
      try { await request('/status'); ready = true; break; } catch { /* bounded startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'ChromeDriver must be available without installing software');
    const created = await request('/session', { capabilities: { alwaysMatch: {
      browserName: 'chrome', 'goog:chromeOptions': {
        binary: '/usr/bin/google-chrome', args: [
          '--headless=new', '--disable-background-networking', '--no-first-run',
          '--disable-dev-shm-usage', `--user-data-dir=${profile}`,
        ],
      },
    } } });
    session = created.sessionId;
    const command = (path, body, method) => request(`/session/${session}${path}`, body, method);
    const evaluate = (script, args = []) => command('/execute/sync', { script, args });
    await command('/url', { url: 'chrome://sandbox' });
    const sandbox = await evaluate('return document.body.innerText');
    console.log(JSON.stringify({ browser: created.capabilities.browserVersion, sandbox }));
    assert.match(sandbox, /Seccomp-BPF sandbox\s+Yes/i, 'Seccomp must be active');
    assert.match(sandbox, /PID namespaces\s+Yes/i, 'PID namespace sandbox must be active');
    assert.match(sandbox, /Network namespaces\s+Yes/i, 'Network namespace sandbox must be active');
    return { command, evaluate, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await openBrowser();
  await browser.close();
  console.log('Browser sandbox probe passed; profile and driver cleaned up.');
}
