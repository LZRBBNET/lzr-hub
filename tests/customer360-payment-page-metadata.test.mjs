import test from 'node:test';
import assert from 'node:assert/strict';
import {IxcReadonlyProvider} from '../lib/integrations/ixc/readonly-provider.ts';
function fixture(patch){const calls=[],traces=[];return{calls,traces,provider:new IxcReadonlyProvider({baseUrl:'https://synthetic.example.invalid',token:'synthetic-not-a-credential',allowedCustomerIds:['10'],retryLimit:0,rateLimitPerMinute:1000,trace:t=>traces.push(t),fetcher:async(url,init)=>{const resource=new URL(url).pathname.split('/').at(-1);calls.push(resource);assert.equal(new Headers(init.headers).get('ixcsoft'),'listar');assert.equal(resource==='fn_areceber'||resource==='fn_movim_finan',true);return Response.json(resource==='fn_areceber'?{registros:[{id:'99',id_cliente:'10'}],total:1,page:1}:{registros:[{id:'9',id_receber:'99',valor:'12.50'}],page:1,...patch});}})};}
for(const total of [0,-1,1.5,true,[],{},'1e0','SECRET_METADATA_CANARY',9007199254740992])test(`explicit malformed/contradictory total is refused: ${JSON.stringify(total)}`,async()=>{const f=fixture({total});await assert.rejects(f.provider.getInvoicePaymentPage('10','99',1,'fixture'),/IXC_PAYMENT_TOTAL_INVALID/);assert.equal(f.calls.length,2);assert.doesNotMatch(JSON.stringify(f.traces),/SECRET_METADATA_CANARY|synthetic-not-a-credential|id_receber|valor/);});
for(const page of [[1],{toString:'1'},true,1.5])test(`page identity cannot be established by coercion: ${JSON.stringify(page)}`,async()=>{const f=fixture({page,total:1});await assert.rejects(f.provider.getInvoicePaymentPage('10','99',1,'fixture'),/IXC_PAYMENT_PAGE_MISMATCH/);});
for(const total of [undefined,null,1,'1'])test(`absent total remains unknown; valid scalar total remains known: ${String(total)}`,async()=>{const f=fixture({total});const result=await f.provider.getInvoicePaymentPage('10','99',1,'fixture');assert.equal(result.total,total==null?null:1);assert.equal(result.hasMore,total==null?null:false);assert.equal(result.items[0].value,12.5);assert.equal('paid' in result,false);assert.equal(f.calls.length,3);});
test('empty complete history does not invent paid status',async()=>{const f=fixture({registros:[],total:0});const result=await f.provider.getInvoicePaymentPage('10','99',1,'fixture');assert.deepEqual(result.items,[]);assert.equal(result.total,0);assert.equal('paid' in result,false);});

test('real payments route with malformed provider metadata returns private generic failure',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {transformSync}=await import('esbuild');
  const source=await readFile(new URL('../app/api/customers/payments/route.ts',import.meta.url),'utf8');
  const f=fixture({total:'SECRET_METADATA_CANARY'}),compiled={exports:{}};
  new Function('require','module','exports',transformSync(source,{loader:'ts',format:'cjs'}).code)(name=>{
    if(name==='next/server')return {NextResponse:{json:(data,init)=>Response.json(data,init)}};
    if(name==='node:crypto')return {randomUUID:()=> 'synthetic-correlation'};
    if(name.includes('session-guard'))return {authorize:async()=>({allowed:true,user:{id:'synthetic-reviewer'}})};
    if(name.includes('/runtime'))return {getIxcRuntime:()=>({provider:f.provider})};
    if(name.includes('audit-log'))return {logUnauthenticatedAction:async()=>assert.fail('invalid page cannot be audited as success')};
    throw Error('Unexpected dependency');
  },compiled,compiled.exports);
  const response=await compiled.exports.GET(new Request('https://demo.example.invalid/api/customers/payments?id=10&invoiceId=99&page=1'));
  assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.doesNotMatch(await response.text(),/SECRET_METADATA_CANARY|IXC_PAYMENT_TOTAL_INVALID|synthetic-reviewer|items/);
});
