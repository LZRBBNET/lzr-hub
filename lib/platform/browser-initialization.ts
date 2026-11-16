import { createHash, timingSafeEqual } from 'node:crypto';
import { assertSyntheticWeb } from '../runtime/synthetic-web.ts';
import { initializationAccess } from './synthetic-initialization-access.ts';

const COOKIE = '__Host-lzr-browser-init';
const MANIFEST = '97a9ec8b31e619eba5de6ac9acf4525ab5002761f2320c5fa45451bf29df4702';
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' };
const browserAccess = (request:Request,source:Record<string,string|undefined>,now:number) =>
  initializationAccess(request,source,now) && Date.parse(source.SYNTHETIC_INIT_EXPIRES_AT!) - now <= 15 * 60 * 1000;
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
const same = (a:string,b:string) => /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const exact = (value:unknown, keys:string[]) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const fingerprint = (s:Record<string,string|undefined>) => digest(JSON.stringify([s.DATABASE_URL,s.SYNTHETIC_INIT_DATABASE_HOST,s.SYNTHETIC_INIT_CAPABILITY_SHA256,s.SYNTHETIC_INIT_EXPIRES_AT,s.SYNTHETIC_DEMO_ORIGIN]));
const reply = (body:unknown,status:number,cookie?:string) => Response.json(body,{status,headers:{...headers,...(cookie?{'set-cookie':cookie}:{})}});
export function browserSetupRequested(s:Record<string,string|undefined>) {
  if(s.SYNTHETIC_BROWSER_SETUP_ENABLED!=='true')return false;
  try{assertSyntheticWeb(s);return true;}catch{return false;}
}
function readCookie(request:Request) {
  const matches=(request.headers.get('cookie')??'').split(';').map(p=>p.trim()).filter(p=>p.startsWith(COOKIE+'='));
  return matches.length===1 && /^[a-f0-9]{64}$/.test(matches[0].slice(COOKIE.length+1)) ? matches[0].slice(COOKIE.length+1) : undefined;
}
type Deps = {
  source():Record<string,string|undefined>;
  now():number;
  random():string;
  derive(password:string):Promise<{hash:string;salt:string}>;
  initialize(request:Request):Promise<Response>;
};
/** One process/session, no timers, startup work, logging or implicit retry. */
export function createBrowserInitialization(deps:Deps) {
  let session: {cookieHash:string;target:string;attempt:string;expires:number;processId?:string;oid?:string;ready:boolean;used:boolean;failed:boolean}|undefined;
  let busy=false;
  return async function handle(request:Request):Promise<Response> {
    const source={...deps.source()},url=new URL(request.url),now=deps.now();
    if (!browserSetupRequested(source) || !Number.isFinite(now) || !browserAccess(request,source,now)) return reply({state:'unavailable',retryAllowed:false},404);
    if (url.origin!==source.SYNTHETIC_DEMO_ORIGIN || (request.headers.has('origin')&&request.headers.get('origin')!==url.origin)
      || (request.headers.has('sec-fetch-site')&&request.headers.get('sec-fetch-site')!=='same-origin')) return reply({state:'refused',retryAllowed:false},403);
    if (!['GET','POST'].includes(request.method)) return reply({state:'refused',retryAllowed:false},405);
    const statusRead=request.method==='GET'&&url.search==='?status=1';
    if (url.search&&!statusRead) return reply({state:'refused',retryAllowed:false},400);
    const attempt=request.headers.get('x-browser-init-attempt')??'';
    if (!/^synthetic-init-[a-z0-9-]{8,64}$/.test(attempt)) return reply({state:'refused',retryAllowed:false},400);
    const cookie=readCookie(request),target=fingerprint(source);
    if(session&&(session.target!==target||session.attempt!==attempt||now>=session.expires||!cookie||!same(digest(cookie),session.cookieHash)))return reply({state:'blocked',retryAllowed:false},409);
    const priorSetupCookie=(request.headers.get('cookie')??'').split(';').some(part=>part.trim().startsWith(COOKIE+'='));
    if(!session&&(request.method!=='GET'||statusRead||priorSetupCookie))return reply({state:'blocked',retryAllowed:false},409);
    if(busy)return reply({state:'blocked',retryAllowed:false},409);
    busy=true;
    let setCookie:string|undefined;
    try {
      if(!session){
        const token=deps.random();if(!/^[a-f0-9]{64}$/.test(token))throw Error();
        const expires=Date.parse(source.SYNTHETIC_INIT_EXPIRES_AT!);
        session={cookieHash:digest(token),target,attempt,expires,ready:false,used:false,failed:false};
        setCookie=`${COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0,Math.floor((expires-now)/1000))}`;
      }
      const current=session;
      const internal=(method:string,body?:unknown,status=false)=>{
        const u=new URL('/api/demo/initialize',url.origin);
        if(status)u.search=new URLSearchParams({status:'1',databaseOid:current.oid!,attempt:current.attempt}).toString();
        return new Request(u,{method,headers:{'x-synthetic-init-capability':request.headers.get('x-synthetic-init-capability')!,origin:url.origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      };
      const valid=()=>browserSetupRequested(deps.source())&&fingerprint(deps.source())===current.target&&browserAccess(request,deps.source(),deps.now())&&deps.now()<current.expires;
      if(statusRead){
        if(!current.oid)return reply({state:'unknown',retryAllowed:false},409);
        return deps.initialize(internal('GET',undefined,true));
      }
      if(request.method==='GET'){
        if(current.used||current.failed)return reply({state:'blocked',retryAllowed:false},409);
        // Repeating admission observation never repeats initialization or extends expiry.
        if(current.ready){
          if(!valid())return reply({state:'blocked',retryAllowed:false},409);
          return reply({state:'ready',databaseOid:current.oid,attempt:current.attempt,expiresAt:source.SYNTHETIC_INIT_EXPIRES_AT,retryAllowed:false},200);
        }
        // Read-only observations; never retry a failed session automatically.
        current.failed=true;
        const preflight=await deps.initialize(internal('GET'));
        const p=await preflight.json();
        if(preflight.status!==200||!exact(p,['processId','databaseOid','available','freshManualApprovalRequired','retryAllowed'])||p.available!==true||p.freshManualApprovalRequired!==true||p.retryAllowed!==false
          ||typeof p.processId!=='string'||!/^[a-zA-Z0-9-]{8,64}$/.test(p.processId)||typeof p.databaseOid!=='string'||!/^[1-9]\d{0,9}$/.test(p.databaseOid)||!valid())throw Error();
        current.oid=p.databaseOid;current.processId=p.processId;
        const status=await deps.initialize(internal('GET',undefined,true)),s=await status.json();
        if(status.status!==200||!exact(s,['state','reservationObserved','completionObserved','manifestMatches','retryAllowed','credentialsVerified','targetHostMatches','expectedManifestSha256'])
          ||s.state!=='absence-observed'||s.reservationObserved!==false||s.completionObserved!==false||s.manifestMatches!==false||s.retryAllowed!==false||s.credentialsVerified!==false||s.targetHostMatches!==true||s.expectedManifestSha256!==MANIFEST||!valid())throw Error();
        current.ready=true;current.failed=false;
        return reply({state:'ready',databaseOid:current.oid,attempt:current.attempt,expiresAt:source.SYNTHETIC_INIT_EXPIRES_AT,retryAllowed:false},200,setCookie);
      }
      if(request.headers.get('origin')!==url.origin||!current.ready||current.used||current.failed)return reply({state:'blocked',retryAllowed:false},409);
      // Burn admission before body awaits/derivation. Bad or uncertain submissions never replay.
      current.used=true;
      if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')??''))throw Error();
      const reader=request.body?.getReader();if(!reader)throw Error();
      const chunks:Uint8Array[]=[];let size=0;
      try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>4096)throw Error();chunks.push(p.value);}}finally{await reader.cancel().catch(()=>undefined);}
      let body;const rawBody=Buffer.concat(chunks);
      try{body=JSON.parse(rawBody.toString('utf8'));}finally{rawBody.fill(0);for(const chunk of chunks)chunk.fill(0);}
      if(!exact(body,['password','confirmation'])||body.confirmation!=='CREATE_EMPTY_SYNTHETIC_DATABASE_V1'||typeof body.password!=='string'||body.password.length<10||body.password.length>256||!valid())throw Error();
      let password:string=body.password;body.password='';body=undefined;
      let material;
      try{material=await deps.derive(password);}finally{password='';}
      if(!material||!/^[a-f0-9]{128}$/.test(material.hash)||!/^[a-f0-9]{32}$/.test(material.salt)||!valid())throw Error();
      const response=await deps.initialize(internal('POST',{attempt:current.attempt,databaseOid:current.oid,processId:current.processId,confirmation:'CREATE_EMPTY_SYNTHETIC_DATABASE_V1',hash:material.hash,salt:material.salt}));
      material=undefined;
      // No password, hash or cookie is reflected. Caller treats any non-201 as uncertain.
      const result=await response.json();
      if(response.status!==201||result.status!=='confirmed'||result.retryAllowed!==false)throw Error();
      // Keep the original short-lived cookie: headers may arrive while the body
      // is lost. Only read-only reconciliation remains; used never resets.
      return reply({state:'completion-confirmed',retryAllowed:false},201);
    }catch{
      if(session)session.failed=true;
      return reply({state:'not-confirmed',retryAllowed:false},503,setCookie);
    }finally{busy=false;}
  };
}
