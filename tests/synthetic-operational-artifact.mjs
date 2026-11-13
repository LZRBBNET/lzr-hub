// Real Node launcher smoke, loopback only. No browser, DB, seed or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {once} from 'node:events';
import {stagingDemoRequirements} from '../lib/runtime/staging-demo.ts';
test('RO wrapper disabled launches authenticated service without inspection or first-access', {timeout:30000},async()=>{
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const env={...stagingDemoRequirements,...Object.fromEntries(['FEATURE_N8N_AUTOREPLY','FEATURE_ATTENDANT_REPLY','FEATURE_LLM_INTENT','FEATURE_COPILOT_LLM','FEATURE_TELEGRAM_ALERTS'].map(k=>[k,'false'])),PATH:'/usr/bin:/bin',NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_IXC_FULL_BASE:'false',FEATURE_SYNTHETIC_INVOICES:'true',DEMO_DATASET:'isolated-invoices-v1',SYNTHETIC_WEB_DEMO:'true',SYNTHETIC_DATABASE_CONFIRMATION:'isolated-synthetic-postgres-v1',SYNTHETIC_DEMO_ORIGIN:'https://demo.example.invalid',SYNTHETIC_INIT_ENABLED:'false',SYNTHETIC_BROWSER_SETUP_ENABLED:'false',DATABASE_URL:'postgresql://synthetic:invented@127.0.0.1:1/synthetic',PORT:String(port)};
 const child=spawn(process.execPath,['--experimental-strip-types','scripts/synthetic-inspect-start.mjs'],{env,stdio:['ignore','ignore','ignore']});
 const closed=once(child,'exit');let exited=false;child.once('exit',()=>{exited=true;});
 const request=(path,init)=>fetch(`http://127.0.0.1:${port}${path}`,{...init,redirect:'manual',signal:AbortSignal.timeout(1000)});
 try{
  let ready=false;
  for(let i=0;i<100&&!exited;i++){
   try{const response=await request('/login');await response.arrayBuffer();if(response.status===200){ready=true;break;}}catch{/* Bounded local startup only. */}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(ready,true,'launcher must serve the isolated artifact with its egress guard installed');
  const login=await request('/login');assert.equal(login.status,200);assert.match(await login.text(),/LZR/);
  const business=await request('/api/customers');assert.equal(business.status,401);await business.arrayBuffer();
  const denied=await request('/api/demo/browser-setup',{method:'POST',headers:{origin:'https://other.invalid'}});assert.equal(denied.status,404);await denied.arrayBuffer();
 }finally{
  if(!exited)child.kill('SIGTERM');
  const timer=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},2000);
  await closed;clearTimeout(timer);
 }
});
