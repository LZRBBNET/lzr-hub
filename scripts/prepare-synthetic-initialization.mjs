// In-process preparation only: no DB client, URL, credential generation or CLI.
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import manifest from '../lib/platform/synthetic-schema-manifest.json' with { type: 'json' };
import { verifySyntheticSchema, verifySyntheticJournal } from '../lib/platform/synthetic-initialization.ts';

export async function loadSyntheticSchema() {
  verifySyntheticJournal(JSON.parse(await readFile(resolve(process.cwd(),'drizzle/meta/_journal.json'),'utf8')));
  const names = (await readdir(resolve(process.cwd(),'drizzle'))).filter(name=>name.endsWith('.sql')).sort();
  if (JSON.stringify(names) !== JSON.stringify(manifest.map(entry=>entry.name))) throw new Error('SYNTHETIC_SCHEMA_DIRECTORY_DRIFT');
  const files = await Promise.all(manifest.map(async entry => ({
    // Server bundling changes import.meta.url. The supported launcher retains
    // the repository root as cwd; every byte is checked against pinned hashes.
    name: entry.name, sql: await readFile(resolve(process.cwd(),'drizzle',entry.name),'utf8'),
  })));
  verifySyntheticSchema(files);
  return files;
}
