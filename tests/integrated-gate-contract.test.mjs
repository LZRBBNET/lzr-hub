import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../scripts/qa-integrated.mjs',import.meta.url),'utf8');
const runner=await readFile(new URL('../scripts/qa-integrated-runner.sh',import.meta.url),'utf8');
const workflow=await readFile(new URL('../.github/workflows/integrated-gate.yml',import.meta.url),'utf8');
// Guard rails only, not evidence that TLS, browser or DB has run.
test('gate never disables TLS or browser protections',()=>{
 assert.doesNotMatch(source+runner,/--no-sandbox|--disable-setuid-sandbox|--ignore-certificate-errors|rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/);
 assert.match(source,/acceptInsecureCerts:false/);assert.match(source,/'-t','P,,'/);
 assert.match(source,/tls-same-leaf-expired-refused/);
});
test('TLS prerequisite precedes database creation; expiry follows journey',()=>{
 assert.ok(runner.indexOf('phase preflight 90')<runner.indexOf('docker run -d'));
 assert.ok(runner.indexOf('phase journey 210')<runner.indexOf('phase expiry 500'));
 assert.match(source,/restart-request/);assert.match(runner,/docker restart/);
});
test('owned resources cleaned even on failure without operational workflow/secrets',()=>{
 assert.match(runner,/trap 'rc=\$\?; cleanup/);assert.match(runner,/docker volume rm/);
 assert.match(runner,/userdel/);assert.match(runner,/fingerprint/);
 assert.match(workflow,/if: always\(\)/);assert.match(workflow,/runs-on: ubuntu-24.04/);
 assert.doesNotMatch(workflow,/secrets\.|upload-artifact|pull_request_target|contract-audit|workflow_dispatch/);
});
