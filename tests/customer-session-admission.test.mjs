import test from 'node:test';import assert from 'node:assert/strict';import {createCustomerSessionAdmission}from'../lib/platform/customer-session-admission.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((y,n)=>{resolve=y;reject=n});return{promise,resolve,reject};};
const valid=(id='synthetic-old')=>({authenticated:true,authRequired:true,user:{id,name:'Operador fictício',email:'actor@example.invalid',role:'Supervisor'},permissions:['customer.read']});
function fixture(){const calls=[],navigations=[];const admission=createCustomerSessionAdmission({fetchSession:signal=>{const d=deferred();calls.push({...d,signal});return d.promise;},onInvalid:()=>navigations.push('/login')});return{admission,calls,navigations};}
async function admitted(){const f=fixture(),started=f.admission.start();f.calls[0].resolve(Response.json(valid()));await started;return f;}

test('concurrent current401 revalidations deduplicate; old generation never blocks a legitimate future one',async()=>{
 const {admission:a,calls}=await admitted();const generation=a.snapshot().generation,context=a.snapshot().context;
 const first=a.revalidate(generation),second=a.revalidate(generation);assert.equal(first,second);assert.equal(calls.length,2);
 calls[1].resolve(Response.json(valid()));await first;assert.equal(a.snapshot().context,context);assert.equal(a.current(generation),false);
 await a.revalidate(generation);assert.equal(calls.length,2);const next=a.revalidate(a.snapshot().generation);assert.equal(calls.length,3);calls[2].resolve(Response.json(valid()));await next;a.stop();
});
test('different confirmed actor rotates protected context before accepting new reads',async()=>{
 const{admission:a,calls,navigations}=await admitted();const old=a.snapshot(),p=a.revalidate(old.generation);calls[1].resolve(Response.json(valid('synthetic-new')));await p;
 assert.equal(a.current(old.generation),false);assert.equal(a.snapshot().session.user.id,'synthetic-new');assert.equal(a.snapshot().context,old.context+1);assert.deepEqual(navigations,[]);a.stop();
});
test('accepted permission change also rotates context without granting permissions locally',async()=>{
 const{admission:a,calls}=await admitted();const old=a.snapshot(),p=a.revalidate(old.generation);calls[1].resolve(Response.json({...valid(),permissions:[]}));await p;assert.equal(a.snapshot().context,old.context+1);assert.deepEqual(a.snapshot().session.permissions,[]);a.stop();
});
for(const kind of ['503','network','bad-json','missing-actor','malformed-actor'])test('readmission '+kind+' is uncertainty, never confirmed revocation',async()=>{
 const{admission:a,calls,navigations}=await admitted();const p=a.revalidate(a.snapshot().generation);
 if(kind==='network')calls[1].reject(Error('SYNTHETIC_PRIVATE_TRANSPORT'));else if(kind==='bad-json')calls[1].resolve(new Response('SYNTHETIC_BAD_JSON'));else calls[1].resolve(Response.json(kind==='missing-actor'?{authenticated:true,authRequired:true}:kind==='malformed-actor'?{...valid(),user:{...valid().user,name:null}}:{},{status:kind==='503'?503:200}));
 await p;assert.equal(a.snapshot().session.unavailable,true);assert.deepEqual(navigations,[]);assert.equal(calls.length,2);a.stop();
});
test('invalid current admission navigates but makes no claim of revoking every server session',async()=>{
 const{admission:a,calls,navigations}=await admitted();const p=a.revalidate(a.snapshot().generation);calls[1].resolve(Response.json({authenticated:false,authRequired:true}));await p;assert.equal(a.snapshot().session.authenticated,false);assert.equal(a.snapshot().session.unavailable,undefined);assert.deepEqual(navigations,['/login']);a.stop();
});
test('logout closes original and JSON-pending readmission generations, without inferring logout success',async()=>{
 const{admission:a,calls,navigations}=await admitted();const old=a.snapshot().generation,p=a.revalidate(old),body=deferred();calls[1].resolve({ok:true,json:()=>body.promise});await Promise.resolve();await Promise.resolve();a.close();assert.equal(calls[1].signal.aborted,true);
 body.resolve({authenticated:false,authRequired:true});await p;assert.equal(a.current(old),false);assert.equal(a.snapshot().session.authenticated,true);assert.deepEqual(navigations,[]);await a.revalidate(a.snapshot().generation);assert.equal(calls.length,2);a.stop();
});
test('effect cleanup/start permits fresh admission and ignores earlier JSON after restart',async()=>{
 const{admission:a,calls,navigations}=fixture();const first=a.start(),body=deferred();calls[0].resolve({ok:true,json:()=>body.promise});await Promise.resolve();await Promise.resolve();a.stop();const fresh=a.start();calls[1].resolve(Response.json(valid('synthetic-new')));await fresh;
 body.resolve({authenticated:false,authRequired:true});await first;assert.equal(a.snapshot().session.user.id,'synthetic-new');assert.deepEqual(navigations,[]);a.stop();
});
