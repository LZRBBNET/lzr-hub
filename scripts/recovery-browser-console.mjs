// TEST ONLY. Authenticated Railway Console handoff; never a public signup endpoint.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertNoAmbientPostgresEnvironment, RailwayGateRefusal, validateRailwayRecoveryTarget } from './railway-recovery-gate-target.mjs';
import { browserInputs, startRecoveryBrowserRailway } from './start-recovery-browser-railway.mjs';

const WAIT_MS = 15 * 60 * 1000;
const refuse = () => { throw new RailwayGateRefusal('NOT RUN: private console setup unavailable, expired or already used. Inspect the test container; no automatic retry.'); };
const keys = ['RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH', 'RECOVERY_BROWSER_OPERATOR_PASSWORD_SALT', 'RECOVERY_BROWSER_READER_PASSWORD_HASH', 'RECOVERY_BROWSER_READER_PASSWORD_SALT'];
const uid = () => process.getuid?.();

export function consoleTarget(env, now = new Date()) {
  const target = validateRailwayRecoveryTarget(env, now);
  if (env.RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED !== `${target.environmentId}:${target.databaseServiceId}:${target.nonce}`
      || !/^\d+$/.test(env.PORT ?? '') || Number(env.PORT) < 1024 || Number(env.PORT) > 65535
      || Object.keys(env).some(key => key.startsWith('RECOVERY_BROWSER_') && key !== 'RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED')) refuse();
  return target;
}

export function consoleDirectory(target) { return `/tmp/lzr-recovery-browser-console-${target.nonce}`; }

async function privateDirectory(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o777) !== 0o700) refuse();
}

