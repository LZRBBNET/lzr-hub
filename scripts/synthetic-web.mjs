import { installSyntheticEgress } from '../lib/runtime/synthetic-egress.mjs';
// Preparation only. No migration, bootstrap, provisioning or dotenv fallback.
import { pathToFileURL } from 'node:url';
import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { assertSyntheticWeb, assertSyntheticWebDatabase } from '../lib/runtime/synthetic-web.ts';

export async function runSyntheticWeb(command) {
  assertSyntheticWeb(process.env);
  if (command === 'check') return;
  if (command === 'build') {
    const root = new URL('../work/synthetic-web/', import.meta.url);
    // Only this generated directory is replaced; a failed build leaves no old
    // success marker available for the launcher to serve by accident.
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    // A separate Node application root avoids Wrangler target auto-detection.
    // Copy only application source, never hosting identity, dotenv, .git or data.
    await mkdir(new URL('scripts/', root), { recursive: true });
    await mkdir(new URL('services/queue-runtime/src/', root), { recursive: true });
    for (const name of ['app', 'components', 'lib', 'db', 'types', 'public', 'drizzle', 'scripts/prepare-synthetic-initialization.mjs', 'services/queue-runtime/src/promise-hold.mjs', 'proxy.ts', 'tsconfig.json', 'package.json', 'next.config.ts']) {
      await cp(new URL(`../${name}`, import.meta.url), new URL(name, root), { recursive: true,
        filter: path => !path.split('/').some(part => part.startsWith('.env')) });
    }
    try { await symlink(await realpath(new URL('../node_modules', import.meta.url)), new URL('node_modules', root), 'dir'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const [{ createBuilder }, { default: vinext }] = await Promise.all([import('vite'), import('vinext')]);
    // Explicitly omit the old Sites/Cloudflare/D1 config and hosting identity.
    await (await createBuilder({ root: root.pathname, configFile: false,
      define: { __LZR_SYNTHETIC_WEB_BUILD__: 'true' }, plugins: [vinext()] })).buildApp();
    await writeFile(new URL('dist/synthetic-web.json', root), JSON.stringify({ kind: 'isolated-synthetic-node-v1' }));
    return;
  }
  if (command === 'start') {
    assertSyntheticWebDatabase(process.env);
    const port = Number(process.env.PORT ?? '3000');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SYNTHETIC_WEB_PORT_BLOCKED');
    const root = new URL('../work/synthetic-web/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('dist/synthetic-web.json', root), 'utf8'));
    if (manifest.kind !== 'isolated-synthetic-node-v1') throw new Error('SYNTHETIC_WEB_ARTIFACT_BLOCKED');
    installSyntheticEgress(process.env.DATABASE_URL);
    const { startProdServer } = await import('vinext/server/prod-server');
    await startProdServer({ port, host: '0.0.0.0', outDir: new URL('dist', root).pathname });
    return;
  }
  throw new Error('SYNTHETIC_WEB_COMMAND_BLOCKED');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSyntheticWeb(process.argv[2]).catch(() => {
    console.error('SYNTHETIC_WEB_REFUSED: confira configuração e artefato; nenhum retry automático.');
    process.exitCode = 1;
  });
}
