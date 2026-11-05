import { createHash, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const EXPECTED_MANIFEST = '97a9ec8b31e619eba5de6ac9acf4525ab5002761f2320c5fa45451bf29df4702'; // Public pinned schema digest, not a credential.
const CANCELLED = 'FIRST_ACCESS_CANCELLED';
const uncertain = Object.freeze({ state: 'not-confirmed', retryAllowed: false });
const exactKeys = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const fail = () => { throw new Error('FIRST_ACCESS_REFUSED'); };
export function validateTarget(origin, databaseOid, attempt) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash || !/^[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(url.hostname) ||
      !/^[1-9]\d{0,9}$/.test(databaseOid) || !/^synthetic-init-[a-z0-9-]{8,64}$/.test(attempt)) fail();
}

/** Injected transport/prompts/derivation: no implicit network or secret generation. */
export function createFirstAccessExecutor({ prompt, transport, derive, capability: localCapability, report = () => {} }) {
  let consumed = false;
  return async function run({ origin, databaseOid, attempt }) {
    if (consumed) return { state: 'blocked', retryAllowed: false };
    consumed = true; // A second run cannot repeat even preflight or cancelled work.
    let capability = '', password = '', confirmation = '', material, body, submitted = false;
    try {
      validateTarget(origin, databaseOid, attempt);
      // Operator approval covers the independently verified origin, OID and empty disposable DB.
      if (await prompt('Digite APROVO_ALVO_DESCARTAVEL para confirmar o alvo e a janela aprovados: ') !== 'APROVO_ALVO_DESCARTAVEL') fail();
      capability = localCapability ? localCapability() : await prompt('Capability temporária (oculta): ');
      if (!/^[a-f0-9]{64}$/.test(capability)) fail();
      const headers = { 'x-synthetic-init-capability': capability, origin };
      const statusUrl = new URL(`${origin}/api/demo/initialize`);
      statusUrl.search = new URLSearchParams({ status: '1', databaseOid, attempt }).toString();
      const status = await transport(statusUrl.href, { method: 'GET', headers });
      const observation = status.body;
      if (status.status !== 200 || !exactKeys(observation, ['state','reservationObserved','completionObserved','manifestMatches','retryAllowed','credentialsVerified','targetHostMatches','expectedManifestSha256']) ||
          observation.state !== 'absence-observed' || observation.reservationObserved !== false || observation.completionObserved !== false ||
          observation.manifestMatches !== false || observation.retryAllowed !== false || observation.credentialsVerified !== false ||
          observation.targetHostMatches !== true || observation.expectedManifestSha256 !== EXPECTED_MANIFEST) fail();
      const preflight = await transport(`${origin}/api/demo/initialize`, { method: 'GET', headers });
      const p = preflight.body;
      if (preflight.status !== 200 || !exactKeys(p, ['processId','databaseOid','available','freshManualApprovalRequired','retryAllowed']) ||
          p.available !== true || p.freshManualApprovalRequired !== true || p.retryAllowed !== false || p.databaseOid !== databaseOid ||
          typeof p.processId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(p.processId)) fail();
      password = await prompt('Escolha senha provisória (oculta, mínimo 10 caracteres): ');
      confirmation = await prompt('Repita a senha provisória (oculta): ');
      if (password.length < 10 || password.length > 256 || password !== confirmation) fail();
      material = await derive(password); // Exact Node scrypt string-salt contract.
      password = ''; confirmation = '';
      if (!exactKeys(material, ['hash','salt']) || !/^[a-f0-9]{128}$/.test(material.hash) || !/^[a-f0-9]{32}$/.test(material.salt)) fail();
      if (await prompt('Digite INICIALIZAR_UMA_VEZ para autorizar UM POST, sem retry: ') !== 'INICIALIZAR_UMA_VEZ') fail();
      body = JSON.stringify({ attempt, confirmation: 'CREATE_EMPTY_SYNTHETIC_DATABASE_V1', databaseOid,
        processId: p.processId, hash: material.hash, salt: material.salt });
      report('POST único autorizado. Não repetir em caso de erro.');
      let response;
      submitted = true; // Before awaiting response; every later failure stays uncertain.
      try { response = await transport(`${origin}/api/demo/initialize`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body }); }
      catch { return uncertain; }
      const r = response.body;
      if (response.status !== 201 || !exactKeys(r, ['status','synthetic','retryAllowed','credentialsReturned','delivered']) ||
          r.status !== 'confirmed' || r.synthetic !== true || r.retryAllowed !== false || r.credentialsReturned !== false || r.delivered !== false) return uncertain;
      return { state: 'completion-confirmed', retryAllowed: false };
    } catch { return submitted ? uncertain : { state: 'refused', retryAllowed: false }; }
    finally {
      // Best effort only: JS strings/GC cannot guarantee memory erasure.
      capability = ''; password = ''; confirmation = ''; body = undefined;
      if (material) { try { material.hash = ''; material.salt = ''; } catch { /* immutable injected values: best effort */ } }
    }
  };
}

