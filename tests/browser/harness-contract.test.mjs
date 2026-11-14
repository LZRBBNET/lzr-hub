import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { manageProcessGroup } from '../../scripts/qa-lifecycle.mjs';

const source = (await readFile(new URL('./fixtures.mjs', import.meta.url), 'utf8')).replace('export function', 'function');
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
function document(sessionStorage) {
  const listeners = new Map(), frames = [];
  const window = { addEventListener: (kind, listener) => listeners.set(kind, listener) };
  vm.runInNewContext(source + ';installFixtures({a:{customer:{id:"a"}}});', {
    window, location: { origin: 'http://127.0.0.1:1234', search: '' }, sessionStorage,
    localStorage: storage(), URL, Response, setTimeout, requestAnimationFrame: callback => frames.push(callback),
  });
  return { window, frames, listeners };
}

test('UI error ledger survives document replacement including global failures', async () => {
  const shared = storage(), first = document(shared);
  await assert.rejects(first.window.fetch('/api/unexpected'), /QA_UNEXPECTED_API/);
  for (const kind of ['error', 'unhandledrejection', 'securitypolicyviolation']) first.listeners.get(kind)();
  const next = document(shared);
  assert.equal(JSON.stringify(next.window.qa.errors()), JSON.stringify([
    'unexpected-api:/api/unexpected', 'error', 'unhandledrejection', 'securitypolicyviolation',
  ]));
});

test('release does not acknowledge completion before delivery and two render frames', async () => {
  const { window, frames } = document(storage()), controller = new AbortController();
  const response = window.fetch('/api/customers?id=a', { signal: controller.signal });
  controller.abort();
  let completed = false;
  const release = window.qa.release(0, 'a').then(result => { completed = true; return result; });
  assert.equal((await (await response).json()).customer.id, 'a');
  assert.equal(completed, false); assert.equal(frames.length, 1);
  frames.shift()(); assert.equal(completed, false); assert.equal(frames.length, 1);
  frames.shift()();
  const result = await release;
  assert.equal(result.delivered, true); assert.equal(result.aborted, true);
});

test('failed graceful shutdown kills own process group and removes profile, idempotently', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'qa-cleanup-test-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const close = manageProcessGroup(child, profile, async () => { throw Error('EXPECTED_DELETE_FAILURE'); });
  await assert.rejects(close(), /EXPECTED_DELETE_FAILURE/);
  await assert.rejects(close(), /EXPECTED_DELETE_FAILURE/);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(profile), { code: 'ENOENT' });
});

test('SIGTERM performs registered cleanup before exit 143', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'qa-signal-test-'));
  const lifecycleModule = new URL('../../scripts/qa-lifecycle.mjs', import.meta.url).href;
  const code = `import {spawn} from 'node:child_process';import {manageProcessGroup} from ${JSON.stringify(lifecycleModule)};
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    manageProcessGroup(child,${JSON.stringify(profile)},async()=>{});process.send({pid:child.pid});setInterval(()=>{},1000);`;
  const harness = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore','ignore','ignore','ipc'] });
  const exit = once(harness, 'exit');
  const [message] = await once(harness, 'message');
  harness.kill('SIGTERM');
  const [codeValue] = await exit;
  assert.equal(codeValue, 143);
  assert.throws(() => process.kill(message.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(profile), { code: 'ENOENT' });
});