async function privateRead(directory, name) {
  await privateDirectory(directory);
  const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid() || (stat.mode & 0o777) !== 0o600 || stat.size > 2048) refuse();
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function privateWrite(directory, name, value) {
  await privateDirectory(directory);
  const handle = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(value, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

async function exists(directory, name) {
  try { await lstat(join(directory, name)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function removeCredentials(directory) {
  // Unlink only our two known files; no recursive deletion and no following links.
  await privateDirectory(directory);
  await unlink(join(directory, 'credentials.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await unlink(join(directory, 'committed')).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

export async function prepareConsole(directory, target, now = new Date()) {
  await mkdir(directory, { mode: 0o700 }); // Existing directories refuse, including old attempts.
  const ready = { version: 1, environmentId: target.environmentId, runnerServiceId: target.runnerServiceId, sourceCommit: target.sourceCommit,
    nonce: target.nonce, deadline: Math.min(now.getTime() + WAIT_MS, Date.parse(target.expiresAt) - 60000) };
  if (ready.deadline <= now.getTime()) refuse();
  await privateWrite(directory, 'ready.json', JSON.stringify(ready));
}

async function readReady(directory, target, now = new Date()) {
  const ready = JSON.parse(await privateRead(directory, 'ready.json'));
  if (Object.keys(ready).sort().join(',') !== 'deadline,environmentId,nonce,runnerServiceId,sourceCommit,version'
      || ready.version !== 1 || ready.environmentId !== target.environmentId || ready.runnerServiceId !== target.runnerServiceId
      || ready.sourceCommit !== target.sourceCommit || ready.nonce !== target.nonce || !Number.isSafeInteger(ready.deadline)
      || ready.deadline <= now.getTime() || ready.deadline > now.getTime() + WAIT_MS
      || ready.deadline > Date.parse(target.expiresAt) - 60000
      || await exists(directory, 'finished-consumed') || await exists(directory, 'finished-stopped')) refuse();
  return ready;
}

export function readMaskedPassword(input, output, label, { deadline, signal, sessionRaw = false } = {}) {
  if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== 'function' || (input.isRaw === true) !== sessionRaw) refuse();
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(128); let length = 0, settled = false, timer;
    const finish = (error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); input.removeListener('data', onData); input.removeListener('end', onEnd); input.removeListener('error', onEnd);
      signal?.removeEventListener('abort', onEnd);
      let result;
      try { if (!sessionRaw) input.setRawMode(false); input.pause(); output.write('\n'); if (!error) result = Buffer.from(bytes.subarray(0, length)); }
      catch { error = new Error('Private terminal unavailable.'); }
      bytes.fill(0);
      if (error) reject(new Error('Private input cancelled or invalid.')); else resolve(result);
    };
    const onEnd = () => finish(new Error('Private input cancelled.'));
    const onData = chunk => {
      if (!Buffer.isBuffer(chunk)) { onEnd(); return; }
      try {
        for (let index = 0; index < chunk.length; index++) {
          const byte = chunk[index];
          if (byte === 13 || byte === 10) {
            const trailing = chunk.length - index - 1;
            if (trailing > 0 && !(byte === 13 && trailing === 1 && chunk[index + 1] === 10)) { onEnd(); return; }
            finish(length >= 16 ? undefined : new Error('Invalid length.')); return;
          }
          if (byte === 127 || byte === 8) { if (length) bytes[--length] = 0; continue; }
          // Reject escape/control/non-ASCII input rather than interpreting terminal sequences.
          if (byte < 32 || byte > 126 || length >= bytes.length) { onEnd(); return; }
          bytes[length++] = byte;
        }
      } finally { chunk.fill(0); }
    };
    try {
      if (!sessionRaw) input.setRawMode(true); // No prompt or input listener before echo is disabled.
      output.write(`${label} (16–128 caracteres ASCII; entrada oculta): `);
      input.on('data', onData); input.once('end', onEnd); input.once('error', onEnd); signal?.addEventListener('abort', onEnd, { once: true });
      timer = setTimeout(onEnd, Math.max(0, Math.min(WAIT_MS, deadline - Date.now())));
      input.resume(); if (signal?.aborted || !Number.isFinite(deadline) || deadline <= Date.now()) onEnd();
    } catch { onEnd(); }
  });
}

export function deriveConsoleCredentials(operator, reader) {
  if (!Buffer.isBuffer(operator) || !Buffer.isBuffer(reader) || operator.length < 16 || reader.length < 16
      || operator.length > 128 || reader.length > 128 || !operator.every(byte => byte >= 32 && byte <= 126)
      || !reader.every(byte => byte >= 32 && byte <= 126) || (operator.length === reader.length && timingSafeEqual(operator, reader))) refuse();
  const operatorSalt = randomBytes(16).toString('hex'), readerSalt = randomBytes(16).toString('hex');
  return Object.fromEntries(keys.map((key, index) => [key, index % 2 ? (index === 1 ? operatorSalt : readerSalt)
    : scryptSync(index === 0 ? operator : reader, index === 0 ? operatorSalt : readerSalt, 64).toString('hex')]));
}

export async function provisionConsole(directory, target, input = process.stdin, output = process.stdout, signal) {
  const ready = await readReady(directory, target);
  // Never fall back to an echoing stream, argv, environment, browser DOM or log.
  if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== 'function' || input.isRaw === true) refuse();
  await privateWrite(directory, 'claim', 'single private console handoff');
  const buffers = []; let raw = false;
  try {
    input.setRawMode(true); raw = true; // No echo between fields, including asynchronous file/hash work.
    const ask = async label => { const value = await readMaskedPassword(input, output, label, { deadline: ready.deadline, signal, sessionRaw: true }); buffers.push(value); return value; };
    const operator = await ask('Senha temporária de Cobrança');
    const operatorConfirmation = await ask('Confirme a senha de Cobrança');
    if (operator.length !== operatorConfirmation.length || !timingSafeEqual(operator, operatorConfirmation)) refuse();
    const reader = await ask('Senha temporária de consulta');
    const readerConfirmation = await ask('Confirme a senha de consulta');
    if (reader.length !== readerConfirmation.length || !timingSafeEqual(reader, readerConfirmation)) refuse();
    const credentials = deriveConsoleCredentials(operator, reader);
    await readReady(directory, target);
    if (signal?.aborted) refuse();
    await privateWrite(directory, 'credentials.json', JSON.stringify(credentials));
    if (signal?.aborted) refuse();
    // Empty marker publication is atomic at O_EXCL creation; the verifier is already fsynced.
    await privateWrite(directory, 'committed', '');
    if (signal?.aborted) refuse();
    // A timeout/stop can race the two writes. Never leave a late credential file behind.
    if (await exists(directory, 'finished-stopped')) {
      await removeCredentials(directory); refuse();
    } else if (await exists(directory, 'finished-consumed')) {
      if (await privateRead(directory, 'finished-consumed') !== '') refuse();
      await removeCredentials(directory);
    } else if (Date.now() >= ready.deadline) refuse();
    output.write('Credenciais temporárias entregues ao runner. Nenhuma senha foi gravada ou exibida. O login será feito no formulário real do app.\n');
  } catch {
    await privateWrite(directory, 'aborted', 'private handoff aborted').catch(() => {});
    await removeCredentials(directory);
    refuse();
  } finally {
    for (const value of buffers) value.fill(0);
    if (raw) {
      // Discard already-buffered input before returning control to the shell.
      input.pause(); let pending; while ((pending = input.read?.()) != null) if (Buffer.isBuffer(pending)) pending.fill(0);
      input.setRawMode(false);
      input.pause(); // read() can resume the underlying TTY; let the provision CLI exit.
      input.unref?.(); // TTY ReadStream inherits net.Socket; no further input is needed.
    }
  }
}

export async function consumeConsole(directory, env, signal) {
  const target = consoleTarget(env);
  let consumed = false;
  try {
    while (true) {
      await readReady(directory, target);
      if (signal?.aborted || await exists(directory, 'aborted')) refuse();
      if (await exists(directory, 'committed')) {
        if (await privateRead(directory, 'committed') !== '') refuse();
        const credentials = JSON.parse(await privateRead(directory, 'credentials.json'));
        if (Object.keys(credentials).sort().join(',') !== [...keys].sort().join(',')) refuse();
        const merged = { ...env, ...credentials };
        browserInputs(merged); // Revalidate all current identity/time/seed inputs and both digests.
        if (signal?.aborted) refuse();
        consumed = true;
        return merged;
      }
      await sleep(200, undefined, { signal });
    }
  } finally {
    if (!await exists(directory, 'finished-consumed') && !await exists(directory, 'finished-stopped')) {
      await privateWrite(directory, consumed ? 'finished-consumed' : 'finished-stopped', '').catch(() => {});
    }
    await removeCredentials(directory);
    if (signal?.aborted) refuse();
  }
}

export async function runConsole(mode, env = process.env) {
  assertNoAmbientPostgresEnvironment(process.env);
  if (!['wait', 'provision'].includes(mode)) refuse();
  const target = consoleTarget(env), directory = consoleDirectory(target);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('SIGHUP', stop);
  let appEnv;
  try {
    if (mode === 'provision') return await provisionConsole(directory, target, process.stdin, process.stdout, controller.signal);
    await prepareConsole(directory, target);
    console.log('WAITING: private Railway Console handoff, maximum 15 minutes. No DB connection, users, HTTP listener or login bypass started.');
    appEnv = await consumeConsole(directory, env, controller.signal);
    if (controller.signal.aborted) refuse();
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); process.removeListener('SIGHUP', stop); }
  // Passwords were never retained by this process. Hash file is removed BEFORE any DB work.
  // The unchanged entrypoint executes its real empty-DB gate, then real auth and synthetic data.
  await startRecoveryBrowserRailway(appEnv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) { console.error('Use exactly: recovery-browser-console.mjs wait|provision. Never pass credentials.'); process.exitCode = 1; }
  else runConsole(process.argv[2]).catch(() => { console.error('NOT RUN or stopped: private test setup refused. No credential values logged; inspect the isolated container before any retry.'); process.exitCode = 1; });
}
