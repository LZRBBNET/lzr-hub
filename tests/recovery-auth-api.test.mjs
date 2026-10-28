import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PROJECT_ID, PROTECTED_ID_TEST_SENTINEL } from '../scripts/railway-recovery-gate-target.mjs';
import { ApiGateFailure, apiFailureMessage, apiTarget, generateApiCredentials, apiChildEnvironment, childPhaseReader, attachApiChildStreams, createApiClient, exerciseAuthenticatedApi, stopApiChild } from '../scripts/test-recovery-auth-api-railway.mjs';
import { MemoryAuthRepository, login, resolveSession, logout, verifyPassword } from '../lib/platform/auth.ts';
import { can } from '../lib/platform/rbac.ts';
import { MemoryRecoveryCasesRepository } from '../lib/platform/recovery-cases-repository.ts';
import { createRecoveryCasesHandlers } from '../lib/platform/recovery-cases-service.ts';
import { MemoryPaymentPromiseRepository, createVerifiedPaymentPromise, reconcilePaymentPromises, PaymentPromiseValidationError } from '../lib/platform/payment-promise-service.ts';
import { IxcReadonlyProvider } from '../lib/integrations/ixc/readonly-provider.ts';
import { browserFixtureData, FIXTURE_ATTENDANCES, FIXTURE_CUSTOMERS, FIXTURE_TOKEN, syntheticIxcResponse } from '../scripts/recovery-browser-fixture.mjs';

function environment(at = Date.now()) {
  const m = { version:1, projectId:PROJECT_ID, environmentId:'10000000-0000-0000-0000-000000000001', environmentName:'lzr-qa-api-fixture', runnerServiceId:'10000000-0000-0000-0000-000000000002', databaseServiceId:'10000000-0000-0000-0000-000000000003', databaseVolumeId:'10000000-0000-0000-0000-000000000004', databaseHost:'lzr-qa-db-fixture.railway.internal', databasePort:5432, databaseName:'lzr_recovery_test_1234567890abcdef12345678', databaseUser:'postgres', sourceCommit:'a'.repeat(40), branch:'test/recovery-gate', nonce:'1234567890abcdef12345678', approvedAt:new Date(at-60000).toISOString(), expiresAt:new Date(at+3600000).toISOString(), maxAdditionalUsd:5, approvalReference:'approved-synthetic-fixture' };
  const ack = `${m.environmentId}:${m.databaseServiceId}:${m.nonce}`;
  return { RECOVERY_CASE_RAILWAY_TARGET_JSON:JSON.stringify(m), RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL:`postgres://postgres:synthetic-test-only@${m.databaseHost}:5432/${m.databaseName}`, RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION:ack, RAILWAY_PROJECT_ID:m.projectId, RAILWAY_ENVIRONMENT_ID:m.environmentId, RAILWAY_ENVIRONMENT_NAME:m.environmentName, RAILWAY_SERVICE_ID:m.runnerServiceId, RAILWAY_GIT_COMMIT_SHA:m.sourceCommit, RAILWAY_GIT_BRANCH:m.branch, RAILWAY_GIT_REPO_OWNER:'LZRBBNET', RAILWAY_GIT_REPO_NAME:'lzr-hub', RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED:ack, RECOVERY_API_ALLOW_SYNTHETIC_CHECKS:ack, PORT:'3000' };
}
const category = expected => error => error instanceof ApiGateFailure && error.category === expected;
const secretFree = (message, values) => values.every(value => !message.includes(value));
const erase = accounts => { for (const account of accounts) { account.password = ''; account.hash = ''; account.salt = ''; } };