/** User-local generation only. No raw key in the public result or configuration. */
export function createLocalFirstAccess({ random, now, ...dependencies }) {
  const started = now();
  if (!Number.isFinite(started)) fail();
  const bytes = random(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) fail();
  let token = bytes.toString('hex'); bytes.fill(0);
  const expires = started + 15 * 60 * 1000;
  const configuration = Object.freeze({
    SYNTHETIC_INIT_CAPABILITY_SHA256: createHash('sha256').update(token).digest('hex'),
    SYNTHETIC_INIT_EXPIRES_AT: new Date(expires).toISOString(),
  });
  let used = false;
  const execute = createFirstAccessExecutor({ ...dependencies, transport: async (...args) => {
    if (!Number.isFinite(now()) || now() >= expires) fail();
    return dependencies.transport(...args);
  }, capability: () => {
    if (!token || !Number.isFinite(now()) || now() >= expires) fail();
    return token;
  }});
  return Object.freeze({ configuration, async run(target) {
    if (used) return { state: 'blocked', retryAllowed: false };
    used = true;
    try {
      if (!Number.isFinite(now()) || now() >= expires) return { state: 'expired', retryAllowed: false };
      // Also check immediately before every network operation, especially POST.
      return await execute(target);
    } finally { token = ''; }
  }});
}

/** Bounded response; redirects, credentials/cookies and automatic retries forbidden. */
export function createHttpsTransport(fetcher) {
  return async (url, request) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.pathname !== '/api/demo/initialize' || parsed.hash || parsed.username || parsed.password || parsed.port ||
        !/^[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(parsed.hostname) || !['GET','POST'].includes(request.method)) fail();
    if (parsed.search) {
      if (request.method !== 'GET' || [...parsed.searchParams.keys()].sort().join(',') !== 'attempt,databaseOid,status' || parsed.searchParams.get('status') !== '1') fail();
      validateTarget(parsed.origin, parsed.searchParams.get('databaseOid'), parsed.searchParams.get('attempt'));
    }
    const response = await fetcher(url, { ...request, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(request.method === 'POST' ? 120000 : 20000) });
    if (response.redirected || response.url !== url || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) fail();
    const reader = response.body?.getReader();
    if (!reader) fail();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > 4096) fail();
        chunks.push(Buffer.from(part.value));
      }
      return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } finally { try { await reader.cancel(); } catch { /* no logging of transport errors */ } }
  };
}

