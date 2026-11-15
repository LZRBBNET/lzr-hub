// Test-only local cookie transfer. Never print or put the cookie in argv/errors.
import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';
const valid=b=>Buffer.isBuffer(b)&&b.length===76&&b.subarray(0,12).equals(Buffer.from('lzr_session='))&&b.subarray(12).every(c=>c>=48&&c<=57||c>=97&&c<=102);
export async function captureSession(name,env){
 let output;
 try{output=await promisify(execFile)('docker',['--host','unix:///var/run/docker.sock','exec',name,'node','-e',"process.stdout.write(require('node:fs').readFileSync('/run/lzr/test-session'))"],{env,encoding:'buffer',maxBuffer:256,timeout:10000});if(!valid(output.stdout))throw Error('INVALID_SESSION');return Buffer.from(output.stdout);
 }catch(error){if(Buffer.isBuffer(error.stdout))error.stdout.fill(0);if(Buffer.isBuffer(error.stderr))error.stderr.fill(0);throw Error('PRIVATE_SESSION_CAPTURE_FAILED');}
 finally{output?.stdout?.fill(0);output?.stderr?.fill(0);}
}
export async function restoreSession(name,env,session){
 if(!valid(session)){if(Buffer.isBuffer(session))session.fill(0);throw Error('PRIVATE_SESSION_FORMAT_FAILED');}
 const code="const f=require('node:fs');let parts=[],size=0;process.stdin.on('data',b=>{size+=b.length;if(size>76)process.exit(1);parts.push(b)});process.stdin.on('end',()=>{const b=Buffer.concat(parts);try{if(b.length!==76||!b.subarray(0,12).equals(Buffer.from('lzr_session='))||!b.subarray(12).every(c=>c>=48&&c<=57||c>=97&&c<=102))process.exit(1);f.writeFileSync('/run/lzr/old-session',b,{mode:384,flag:'wx'});const s=f.statSync('/run/lzr/old-session');if((s.mode&511)!==384||s.uid!==0)process.exitCode=1;}catch{process.exitCode=1;}finally{b.fill(0);parts.forEach(p=>p.fill(0));}})";
 try{await new Promise((resolve,reject)=>{const child=spawn('docker',['--host','unix:///var/run/docker.sock','exec','-i',name,'node','-e',code],{env,stdio:['pipe','ignore','ignore']});const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('PRIVATE_SESSION_RESTORE_TIMEOUT'));},10000);child.once('error',()=>{clearTimeout(timer);reject(Error('PRIVATE_SESSION_RESTORE_FAILED'));});child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('PRIVATE_SESSION_RESTORE_FAILED'));});child.stdin.on('error',()=>{});child.stdin.end(session);});}finally{session.fill(0);}
}