test('API preflight preserves genuine target, separate ACK, production denylist and bounded deadline', () => {
  const now = Date.now(), env = environment(now), result = apiTarget(env,new Date(now));
  assert.equal(result.port,3000); assert.equal(result.deadline,now+5*60000);
  for (const change of [{ RECOVERY_API_ALLOW_SYNTHETIC_CHECKS:'yes' }, { RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED:'yes' }, { RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION:'yes' }, { RAILWAY_ENVIRONMENT_ID:PROTECTED_ID_TEST_SENTINEL }, { RAILWAY_GIT_COMMIT_SHA:'b'.repeat(40) }, { FEATURE_AUTH:'true' }, { DATABASE_URL:'not-used' }, { PGOPTIONS:'not-used' }, { NODE_OPTIONS:'--inspect' }, { NODE_PATH:'/synthetic/path' }, { LD_PRELOAD:'/synthetic/library' }]) {
    assert.throws(()=>apiTarget({...env,...change},new Date(now)),category('TARGET_REFUSED'));
  }
  assert.throws(()=>apiTarget(env,new Date(now+7200000)),category('TARGET_REFUSED'));
  const m=JSON.parse(env.RECOVERY_CASE_RAILWAY_TARGET_JSON);m.expiresAt=new Date(now+120000).toISOString();
  const short=apiTarget({...env,RECOVERY_CASE_RAILWAY_TARGET_JSON:JSON.stringify(m)},new Date(now));
  assert.equal(short.deadline,now+100000,'reserves cleanup time inside original approval');
});

test('API preflight rejects every incoming browser verifier or unknown API/browser variable', () => {
  for (const name of ['RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH','RECOVERY_BROWSER_OPERATOR_PASSWORD_SALT','RECOVERY_BROWSER_READER_PASSWORD_HASH','RECOVERY_BROWSER_READER_PASSWORD_SALT','RECOVERY_BROWSER_OPERATOR_PASSWORD','RECOVERY_BROWSER_EXTRA','RECOVERY_API_PASSWORD','RECOVERY_API_URL','RECOVERY_API_EXTRA']) {
    assert.throws(()=>apiTarget({...environment(),[name]:'synthetic-not-accepted'}),category('TARGET_REFUSED'));
    assert.throws(()=>apiTarget({...environment(),[name]:''}),category('TARGET_REFUSED'),'presence itself is refused');
  }
  for (const PORT of ['80','0','65536','3000bad','3e3','3000.5','']) assert.throws(()=>apiTarget({...environment(),PORT}),category('TARGET_REFUSED'));
});

test('cryptographic synthetic credentials are independent and compatible with actual product verification', async () => {
  const accounts=generateApiCredentials(), again=generateApiCredentials();
  try {
    assert.equal(accounts.length,2);
    for (const [i, account] of accounts.entries()) {
      assert.equal(/^[A-Za-z0-9_-]{43}$/.test(account.password),true);
      assert.equal(/^[a-f0-9]{128}$/.test(account.hash),true);
      assert.equal(/^[a-f0-9]{32}$/.test(account.salt),true);
      assert.equal(await verifyPassword(account.password,account.hash,account.salt),true);
      assert.equal(await verifyPassword(accounts[1-i].password,account.hash,account.salt),false);
      assert.equal(account.password !== again[i].password,true);
      assert.equal(account.salt !== accounts[1-i].salt,true);
      assert.equal(account.hash !== accounts[1-i].hash,true);
    }
  } finally {erase(accounts);erase(again);}
});

test('child environment receives only generated verifiers, not plaintext; caller environment stays unchanged', () => {
  const env={...environment(),HTTP_PROXY:'http://proxy.fixture.invalid',OTHER_SERVICE_TOKEN:'SYNTHETIC-NOT-FOR-CHILD'}, before=JSON.stringify(env), accounts=generateApiCredentials();
  try {
    const child=apiChildEnvironment(env,accounts);
    assert.equal(JSON.stringify(env),before);
    assert.equal('RECOVERY_API_ALLOW_SYNTHETIC_CHECKS' in child,false);
    assert.equal('HTTP_PROXY' in child,false);assert.equal('OTHER_SERVICE_TOKEN' in child,false);
    assert.equal(Object.values(child).every(value=>accounts.every(account=>!String(value).includes(account.password))),true);
    for (const [i,name] of ['OPERATOR','READER'].entries()) {
      assert.equal(child[`RECOVERY_BROWSER_${name}_PASSWORD_HASH`]===accounts[i].hash,true);
      assert.equal(child[`RECOVERY_BROWSER_${name}_PASSWORD_SALT`]===accounts[i].salt,true);
    }
    assert.throws(()=>apiChildEnvironment(env,[accounts[0],accounts[0]]),category('TARGET_REFUSED'));
    assert.throws(()=>apiChildEnvironment(env,[]),category('TARGET_REFUSED'));
  } finally {erase(accounts);}
});

