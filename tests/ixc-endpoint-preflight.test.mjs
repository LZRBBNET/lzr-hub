import test from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntimeConfig} from '../lib/runtime/environment.ts';
const config=url=>({LZR_ENV:'staging',IXC_MODE:'staging-readonly',IXC_BASE_URL:url,IXC_API_TOKEN:'SYNTHETIC_TOKEN_CANARY',IXC_ALLOWED_CUSTOMER_IDS:'10',IXC_WRITE_ENABLED:'false'});
for(const url of ['http://localhost:3000','http://ixc.example.invalid','ftp://ixc.example.invalid','not-a-url','https:///ixc.example.invalid','https:////ixc.example.invalid','https://@ixc.example.invalid','https://USER_CANARY:PASS_CANARY@ixc.example.invalid','https://ixc.example.invalid?key=QUERY_CANARY','https://ixc.example.invalid#FRAGMENT_CANARY',' https://ixc.example.invalid','https://ixc.example.invalid\n','https:\\ixc.example.invalid','https:/ixc.example.invalid'])test('invalid endpoint fails closed without reflecting configuration: '+JSON.stringify(url),()=>{
 assert.throws(()=>loadRuntimeConfig(config(url)),error=>{assert.equal(error.message,'IXC_BASE_URL_INVALID');assert.doesNotMatch(String(error),/CANARY|example\.invalid/);return true;});
});
for(const url of ['https://ixc.example.invalid','https://ixc.example.invalid/','https://ixc.example.invalid:8443/bridge','HTTPS://ixc.example.invalid'])test('explicit HTTPS endpoint preserved: '+url,()=>{const result=loadRuntimeConfig(config(url));assert.equal(result.ixcBaseUrl,url);assert.equal(result.writeEnabled,false);assert.deepEqual(result.ixcAllowlist,['10']);});
test('disabled/mock modes do not validate or activate an unused endpoint',()=>{for(const IXC_MODE of ['disabled','mock'])assert.equal(loadRuntimeConfig({...config('unused'),IXC_MODE}).ixcMode,IXC_MODE);});

test('runtime composition rejects insecure configuration before creating provider or transport',async()=>{
 const {readFile}=await import('node:fs/promises');const {transformSync}=await import('esbuild');
 const source=transformSync(await readFile(new URL('../lib/integrations/ixc/runtime.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code;
 for(const endpoint of ['http://localhost:3000','http://ixc.example.invalid','https://USER_CANARY:PASS_CANARY@ixc.example.invalid']){
  const compiled={exports:{}};let transports=0,providers=0,traces=0;
  new Function('require','module','exports','process',source)(name=>{
   if(name.includes('synthetic-demo'))return {getSyntheticInvoiceDemo:()=>assert.fail('no synthetic fallback')};
   if(name.includes('environment'))return {loadRuntimeConfig:()=>loadRuntimeConfig(config(endpoint))};
   if(name.includes('telemetry'))return {recordTelemetry:()=>traces++};
   if(name.includes('./http'))return {resolveIxcHttpMethod:()=> 'POST',createIxcFetcher:()=>{transports++;return ()=>assert.fail('no network');}};
   if(name.includes('readonly-provider'))return {IxcReadonlyProvider:class{constructor(){providers++;}}};
   throw Error('Unexpected dependency');
  },compiled,compiled.exports,{env:{}});
  assert.throws(()=>compiled.exports.getIxcRuntime(),/IXC_BASE_URL_INVALID/);
  assert.deepEqual([transports,providers,traces],[0,0,0]);
 }
});
