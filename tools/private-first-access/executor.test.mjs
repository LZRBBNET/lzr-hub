import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFirstAccessExecutor, createHttpsTransport, hiddenPrompt } from './executor.mjs';
const target={origin:'https://synthetic-test-fixture.onrender.com',databaseOid:'12345',attempt:'synthetic-init-executor-review'};
const token='c'.repeat(64),password='invented-for-offline-only';
const preflight={processId:'synthetic-process-123',databaseOid:'12345',available:true,freshManualApprovalRequired:true,retryAllowed:false};
const absence={state:'absence-observed',reservationObserved:false,completionObserved:false,manifestMatches:false,retryAllowed:false,credentialsVerified:false,targetHostMatches:true,expectedManifestSha256:'97a9ec8b31e619eba5de6ac9acf4525ab5002761f2320c5fa45451bf29df4702'};
const completed={status:'confirmed',synthetic:true,retryAllowed:false,credentialsReturned:false,delivered:false};
const answers=()=>['APROVO_ALVO_DESCARTAVEL',token,password,password,'INICIALIZAR_UMA_VEZ'];
function fixture(options={}) {
  const inputs=options.inputs??answers(),calls=[],logs=[],derived=[];
  const run=createFirstAccessExecutor({prompt:async()=>{const answer=inputs.shift();if(answer instanceof Error)throw answer;return answer;},
    derive:async value=>{derived.push(value);return{hash:'a'.repeat(128),salt:'b'.repeat(32)};},report:message=>logs.push(message),
    transport:async(url,req)=>{calls.push({url,...req});if(options.transport)return options.transport(url,req);if(new URL(url).search)return{status:200,body:{...absence}};return req.method==='GET'?{status:200,body:{...preflight}}:{status:201,body:{...completed}};}});
  return{run,calls,logs,derived};
}
test('fluxo offline tem contrato exato e um POST; nenhuma saída contém segredo',async()=>{
  const f=fixture();assert.deepEqual(await f.run(target),{state:'completion-confirmed',retryAllowed:false});
  assert.deepEqual(f.calls.map(c=>c.method),['GET','GET','POST']);assert.equal(f.calls[2].headers.origin,target.origin);
  assert.equal(f.calls[2].headers['x-synthetic-init-capability'],token);
  const body=JSON.parse(f.calls[2].body);assert.deepEqual(Object.keys(body).sort(),['attempt','confirmation','databaseOid','hash','processId','salt']);
  assert.equal(body.confirmation,'CREATE_EMPTY_SYNTHETIC_DATABASE_V1');assert.equal(body.hash,'a'.repeat(128));
  assert.equal(body.processId,preflight.processId);assert.equal(f.derived[0],password);
  assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(`${token}|${password}|${'a'.repeat(30)}|${'b'.repeat(30)}`));
  assert.deepEqual(await f.run(target),{state:'blocked',retryAllowed:false});assert.equal(f.calls.length,3);
});
test('alvos, confirmação, token, senha, preflight e cancelamento falham antes da escrita',async()=>{
  for(const override of [{origin:'http://bad.onrender.com'},{origin:'https://user:invented@bad.onrender.com'},{origin:target.origin+'/'},
    {origin:'https://bad.example.invalid'},{origin:target.origin+':443'},{origin:target.origin+'?x=1'},{databaseOid:'0'},{attempt:'bad'}]){
    const f=fixture();assert.equal((await f.run({...target,...override})).state,'refused');assert.equal(f.calls.length,0);
  }
  for(const [index,value] of [[0,'no'],[1,'bad'],[2,'short'],[3,'different'],[4,'no'],[2,new Error('invented-private-error')]]){
    const inputs=answers();inputs[index]=value;const f=fixture({inputs});assert.equal((await f.run(target)).state,'refused');assert.ok(f.calls.every(c=>c.method==='GET'));
  }
  for(const body of [{...preflight,databaseOid:'54321'},{...preflight,available:false},{...preflight,retryAllowed:true},{...preflight,secret:'invented'},null]){
    const f=fixture({transport:async(url)=>({status:200,body:new URL(url).search?{...absence}:body})});assert.equal((await f.run(target)).state,'refused');assert.equal(f.calls.length,2);
  }
});
test('timeout/resposta perdida/erro HTTP/corpo divergente nunca repete POST',async()=>{
  for(const outcome of [()=>{throw new Error('invented-private-error');},()=>({status:503,body:{error:token}}),()=>({status:201,body:{...completed,extra:password}}),()=>({status:201,body:null}),()=>null]){
    const f=fixture({transport:async(url,req)=>req.method==='GET'?{status:200,body:new URL(url).search?{...absence}:{...preflight}}:outcome()});
    assert.equal((await f.run(target)).state,'not-confirmed');assert.equal((await f.run(target)).state,'blocked');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
    assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(`${token}|${password}|invented-private-error`));
  }
});
test('execuções concorrentes não repetem leitura ou escrita',async()=>{
  const f=fixture();const values=await Promise.all([f.run(target),f.run(target)]);assert.deepEqual(values.map(v=>v.state).sort(),['blocked','completion-confirmed']);assert.equal(f.calls.length,3);
});
const response=(url,text,type='application/json')=>{const r=new Response(text,{headers:{'content-type':type}});Object.defineProperty(r,'url',{value:url});return r;};
test('transporte usa timeout, recusa redirect e limita corpo sem conexão real',async()=>{
  let observed;
  const url=target.origin+'/api/demo/initialize';
  const transport=createHttpsTransport(async(u,options)=>{observed=options;return response(u,'{}');});
  assert.deepEqual(await transport(url,{method:'GET',headers:{}}),{status:200,body:{}});
  assert.equal(observed.redirect,'error');assert.equal(observed.credentials,'omit');assert.equal(observed.cache,'no-store');assert.ok(observed.signal instanceof AbortSignal);
  for(const fake of [u=>response(u,'x'.repeat(4097)),u=>response(u,'not-json'),u=>response(u,'{}','text/html'),()=>response('https://other.onrender.com/api/demo/initialize','{}')]){
    await assert.rejects(createHttpsTransport(async u=>fake(u))(url,{method:'GET'}));
  }
});
function tty(isTTY=true){const input=new EventEmitter(),output={isTTY,text:'',write(s){this.text+=s;}};input.isTTY=isTTY;input.isRaw=false;
  input.setRawMode=value=>{input.isRaw=value;};input.setEncoding=()=>{};input.resume=()=>{};input.pause=()=>{};return{input,output,signals:new EventEmitter()};}