test('failure diagnostics expose fixed categories only, even after a forged property mutation', () => {
  const sentinel='SYNTHETIC-DIAGNOSTIC-MUST-NOT-LEAK';
  assert.equal(secretFree(apiFailureMessage(new Error(sentinel)),[sentinel]),true);
  const error=new ApiGateFailure(sentinel);
  assert.equal(secretFree(apiFailureMessage(error),[sentinel]),true);
  error.category=sentinel;
  assert.equal(secretFree(apiFailureMessage(error),[sentinel]),true);
});

test('auth diagnostics retain only a fixed stage and validated numeric HTTP status', () => {
  assert.match(apiFailureMessage(new ApiGateFailure('AUTH_WRONG_PASSWORD',503)),/AUTH_WRONG_PASSWORD HTTP503\./);
  for(const status of ['503','SYNTHETIC-SECRET',NaN,Infinity,199,600,503.5,null,{}]) {
    const error=new ApiGateFailure('AUTH_LOGIN',status);
    assert.equal(apiFailureMessage(error).includes(' HTTP'),false);
    error.status=status; // Formatting revalidates mutation, not just the constructor.
    assert.equal(apiFailureMessage(error).includes(' HTTP'),false);
    assert.equal(apiFailureMessage(error).includes('SYNTHETIC-SECRET'),false);
  }
  const nonAuth=new ApiGateFailure('CHILD_FAILED',503);nonAuth.status=503;
  assert.equal(apiFailureMessage(nonAuth).includes(' HTTP'),false);
});

test('authentication failures identify the exact boundary and clean up sessions already accepted', async () => {
  const accounts=[{id:'qa-one',email:'one@fixture.invalid',role:'Cobrança',password:'synthetic-one'}, {id:'qa-two',email:'two@fixture.invalid',role:'Somente leitura',password:'synthetic-two'}];
  const scenarios=[['AUTH_UNAUTH_GET',503],['AUTH_UNAUTH_POST',403],['AUTH_WRONG_PASSWORD',503],['AUTH_LOGIN',401],['AUTH_IDENTITY',200],['AUTH_ME',200],['AUTH_SESSION_UNIQUE',undefined]];
  for(const [stage,status] of scenarios) {
    let loginCalls=0,meCalls=0,logoutCalls=0;
    const client=async(path,{method='GET'}={})=>{
      if(path==='/api/auth/logout'){logoutCalls++;return{status:200,body:{ok:true},cleared:true};}
      if(path==='/api/billing/recovery/cases')return{status:stage===(method==='GET'?'AUTH_UNAUTH_GET':'AUTH_UNAUTH_POST')?status:401,body:{}};
      if(path==='/api/auth/login'){
        loginCalls++;
        if(loginCalls===1)return{status:stage==='AUTH_WRONG_PASSWORD'?status:401,body:{}};
        const account=accounts[loginCalls-2];
        if(stage==='AUTH_LOGIN')return{status,body:{}};
        return{status:200,body:{user:stage==='AUTH_IDENTITY'?{...account,id:'wrong-synthetic-id'}:account},sessionCookie:`lzr_session=${(stage==='AUTH_SESSION_UNIQUE'?'a':String(loginCalls)).repeat(64)}`};
      }
      if(path==='/api/auth/me')return{status:200,body:{authenticated:stage!=='AUTH_ME',authRequired:true,user:accounts[meCalls++]}};
      assert.fail('Unexpected route in auth-boundary fixture');
    };
    await assert.rejects(()=>exerciseAuthenticatedApi(client,accounts),error=>error.category===stage&&error.status===status);
    assert.equal(logoutCalls,['AUTH_IDENTITY','AUTH_ME'].includes(stage)?1:stage==='AUTH_SESSION_UNIQUE'?2:0);
  }
});

