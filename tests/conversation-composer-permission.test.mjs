import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Module,createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {roles,can} from '../lib/platform/rbac.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const fixture={guard:{allowed:true},fail:false};
globalThis.__composerPermissionQA=fixture;
const bundle=await build({entryPoints:[root+'app/api/conversations/route.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',write:false,logLevel:'silent',plugins:[{name:'synthetic-boundaries',setup(b){
 b.onResolve({filter:/session-guard$/},()=>({path:'guard',namespace:'qa'}));
 b.onResolve({filter:/^@\/db$/},()=>({path:'db',namespace:'qa'}));
 b.onResolve({filter:/^@\/lib\/platform\/conversations-service$/},()=>({path:'conversations',namespace:'qa'}));
 b.onLoad({filter:/.*/,namespace:'qa'},({path})=>({loader:'js',contents:path==='guard'?`export const authorize=async()=>globalThis.__composerPermissionQA.guard;export const authEnforced=()=>process.env.FEATURE_AUTH==='true';`:path==='db'?`export async function getDb(){if(globalThis.__composerPermissionQA.fail)throw Error('synthetic unavailable');return {};}`:`export class DbConversationsRepository {async listConversations(){return []}async getMessages(){return []}async getAudit(){return null}}export const replyWindowFrom=()=>({open:false});`}));
}}]});
const mod=new Module(root+'tests/composer-permission-virtual.cjs');mod.paths=createRequire(import.meta.url).resolve.paths('next');mod._compile(bundle.outputFiles[0].text,mod.filename=root+'tests/composer-permission-virtual.cjs');const {GET}=mod.exports;
const keys=['FEATURE_AUTH','FEATURE_ATTENDANT_REPLY','META_ACCESS_TOKEN','META_PHONE_NUMBER_ID'];
async function scenario(changes,run){const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));Object.assign(process.env,{FEATURE_AUTH:'true',FEATURE_ATTENDANT_REPLY:'true',META_ACCESS_TOKEN:'synthetic',META_PHONE_NUMBER_ID:'synthetic'},changes);try{await run();}finally{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];fixture.fail=false;}}
for(const role of roles)test(`composer availability respects ${role} for list, detail and unavailable DB`,async()=>scenario({},async()=>{
 fixture.guard={allowed:true,user:{id:'synthetic',name:'Synthetic',email:'synthetic@example.invalid',role}};
 for(const fail of [false,true])for(const query of ['', '?id=5511000000001']){fixture.fail=fail;const response=await GET(new Request('http://localhost/api/conversations'+query));assert.equal(response.status,200);const data=await response.json();assert.equal(data.channelState.canReply,can(role,'support.write'));}
}));
test('missing identity, disabled auth, disabled send and missing config fail closed',async()=>{
 for(const changes of [{},{FEATURE_AUTH:'false'},{FEATURE_ATTENDANT_REPLY:'false'},{META_ACCESS_TOKEN:''},{META_PHONE_NUMBER_ID:''}])await scenario(changes,async()=>{fixture.guard={allowed:true,...(Object.keys(changes).length?{user:{id:'synthetic',role:'Supervisor'}}:{})};const data=await(await GET(new Request('http://localhost/api/conversations'))).json();assert.equal(data.channelState.canReply,false);});
});
test('denied session does not read conversation data',async()=>scenario({},async()=>{fixture.guard={allowed:false,status:401,error:'Sessão inválida'};fixture.fail=true;assert.equal((await GET(new Request('http://localhost/api/conversations'))).status,401);}));
