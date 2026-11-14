// Own-process cleanup only: no host security or unrelated process changes.
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const tasks = new Set();
let terminating = false;
for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  process.on(signal, async () => {
    if (terminating) return;
    terminating = true;
    const results = await Promise.allSettled([...tasks].map(task => Promise.resolve().then(() => task(true))));
    console.error(JSON.stringify({ signal, cleanupFailures: results.filter(r => r.status === 'rejected').length }));
    process.exit(exitCode);
  });
}

export function registerCleanup(task) {
  tasks.add(task);
  return () => tasks.delete(task);
}

export function manageProcessGroup(child, profile, graceful) {
  const stopped = new Promise(resolve => child.once('close', resolve));
  let closing;
  const kill = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const close = force => {
    // A signal must interrupt an in-flight graceful shutdown too.
    if (force) kill('SIGKILL');
    closing ??= (async () => {
      let gracefulError;
      try { if (!force) await graceful(); }
      catch (error) { gracefulError = error; }
      finally {
        try {
          kill('SIGTERM');
          await Promise.race([stopped, delay(1000)]);
          kill('SIGKILL'); // includes orphaned Chrome descendants in our group
          await Promise.race([stopped, delay(1000).then(() => { throw Error('QA_PROCESS_CLEANUP_TIMEOUT'); })]);
        } finally { await rm(profile, { recursive: true, force: true }); unregister(); }
      }
      if (gracefulError) throw gracefulError;
    })();
    return closing;
  };
  const unregister = registerCleanup(close);
  return close;
}