const CHILD_LINES = [
  'PASS: exact repository migration chain applied to approved empty disposable Railway database.',
  'PASS: real concurrent active uniqueness, same-key replay and version CAS.',
  'PASS: actual FK rollback, scoped reads and close/reopen uniqueness.',
  'PASS: failed optional presentation read cannot roll back a reported successful mutation.',
  'Database intentionally retained for inspection; dispose of this test database separately. No IXC or messaging connection was used.',
  'PASS: real PostgreSQL gate completed; preparing synthetic authenticated browser stage.',
  'PASS: two synthetic accounts, two identified target conversations, forty newer unrelated conversations and one synthetic historical promise seeded. No credentials logged.',
  'Synthetic app process launched. Readiness and browser checks NOT YET VERIFIED. Expiry stops the app, not Railway billing; external cleanup remains required.',
];
test('child stage parser accepts exact ordered markers across chunks, not launch-only or reordered output', () => {
  const text=CHILD_LINES.join('\r\n')+'\r\n', parser=childPhaseReader();
  for(let at=0;at<text.length;at+=17)parser.push(Buffer.from(text.slice(at,at+17)));
  assert.equal(parser.complete(),true);
  for(const line of [CHILD_LINES[7],CHILD_LINES[1],'arbitrary child error']) assert.throws(()=>childPhaseReader().push(Buffer.from(line+'\n')),category('CHILD_OUTPUT'));
  const partial=childPhaseReader();partial.push(Buffer.from(CHILD_LINES[0]+'\n'));assert.equal(partial.complete(),false);
  assert.throws(()=>childPhaseReader().push(Buffer.from('x'.repeat(8193))),category('CHILD_OUTPUT'));
});

test('child stage parser cannot complete while trailing non-allowlisted partial output is pending', () => {
  const parser=childPhaseReader();
  assert.throws(()=>parser.push(Buffer.from(CHILD_LINES.join('\n')+'\nSYNTHETIC-UNRECOGNIZED-TAIL')),category('CHILD_OUTPUT'));
  assert.equal(parser.complete(),false);assert.equal(parser.bufferedLength(),0);
  for(let i=0;i<30;i++){assert.throws(()=>parser.push(Buffer.alloc(16384,120)),category('CHILD_OUTPUT'));assert.equal(parser.bufferedLength(),0);}
  assert.throws(()=>parser.push(Buffer.from('\n')),category('CHILD_OUTPUT'));
});

// Fake EventEmitters replace transport. No socket, listener, DNS or remote request is opened.
function fakeTransport(options={}) {
  const seen=[];
  const request=(params,callback)=>{
    const req=new EventEmitter();req.destroyed=false;req.destroy=()=>{req.destroyed=true;};
    req.end=encoded=>{
      seen.push({params,encoded,req});
      queueMicrotask(()=>{
        if(options.hang)return;
        if(options.requestError){req.emit('error',new Error('SYNTHETIC-RAW-ERROR'));return;}
        const response=new EventEmitter();response.statusCode=options.status??200;response.headers=options.headers??{};response.destroy=()=>{};
        callback(response);
        if(options.responseError){response.emit('error',new Error('SYNTHETIC-RAW-ERROR'));return;}
        if(options.aborted){response.emit('aborted');return;}
        const raw=options.raw??JSON.stringify(options.body??{authenticated:false});
        response.emit('data',Buffer.from(raw));response.emit('end');
      });
    };
    return req;
  };
  return {request,seen};
}
const syntheticCookie='lzr_session='+'a'.repeat(64);
const validSetCookie=syntheticCookie+'; Path=/; HttpOnly; Secure; SameSite=Lax';

