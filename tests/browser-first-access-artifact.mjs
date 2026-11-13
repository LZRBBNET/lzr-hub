// Post-build boundary only. Never call an admitted GET preflight or initialize SQL.
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {stagingDemoRequirements} from '../lib/runtime/staging-demo.ts';
test('compiled boundary: disabled by default, public static page, legacy bypass and unauthenticated POST blocked',async()=>{
 const flags={...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:'https://demo.example.invalid',SYNTHETIC_INIT_ENABLED:'false'};
 const keys=[...Object.keys(flags),'SYNTHETIC_BROWSER_SETUP_ENABLED','SYNTHETIC_INIT_CAPABILITY_SHA256','SYNTHETIC_INIT_EXPIRES_AT','DATABASE_URL'],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
 Object.assign(process.env,flags);for(const k of ['SYNTHETIC_BROWSER_SETUP_ENABLED','SYNTHETIC_INIT_CAPABILITY_SHA256','SYNTHETIC_INIT_EXPIRES_AT','DATABASE_URL'])delete process.env[k];
 const{default:entry}=await import('../work/synthetic-web/dist/server/index.js'),fetch=r=>typeof entry==='function'?entry(r):entry.fetch(r),req=(path,init={})=>new Request(flags.SYNTHETIC_DEMO_ORIGIN+path,init);
 assert.equal((await fetch(req('/first-access'))).status,307);
 assert.equal((await fetch(req('/api/demo/browser-setup'))).status,404);
 process.env.SYNTHETIC_BROWSER_SETUP_ENABLED='true';
 const page=await fetch(req('/first-access'));assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(page.headers.get('cache-control'),/no-store/);assert.equal(page.headers.get('referrer-policy'),'no-referrer');assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
 const html=await page.text();assert.match(html,/script src="\/first-access\/browser.js"/);assert.doesNotMatch(html,/postgres(?:ql)?:\/\/|SYNTHETIC_INIT_CAPABILITY_SHA256=/);
 process.env.SYNTHETIC_INIT_ENABLED='true';const token='a'.repeat(64);process.env.SYNTHETIC_INIT_CAPABILITY_SHA256=createHash('sha256').update(token).digest('hex');process.env.SYNTHETIC_INIT_EXPIRES_AT=new Date(Date.now()+900000).toISOString();
 assert.equal((await fetch(req('/login'))).status,503);
 assert.equal((await fetch(req('/first-access'))).status,200);
 const auth={'x-synthetic-init-capability':token,origin:flags.SYNTHETIC_DEMO_ORIGIN,'x-browser-init-attempt':'synthetic-init-artifact-review'};
 assert.equal((await fetch(req('/api/demo/initialize',{headers:auth}))).status,404,'legacy endpoint cannot bypass browser session');
 assert.equal((await fetch(req('/api/demo/initialize',{method:'POST',headers:auth,body:'{}'}))).status,404);
 assert.equal((await fetch(req('/api/demo/browser-setup'))).status,404);
 assert.equal((await fetch(req('/api/demo/browser-setup',{method:'POST',headers:{...auth,'content-type':'application/json'},body:'{}'}))).status,409,'no session, no DB/hash');
 assert.equal((await fetch(req('/api/demo/browser-setup',{method:'POST',headers:{...auth,origin:'https://attacker.invalid'},body:'{}'}))).status,403);
 }finally{for(const[k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
