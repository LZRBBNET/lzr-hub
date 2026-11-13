import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {performance} from 'node:perf_hooks';
import {createIxcDiagnosticFetcher,diagnosticTransportFailure} from '../lib/integrations/ixc/profile-diagnostic-http.ts';
import {IxcReadonlyProvider} from '../lib/integrations/ixc/readonly-provider.ts';

test('diagnostic error catalog never returns arbitrary exception content',()=>{
  for(const [code,category] of [['ERR_PROXY_TUNNEL','proxy-tunnel'],['ERR_TLS_CERT_ALTNAME_INVALID','tls-hostname'],['DEPTH_ZERO_SELF_SIGNED_CERT','tls-trust'],['ECONNREFUSED','connection'],['SYNTHETIC-PRIVATE-CODE','other']]){
    const error=Object.assign(new Error('SYNTHETIC-PRIVATE-MESSAGE'),{code});
    assert.equal(diagnosticTransportFailure(error),category);
  }
  assert.equal(diagnosticTransportFailure({get code(){throw Error('private');}}),'other');
  assert.equal(diagnosticTransportFailure(new DOMException('private','AbortError')),'timeout');
});

test('real held HTTP read hits deadline, preserves provider timeout and closes socket',async()=>{
  const sockets=new Set();let calls=0;const failures=[],milestones=[];
  const server=http.createServer(req=>{calls++;req.resume();});
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const baseUrl=`http://127.0.0.1:${server.address().port}`;
    const fetcher=createIxcDiagnosticFetcher({origin:baseUrl,paths:['/webservice/v1/fn_areceber'],timeoutMs:80,maxRequestBytes:4096,maxResponseBytes:4096},undefined,category=>{failures.push(category);throw Error('SYNTHETIC-OBSERVER-FAILURE');},event=>milestones.push(event));
    const provider=new IxcReadonlyProvider({baseUrl,token:'synthetic-not-a-credential',allowedCustomerIds:['900000001'],retryLimit:0,timeoutMs:500,fetcher});
    const start=performance.now();
    await assert.rejects(provider.getInvoicePaymentPage('900000001','900000002',1,'synthetic'),error=>error.code==='IXC_TIMEOUT');
    const elapsed=performance.now()-start;
    // 80 ms deadline, up to 920 ms scheduling allowance; this checks actual completion.
    assert.ok(elapsed>=60&&elapsed<1000,'DEADLINE_NOT_ENFORCED');
    assert.equal(calls,1);assert.deepEqual(failures,['timeout']);
    assert.equal(milestones.at(-1).milestone,'timeout');assert.equal(milestones.at(-1).timeoutOrigin,'transport-deadline');
    assert.equal(milestones.at(-1).phase,'headers-pending');
    assert.ok(milestones.every((e,i)=>e.elapsedMs>=0&&e.elapsedMs<=60000&&(!i||e.elapsedMs>=milestones[i-1].elapsedMs)));
    const end=performance.now()+500;
    while(sockets.size&&performance.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(sockets.size,0,'SOCKET_REMAINED');
  }finally{
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
  }
});

for(const scenario of ['success','headers-held','chunk-held'])test(`real HTTP milestone semantics: ${scenario}`,async()=>{
  const sockets=new Set(),events=[];
  const server=http.createServer((req,res)=>{
    req.resume();res.writeHead(200,{'Content-Type':'text/x-json'});res.flushHeaders();
    if(scenario==='headers-held')return;
    res.write('{"registros":');
    if(scenario==='chunk-held')return;
    res.end('[]}');
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const origin=`http://127.0.0.1:${server.address().port}`;
    const fetcher=createIxcDiagnosticFetcher({origin,paths:['/read'],timeoutMs:80,maxRequestBytes:4096,maxResponseBytes:4096},undefined,undefined,e=>events.push(e));
    if(scenario==='success')assert.deepEqual(await(await fetcher(origin+'/read',{body:'{}'})).json(),{registros:[]});
    else await assert.rejects(fetcher(origin+'/read',{body:'{}'}),e=>e instanceof DOMException&&e.name==='AbortError');
    const names=events.map(e=>e.milestone);
    assert.equal(names[0],'request-start');assert.ok(names.indexOf('headers-received')>names.indexOf('socket-assigned'));
    assert.equal(names.includes('body-first-chunk'),scenario!=='headers-held');
    assert.equal(names.includes('body-complete'),scenario==='success');
    assert.equal(events.at(-1).phase,scenario==='success'?'complete':'body-pending');
    assert.equal(events.at(-1).timeoutOrigin,scenario==='success'?'none':'transport-deadline');
    assert.ok(events.every((e,i)=>Object.keys(e).sort().join(',')==='elapsedMs,milestone,phase,timeoutOrigin'&&Number.isInteger(e.elapsedMs)&&e.elapsedMs>=0&&e.elapsedMs<=60000&&(!i||e.elapsedMs>=events[i-1].elapsedMs)));
  }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});

test('profile transport rejects endpoint/origin/request size before a socket and bounds response',async()=>{
 let calls=0;const server=http.createServer((req,res)=>{calls++;req.resume();res.end('x'.repeat(1024));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 try{const transport=createIxcDiagnosticFetcher({origin,paths:['/webservice/v1/cliente'],timeoutMs:500,maxRequestBytes:16,maxResponseBytes:32});
 for(const [url,body] of [[origin+'/webservice/v1/fn_areceber','{}'],['http://other.invalid/webservice/v1/cliente','{}'],[origin+'/webservice/v1/cliente','x'.repeat(17)]])await assert.rejects(()=>transport(url,{body}),/IXC_TRANSPORT_POLICY/);
 assert.equal(calls,0);await assert.rejects(()=>transport(origin+'/webservice/v1/cliente',{body:'{}'}),/IXC_RESPONSE_LIMIT/);assert.equal(calls,1);
 }finally{await new Promise(r=>server.close(r));}
});