test('HTTP client pins literal loopback and validated port, uses no agent/proxy and keeps request data out of URL', async () => {
  const fake=fakeTransport({body:{ok:true}}),client=createApiClient(3000,{request:fake.request});
  const result=await client('/api/billing/recovery/cases',{method:'POST',body:{action:'note',text:'synthetic'},cookie:syntheticCookie});
  assert.equal(result.status,200);assert.deepEqual(result.body,{ok:true});
  assert.equal(fake.seen.length,1);
  const {params,encoded}=fake.seen[0];
  assert.equal(params.hostname,'127.0.0.1');assert.equal(params.port,3000);assert.equal(params.agent,false);assert.equal(params.path,'/api/billing/recovery/cases');
  assert.equal('proxy' in params,false);assert.equal('auth' in params,false);assert.deepEqual(JSON.parse(encoded),{action:'note',text:'synthetic'});
});

test('HTTP client refuses alternate URLs, methods, unsafe query paths, cookie injection and oversized requests before transport', async () => {
  const fake=fakeTransport(),client=createApiClient(3000,{request:fake.request});
  for(const path of ['https://external.invalid/api/auth/me','//external.invalid/api/auth/me','/api/auth/me?redirect=https://external.invalid','/api/auth/me\r\nX: bad','/api/billing/recovery/cases?id=..%2Fother','/api/billing/recovery/cases?id=a&other=1','/api/unknown']) await assert.rejects(()=>client(path),category('HTTP_PROTOCOL'));
  for(const cookie of ['another=value',syntheticCookie+'; other=value',syntheticCookie+'\r\nHeader: value']) await assert.rejects(()=>client('/api/auth/me',{cookie}),category('HTTP_PROTOCOL'));
  await assert.rejects(()=>client('/api/auth/me',{method:'PUT'}),category('HTTP_PROTOCOL'));
  await assert.rejects(()=>client('/api/auth/login',{method:'POST',body:{padding:'x'.repeat(8193)}}),category('HTTP_PROTOCOL'));
  const circular={};circular.self=circular;await assert.rejects(()=>client('/api/auth/login',{method:'POST',body:circular}),category('HTTP_PROTOCOL'));
  assert.equal(fake.seen.length,0);
  for(const port of [0,80,65536,1.5,NaN,'3000'])assert.throws(()=>createApiClient(port,{request:fake.request}),category('TARGET_REFUSED'));
});

test('HTTP client refuses redirects, Location, oversized/non-JSON/scalar responses and timeout without exposing values', async () => {
  for(const options of [{status:302},{headers:{location:'https://external.invalid'}},{raw:'x'.repeat(65),maxBytes:64},{raw:'not-json'},{raw:'null'},{raw:'42'}]) {
    const fake=fakeTransport(options),client=createApiClient(3000,{request:fake.request,maxBytes:options.maxBytes});
    await assert.rejects(()=>client('/api/auth/me'),category('HTTP_PROTOCOL'));
    assert.equal(fake.seen.length,1,'no redirect is followed');
  }
  const fake=fakeTransport({hang:true}),client=createApiClient(3000,{request:fake.request,timeoutMs:5});
  await assert.rejects(()=>client('/api/auth/me'),category('HTTP_FAILED'));
  assert.equal(fake.seen[0].req.destroyed,true);
});

test('HTTP client sanitizes request/response transport failures and cancels pending work', async () => {
  for(const options of [{requestError:true},{responseError:true},{aborted:true}]) {
    const fake=fakeTransport(options),client=createApiClient(3000,{request:fake.request});
    await assert.rejects(()=>client('/api/auth/me'),error=>error.category==='HTTP_FAILED'&&!apiFailureMessage(error).includes('SYNTHETIC-RAW-ERROR'));
  }
  const controller=new AbortController(),fake=fakeTransport({hang:true}),client=createApiClient(3000,{request:fake.request,signal:controller.signal});
  const pending=client('/api/auth/me');controller.abort();await assert.rejects(pending,category('STOPPED'));
  assert.equal(fake.seen[0].req.destroyed,true);
  await assert.rejects(()=>client('/api/auth/me'),category('STOPPED'));assert.equal(fake.seen.length,1);
});

