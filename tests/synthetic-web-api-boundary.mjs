// Explicit audit of the built Node artifact, not a server or a DB integration.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { stagingDemoRequirements } from '../lib/runtime/staging-demo.ts';

Object.assign(process.env, { ...stagingDemoRequirements,
  ...Object.fromEntries(['FEATURE_N8N_CHANNEL','FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),
  NODE_ENV:'production', FEATURE_AUTH:'true', FEATURE_IXC_FULL_BASE:'false', FEATURE_SYNTHETIC_INVOICES:'true',
  DEMO_DATASET:'isolated-invoices-v1', SYNTHETIC_WEB_DEMO:'true', SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',
  SYNTHETIC_DEMO_ORIGIN:'https://demo.example.invalid' });
const { default: entry } = await import('../work/synthetic-web/dist/server/index.js');
const fetch = request => typeof entry === 'function' ? entry(request) : entry.fetch(request);
const routes = [], root = new URL('../app/api/', import.meta.url);
async function walk(dir, prefix='') {
  for (const item of await readdir(dir, { withFileTypes:true })) {
    if (item.isDirectory()) await walk(new URL(`${item.name}/`,dir),`${prefix}${item.name}/`);
    else if (item.name==='route.ts') {
      const source=await readFile(new URL(item.name,dir),'utf8');
      const methods=[...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map(m=>m[1]||m[2]);
      assert.ok(methods.length,`No declared HTTP method: ${prefix}`);
      for (const method of new Set(methods)) routes.push({ path:`/api/${prefix}`.replace(/\/$/,'').replace(/\[[^\]]+\]/g,'synthetic-id'),method });
    }
  }
}
await walk(root); assert.ok(routes.length>0);
for (const route of routes) {
  const init={ method:route.method, headers:{ origin:process.env.SYNTHETIC_DEMO_ORIGIN } };
  if (!['GET','HEAD'].includes(route.method)) { init.body='{}'; init.headers['content-type']='application/json'; }
  const response=await fetch(new Request(`${process.env.SYNTHETIC_DEMO_ORIGIN}${route.path}`,init));
  const expected=route.path==='/api/auth/me'&&route.method==='GET'?200:route.path==='/api/auth/login'&&route.method==='POST'?400:401;
  assert.equal(response.status,expected,`${route.method} ${route.path}`);
  assert.match(response.headers.get('cache-control'),/no-store/);
  if(expected===200)assert.deepEqual(await response.json(),{authenticated:false,authRequired:true});else await response.text();
  route.status=response.status;
}
await writeFile(new URL('../docs/validation/synthetic-web-api-boundary-20261105.json',import.meta.url),JSON.stringify({
  synthetic:true,serverStarted:false,databaseStarted:false,browser:false,
  source:'declared route.ts HTTP exports; actual Node artifact Request/Response; offline guard required',
  routes:routes.sort((a,b)=>a.path.localeCompare(b.path)||a.method.localeCompare(b.method)) },null,2)+'\n');
console.log(JSON.stringify({checkedMethods:routes.length,checkedRoutes:new Set(routes.map(r=>r.path)).size,unexpectedResponses:0}));
