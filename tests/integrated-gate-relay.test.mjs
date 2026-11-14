import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('fixed relay validates RFC1918 targets and forwards both directions without protocol parsing',async()=>{
 const code=String.raw`
import importlib.util,socket,threading
spec=importlib.util.spec_from_file_location('relay','scripts/qa-integrated-relay.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
for value in ['127.0.0.1','0.0.0.0','8.8.8.8','169.254.169.254','::1','example.com']:
 try:r.private_target(value)
 except ValueError:pass
 else:raise AssertionError('unsafe target accepted')
assert r.private_target('172.18.0.2')=='172.18.0.2'
a,b=socket.socketpair();c,d=socket.socketpair()
a.settimeout(2);d.settimeout(2)
t=threading.Thread(target=r.forward,args=(b,c));t.start()
try:
 a.sendall(b'client-data');assert d.recv(50)==b'client-data'
 d.sendall(b'server-data');assert a.recv(50)==b'server-data'
 r.STOP.set();t.join(2);assert not t.is_alive()
 assert a.recv(1)==b'';assert d.recv(1)==b''
finally:
 a.close();d.close();r.STOP.set();t.join(2)
print('relay-contract-passed')
`;
 const result=await exec('python3',['-B','-c',code]);
 assert.equal(result.stdout.trim(),'relay-contract-passed');
});