test('login cookie requires exact session shape and HttpOnly Secure SameSite Path; other routes cannot inject session', async () => {
  const good=fakeTransport({headers:{'set-cookie':[validSetCookie]},body:{user:{id:'synthetic'}}});
  const result=await createApiClient(3000,{request:good.request})('/api/auth/login',{method:'POST',body:{email:'operator@fixture.invalid',password:'synthetic-not-a-real-secret'}});
  assert.equal(result.sessionCookie===syntheticCookie,true);
  for(const cookie of [validSetCookie.replace('; Secure',''),validSetCookie.replace('; HttpOnly',''),validSetCookie.replace('SameSite=Lax','SameSite=None'),validSetCookie.replace('Path=/','Path=/other'),'lzr_session=invalid; Path=/; HttpOnly; Secure; SameSite=Lax']) {
    const fake=fakeTransport({headers:{'set-cookie':[cookie]}});
    await assert.rejects(()=>createApiClient(3000,{request:fake.request})('/api/auth/login',{method:'POST'}),category('AUTH_COOKIE'));
  }
  for(const cookies of [[],[validSetCookie,validSetCookie]]) {
    const fake=fakeTransport({headers:{'set-cookie':cookies}});
    await assert.rejects(()=>createApiClient(3000,{request:fake.request})('/api/auth/login',{method:'POST'}),category('AUTH_COOKIE'));
  }
  const stray=fakeTransport({headers:{'set-cookie':[validSetCookie]}});
  await assert.rejects(()=>createApiClient(3000,{request:stray.request})('/api/auth/me'),category('HTTP_PROTOCOL'));
  const cleared=fakeTransport({headers:{'set-cookie':['lzr_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax']}});
  assert.equal((await createApiClient(3000,{request:cleared.request})('/api/auth/logout',{method:'POST',cookie:syntheticCookie})).cleared,true);
});

