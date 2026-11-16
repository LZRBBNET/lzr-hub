import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const code=await readFile(new URL('../lib/memory-demo/ui.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const elements=new Map(),events={},docEvents={},calls=[];
 function element(id){if(!elements.has(id))elements.set(id,{id,value:'',textContent:'',hidden:false,disabled:false,events:{},reset(){this.value='';},focus(){if(!this.disabled)focused=id;},setAttribute(){},querySelector(){return element(id+'-input');},querySelectorAll(){return [element(id+'-secret')];},addEventListener(event,fn){this.events[event]=fn;}});return elements.get(id);}
 let focused;
 const buttons=['logout','customer','summary','claim','release','preview','promise','review','pay','dispatch'];
 const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>buttons.map(element),addEventListener:(key,fn)=>docEvents[key]=fn,visibilityState:'visible'},window:{addEventListener:(key,fn)=>events[key]=fn},fetch:(path,options)=>new Promise(resolve=>calls.push({path,options,respond:(body,status=200)=>resolve({status,ok:status<400,json:async()=>body})})),FormData:class{*[Symbol.iterator](){yield ['email','fixture@example.invalid'];}},console,Date});
 vm.runInContext(code,context);
 return {element,events,docEvents,calls,context,focus:()=>focused,click:id=>element(id).events.click(),submit:id=>element(id).events.submit({preventDefault(){},currentTarget:element(id)})};
}
const account={name:'Fixture',role:'Supervisor',mustChangePassword:false};
async function admitted(){const f=fixture();f.calls[0].respond({user:account});await tick();return f;}
test('old customer response cannot enter a restored session',async()=>{const f=await admitted();f.click('customer');const old=f.calls[1];f.events.pagehide();f.events.pageshow();assert.equal(f.element('panels').hidden,true);f.calls[2].respond({user:account});await tick();old.respond({customer:{name:'OLD_SECRET_CANARY'}});await tick();assert.equal(f.element('customerResult').textContent,'');assert.equal(f.element('panels').hidden,false);});
test('duplicate actions and submissions serialize; reader stays disabled',async()=>{const f=await admitted();f.click('customer');f.click('customer');f.submit('password');assert.equal(f.calls.length,2);f.calls[1].respond({customer:{name:'Fixture'}});await tick();f.events.pageshow();f.calls[2].respond({user:{...account,role:'Somente leitura'}});await tick();assert.equal(f.element('pay').disabled,true);assert.equal(f.element('claim').disabled,true);});
test('logout clears results and focuses login; stale401 cannot invalidate new session',async()=>{const f=await admitted();f.element('customerResult').textContent='private fixture';f.click('logout');f.calls[1].respond({ok:true});await tick();assert.equal(f.element('customerResult').textContent,'');assert.equal(f.element('panels').hidden,true);assert.equal(f.focus(),'login-input');f.events.pageshow();const old=f.calls[2];f.events.pageshow();f.calls[3].respond({user:account});await tick();old.respond({},401);await tick();assert.equal(f.element('panels').hidden,false);});
test('expired session clears all results and forced password receives focus',async()=>{const f=await admitted();f.element('billingResult').textContent='canary';f.click('customer');f.calls[1].respond({},401);await tick();assert.equal(f.element('billingResult').textContent,'');assert.equal(f.element('panels').hidden,true);f.events.pageshow();f.calls[2].respond({user:{...account,mustChangePassword:true}});await tick();assert.equal(f.focus(),'password-input');assert.equal(f.element('panels').hidden,true);});

test('focus waits for enablement and old submit cannot clear new password input',async()=>{const f=await admitted();assert.equal(f.focus(),'customer');f.submit('password');const old=f.calls[1];f.events.pageshow();f.calls[2].respond({user:null});await tick();f.element('password-secret').value='NEW_FORM_CANARY';old.respond({ok:true});await tick();assert.equal(f.element('password-secret').value,'NEW_FORM_CANARY');});

test('navigation only targets admitted panels and actionable errors receive focus',async()=>{const f=fixture();assert.equal(f.element('workspaceNav').hidden,true);f.calls[0].respond({user:{...account,mustChangePassword:true}});await tick();assert.equal(f.element('journeyNav').hidden,true);f.events.pageshow();f.calls[1].respond({user:account});await tick();assert.equal(f.element('workspaceNav').hidden,false);f.click('customer');f.calls[2].respond({error:'Fonte indisponível'},503);await tick();assert.equal(f.focus(),'message');assert.equal(f.element('message').textContent,'Fonte indisponível');f.events.pagehide();assert.equal(f.element('workspaceNav').hidden,true);});