/** TTY only, no echo, never reads argv/env/files. All input is hidden. */
export function hiddenPrompt(input, output, signals = process, timeoutMs = 120000) {
  return label => new Promise((resolve, reject) => {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') { reject(new Error(CANCELLED)); return; }
    let value = '', done = false;
    const raw = input.isRaw === true;
    const cleanup = () => {
      clearTimeout(timer); input.removeListener('data', data); input.removeListener('error', cancel); input.removeListener('end', cancel);
      signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel);
      try { input.setRawMode(raw); } catch { /* terminal failure: still reject input */ }
      input.pause(); try { output.write('\n'); } catch { /* never log captured input */ }
    };
    const finish = ok => { if (done) return; done = true; const answer = value; value = ''; cleanup(); if (ok) resolve(answer); else reject(new Error(CANCELLED)); };
    const cancel = () => finish(false);
    const data = chunk => {
      const text = chunk.toString('utf8');
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '\r' || char === '\n') {
          // Reject multiline paste; never carry hidden input into the next prompt.
          if (!['\r','\n','\r\n'].includes(text.slice(i))) finish(false); else finish(true);
          return;
        }
        if (char === '\x7f' || char === '\b') value = [...value].slice(0,-1).join('');
        else if (char.charCodeAt(0) < 32 || char === '\x1b' || value.length >= 256) { cancel(); return; }
        else value += char;
      }
    };
    const timer = setTimeout(cancel, timeoutMs);
    input.on('data', data); input.once('error', cancel); input.once('end', cancel);
    signals.once('SIGINT', cancel); signals.once('SIGTERM', cancel);
    try { input.setEncoding('utf8'); input.setRawMode(true); input.resume(); output.write(label); }
    catch { cancel(); }
  });
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--prepare-local-approved') {
    process.stdout.write('Preparação privada. Execução real exige aprovação separada: node executor.mjs --prepare-local-approved\nNenhum segredo em argumentos ou variáveis de ambiente.\n'); return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.execArgv.length ||
      ['NODE_OPTIONS','NODE_DEBUG','NODE_DEBUG_NATIVE','SSLKEYLOGFILE','NODE_USE_ENV_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'].some(key=>process.env[key])) fail();
  const prompt = hiddenPrompt(process.stdin, process.stdout, process, 15 * 60 * 1000);
  const origin = await prompt('Origem HTTPS onrender.com previamente verificada: ');
  const databaseOid = await prompt('OID do banco descartável previamente aprovado: ');
  const attempt = await prompt('Identificador único da tentativa aprovada (synthetic-init-...): ');
  validateTarget(origin, databaseOid, attempt);
  process.stdout.write(`Alvo a conferir: ${origin}; OID ${databaseOid}; tentativa ${attempt}\n`);
  if (await prompt('Digite PREPARAR_CHAVE_LOCAL para gerar a chave apenas neste processo: ') !== 'PREPARAR_CHAVE_LOCAL') fail();
  const session = createLocalFirstAccess({ random: randomBytes, now: Date.now, prompt, transport: createHttpsTransport(globalThis.fetch),
    derive: async password => { const salt = randomBytes(16).toString('hex'); const derived = await promisify(scrypt)(password, salt, 64); try { return { hash: derived.toString('hex'), salt }; } finally { derived.fill(0); } },
    report: message => process.stdout.write(message + '\n') });
  process.stdout.write('Somente estes verificadores não reversíveis devem ser configurados pelo operador:\n');
  for (const [key, value] of Object.entries(session.configuration)) process.stdout.write(`${key}=${value}\n`);
  process.stdout.write('Mantenha este processo aberto. Não compartilhe senha ou chave; nenhuma foi impressa.\n');
  if (await prompt('Após configuração ativa aprovada, digite CONFIGURACAO_ATIVA: ') !== 'CONFIGURACAO_ATIVA') fail();
  const result = await session.run({ origin, databaseOid, attempt });
  process.stdout.write(result.state === 'completion-confirmed'
    ? 'Conclusão confirmada. Feche/revogue a janela antes de abrir o login e trocar a senha provisória.\n'
    : 'Operação encerrada sem confirmação. NÃO repetir o POST; reconciliar por status autorizado antes de qualquer nova decisão.\n');
  if (result.state !== 'completion-confirmed') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('Execução encerrada sem confirmação. Não repetir escrita.\n'); process.exitCode = 1; });
}