async function composedApplication() {
  const accounts=generateApiCredentials(),auth=new MemoryAuthRepository(),repository=new MemoryRecoveryCasesRepository(),promises=new MemoryPaymentPromiseRepository(),now=new Date();
  for(const account of accounts)auth.users.push({id:account.id,email:account.email,name:account.name,role:account.role,passwordHash:account.hash,passwordSalt:account.salt,active:true,mustChangePassword:false});
  for(const [index,ticket] of FIXTURE_ATTENDANCES.entries())repository.tickets.set(ticket.id,{id:ticket.id,seq:index+1,protocol:ticket.protocol,identification:'identified',ixcCustomerId:ticket.customerId,channel:'n8n-whatsapp',externalConversationId:ticket.conversationId});
  promises.rows.push({id:'qa-promise-received',invoiceId:'940001',customerId:'910001',promisedFor:now.toISOString().slice(0,10),status:'pending',registeredBy:'synthetic-seed',correlationId:'synthetic-seed',createdAt:now.toISOString()});
  repository.promise=async id=>promises.rows.find(row=>row.id===id);
  const data=browserFixtureData(now),source=new IxcReadonlyProvider({baseUrl:'http://127.0.0.1:19999',token:FIXTURE_TOKEN,allowedCustomerIds:FIXTURE_CUSTOMERS,fullBase:true,retryLimit:0,rateLimitPerMinute:120,
    fetcher:async(url,init)=>{const result=syntheticIxcResponse({method:init.method,path:new URL(url).pathname,headers:Object.fromEntries(new Headers(init.headers)),body:init.body},data);return Response.json(result.body,{status:result.status});}});
  const token=request=>request.headers.get('cookie')?.split('=')[1];
  const authorize=async(request,permission)=>{const user=await resolveSession(auth,token(request));return !user?{allowed:false,status:401,error:'Synthetic unauthorized'}:!can(user.role,permission)?{allowed:false,status:403,error:'Synthetic forbidden'}:{allowed:true,user};};
  const handlers=createRecoveryCasesHandlers({authorize,getRepository:async()=>repository,getSource:()=>source,getScope:()=> 'qa-api-unit',now:()=>now});
  const calls=[];
  const client=async(path,{method='GET',body,cookie}={})=>{
    // Only non-secret route/method metadata is retained for assertions.
    calls.push({path,method});
    const request=new Request(`http://127.0.0.1:3000${path}`,{method,headers:{...(cookie?{cookie}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(path==='/api/auth/login'){
      const result=await login(auth,body.email,body.password);
      return result?{status:200,body:{user:result.user},sessionCookie:`lzr_session=${result.token}`}:{status:401,body:{error:'Synthetic generic failure'}};
    }
    if(path==='/api/auth/me')return{status:200,body:{authenticated:!!await resolveSession(auth,token(request)),authRequired:true,user:await resolveSession(auth,token(request))}};
    if(path==='/api/auth/logout'){await logout(auth,token(request));return{status:200,body:{ok:true},cleared:true};}
    if(path.startsWith('/api/billing/recovery/cases')){const result=await handlers[method](request);return{status:result.status,body:await result.json()};}
    if(path==='/api/billing/promises'){
      const access=await authorize(request,method==='GET'?'customer.read':'billing.write-demo');if(!access.allowed)return{status:access.status,body:{error:access.error}};
      if(method==='GET'){const pending=await promises.listPending();return{status:200,body:{available:true,pending,pendingCount:pending.length}};}
      try{
        if(body.action==='create')return{status:201,body:await createVerifiedPaymentPromise(async()=>promises,source,{invoiceId:body.invoiceId,customerId:body.customerId,promisedFor:body.promisedFor,registeredBy:access.user.email,correlationId:'synthetic-api-unit'},now)};
        if(body.action==='review')return{status:200,body:await reconcilePaymentPromises(promises,source,'synthetic-api-unit',now)};
      }catch(error){return{status:error instanceof PaymentPromiseValidationError?400:error.status??503,body:{error:'Synthetic rejected'}};}
    }
    assert.fail('Unexpected synthetic API path');
  };
  return{accounts,auth,repository,promises,client,calls,now};
}

test('full API assertion flow composes real auth, case handlers/RBAC, promise helpers and synthetic readonly provider with Memory repositories', async () => {
  const app=await composedApplication();
  try {
    const result=await exerciseAuthenticatedApi(app.client,app.accounts,app.now);
    assert.deepEqual(result,{stages:6,browser:'NOT_RUN',realIxc:'NOT_USED'});
    assert.equal(app.auth.sessions.size,0,'both genuine memory sessions were revoked');
    assert.equal(app.repository.cases.size,2);
    assert.equal([...app.repository.cases.values()].filter(row=>row.status!=='closed').length,1);
    assert.equal(app.promises.rows.find(row=>row.id==='qa-promise-received').status,'fulfilled');
    assert.equal(app.promises.rows.filter(row=>row.status==='pending').length,1);
    assert.equal(app.repository.events.every(row=>row.evidence.receiptConfirmed===false),true);
    assert.equal(app.calls.some(row=>row.path.includes('5500000910001')),false,'stored Attendance target is not a UI/navigation test');
  } finally {erase(app.accounts);}
});

test('failed API assertion stops and revokes already-created genuine sessions through normal logout', async () => {
  const app=await composedApplication();
  try {
    const corrupt=async(...args)=>{const response=await app.client(...args);if(args[0]==='/api/billing/recovery/cases'&&args[1]?.method!=='POST'&&args[1]?.cookie)response.body.canWrite=false;return response;};
    await assert.rejects(()=>exerciseAuthenticatedApi(corrupt,app.accounts,app.now),category('RBAC_FAILED'));
    assert.equal(app.auth.sessions.size,0);assert.equal(app.repository.events.length,0);
    assert.equal(app.calls.filter(row=>row.path==='/api/auth/logout').length,2);
  } finally {erase(app.accounts);}
});


test('child cleanup signals the detached group and verifies disappearance even after parent has exited', async () => {
  const signals=[],observations=[];
  await stopApiChild({pid:12345},Promise.resolve(),{kill:(pid,signal)=>signals.push([pid,signal]),exists:pid=>{observations.push(pid);return false;},graceMs:1});
  assert.deepEqual(signals,[[12345,'SIGTERM'],[12345,'SIGKILL']]);
  assert.equal(observations.length>=1,true);assert.equal(observations.every(pid=>pid===12345),true);
});

test('child cleanup escalates after grace and waits for parent exit instead of assuming TERM worked', async () => {
  const signals=[];let done,terminated=false;
  const exited=new Promise(resolve=>{done=resolve;});
  await stopApiChild({pid:12345},exited,{kill:(_pid,signal)=>{signals.push(signal);if(signal==='SIGKILL'){terminated=true;done();}},exists:()=>!terminated,graceMs:1});
  assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(terminated,true);
});

test('child cleanup fails closed if descendants remain or parent never exits; invalid PID is never signalled', async () => {
  await assert.rejects(()=>stopApiChild({pid:12345},Promise.resolve(),{kill:()=>{},exists:()=>true,graceMs:1}),category('CLEANUP_FAILED'));
  await assert.rejects(()=>stopApiChild({pid:12345},new Promise(()=>{}),{kill:()=>{},exists:()=>false,graceMs:1}),category('CLEANUP_FAILED'));
  for(const pid of [undefined,0,1,-123,1.5,NaN])await stopApiChild({pid},Promise.resolve(),{kill:()=>assert.fail('must not signal invalid process group'),exists:()=>assert.fail('must not inspect invalid process group')});
});

test('API oracle refuses fabricated receipt evidence and a logout response without actual session revocation', async () => {
  for(const kind of ['receipt','logout']) {
    const app=await composedApplication();
    try {
      const corrupt=async(...args)=>{
        if(kind==='logout'&&args[0]==='/api/auth/logout')return{status:200,body:{ok:true},cleared:true};
        const response=await app.client(...args);
        if(kind==='receipt'&&args[0].startsWith('/api/billing/recovery/cases?id=')&&response.body.events?.length===2)response.body.events[0].evidence.receiptConfirmed=true;
        return response;
      };
      await assert.rejects(()=>exerciseAuthenticatedApi(corrupt,app.accounts,app.now),category(kind==='receipt'?'CASE_FAILED':'LOGOUT_FAILED'));
      if(kind==='receipt')assert.equal(app.auth.sessions.size,0);
      else assert.equal(app.auth.sessions.size,2,'runner detected that claimed logout did not revoke sessions');
    } finally {app.auth.sessions.clear();erase(app.accounts);}
  }
});


test('child pipe errors abort once without exposing raw errors, then drain and zero future bytes', () => {
  for(const channel of ['stdout','stderr']) {
    const child={stdout:new EventEmitter(),stderr:new EventEmitter()}, phases=childPhaseReader();let failures=0;
    attachApiChildStreams(child,phases,()=>{failures++;});
    assert.doesNotThrow(()=>child[channel].emit('error',new Error('SYNTHETIC_PRIVATE_ERROR_DO_NOT_LOG')));
    assert.equal(failures,1);
    const bytes=Buffer.from('SYNTHETIC_FUTURE_OUTPUT');child.stdout.emit('data',bytes);
    assert.equal(bytes.every(byte=>byte===0),true);assert.equal(phases.bufferedLength(),0);assert.equal(phases.complete(),false);
    child.stderr.emit('error',new Error('SYNTHETIC_SECOND_ERROR'));assert.equal(failures,1);
    const stderr=Buffer.from('SYNTHETIC_DRIVER_DETAIL');child.stderr.emit('data',stderr);assert.equal(stderr.every(byte=>byte===0),true);
  }
});

test('child stdout flood aborts immediately and never retains later chunks', () => {
  const child={stdout:new EventEmitter(),stderr:new EventEmitter()}, phases=childPhaseReader();let failures=0;
  attachApiChildStreams(child,phases,()=>{failures++;});
  for(let i=0;i<30;i++) {const bytes=Buffer.alloc(16384,120);child.stdout.emit('data',bytes);assert.equal(bytes.every(byte=>byte===0),true);}
  assert.equal(failures,1);assert.equal(phases.bufferedLength(),0);assert.equal(phases.complete(),false);
});
