import {managedAgent} from './ixc-profile-managed-agent.mjs';
import {diagnosticAuthorization,withDiagnosticAuthorization} from '../lib/integrations/ixc/diagnostic-authorization.ts';
import {createIxcDiagnosticFetcher} from '../lib/integrations/ixc/profile-diagnostic-http.ts';
import {diagnoseProfile,profileConfiguration,PROFILE_ORIGIN,PROFILE_PATHS} from '../lib/integrations/ixc/profile-diagnostic.mjs';
const emit=result=>console.info(JSON.stringify({event:'ixc.profileDiagnostic',version:1,...result}));
async function configuration(){return new Promise((resolve,reject)=>{let size=0;const chunks=[];const timer=setTimeout(()=>{process.stdin.destroy();reject(Error());},2000);process.stdin.on('data',chunk=>{size+=chunk.length;if(size>4096){process.stdin.destroy();clearTimeout(timer);reject(Error());}else chunks.push(chunk);});process.stdin.on('error',()=>{clearTimeout(timer);reject(Error());});process.stdin.on('end',()=>{clearTimeout(timer);try{resolve(profileConfiguration(JSON.parse(Buffer.concat(chunks).toString('utf8'))));}catch{reject(Error());}});});}
let agent;
try{
 if(process.env.IXC_PROFILE_READ_APPROVED!=='true'||process.argv.length!==2)throw Error();
 const config=await configuration();
 // Binding/provenance must be established externally; syntax cannot prove it.
 const authorization=diagnosticAuthorization(process.env);agent=managedAgent();
 const transport=withDiagnosticAuthorization(createIxcDiagnosticFetcher({origin:PROFILE_ORIGIN,paths:config.scope==='customer'?[PROFILE_PATHS[0]]:PROFILE_PATHS,timeoutMs:10000,maxRequestBytes:4096,maxResponseBytes:1048576},agent),authorization);
 const result=await diagnoseProfile(config,transport);emit(result);process.exitCode=result.outcome==='accepted'?0:1;
}catch{emit({outcome:'refused',category:'configuration',calls:0});process.exitCode=78;}
finally{agent?.destroy();}