test('TTY oculta texto, edita, restaura modo e remove listeners',async()=>{
  const t=tty(),prompt=hiddenPrompt(t.input,t.output,t.signals);const pending=prompt('Senha: ');
  t.input.emit('data','invented-secretX');t.input.emit('data','\x7f');t.input.emit('data','\r');
  assert.equal(await pending,'invented-secret');assert.equal(t.output.text,'Senha: \n');assert.equal(t.input.isRaw,false);
  assert.equal(t.input.listenerCount('data'),0);assert.equal(t.signals.listenerCount('SIGINT'),0);
});
test('TTY recusa CI, multiline paste, controles, EOF e sinais; nenhum segredo ecoado',async()=>{
  const ci=tty(false);await assert.rejects(hiddenPrompt(ci.input,ci.output,ci.signals)('Senha: '));assert.equal(ci.output.text,'');
  for(const action of [t=>t.input.emit('data','private\rsecond'),t=>t.input.emit('data','private\x03'),t=>t.input.emit('end'),t=>t.signals.emit('SIGTERM'),t=>t.input.emit('error',new Error('invented-private-error'))]){
    const t=tty(),pending=hiddenPrompt(t.input,t.output,t.signals)('Senha: ');action(t);await assert.rejects(pending,/FIRST_ACCESS_CANCELLED/);assert.equal(t.input.isRaw,false);assert.equal(t.output.text,'Senha: \n');assert.equal(t.input.listenerCount('data'),0);
  }
});

test('sem status #56 confirmado ou com reserva/conclusão, executor recusa antes da senha e POST',async()=>{
  for(const body of [{...preflight},{...absence,state:'reservation-observed',reservationObserved:true},
    {...absence,state:'completion-observed',completionObserved:true},{...absence,expectedManifestSha256:'wrong'},
    {...absence,credentialsVerified:true}]) {
    const f=fixture({transport:async()=>({status:200,body})});assert.equal((await f.run(target)).state,'refused');
    assert.equal(f.calls.length,1);assert.equal(f.derived.length,0);
  }
});

test('falha ao ativar modo oculto aborta e remove listeners sem eco de entrada',async()=>{
  const t=tty();t.input.setRawMode=()=>{throw new Error('invented-terminal-error');};
  await assert.rejects(hiddenPrompt(t.input,t.output,t.signals)('Senha: '),/FIRST_ACCESS_CANCELLED/);
  assert.equal(t.input.listenerCount('data'),0);assert.equal(t.signals.listenerCount('SIGINT'),0);
  assert.doesNotMatch(t.output.text,/invented|Senha/);
});
