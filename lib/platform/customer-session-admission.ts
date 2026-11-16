"use client";

export type CustomerSession = { unavailable?: boolean; authenticated: boolean; authRequired: boolean; mustChangePassword?: boolean; permissions?: string[]; user?: { id?: string; name: string; email: string; role: string } };
export type CustomerReadAccess = { generation: number; current: (generation:number)=>boolean; revalidate: (generation:number,originCurrent:()=>boolean)=>Promise<void> };
type AdmissionRequest={generation:number;initial:boolean;origins:Set<()=>boolean>;controller:AbortController;promise:Promise<void>};
type Snapshot = { session:CustomerSession|null; generation:number; context:number };

/** One shell instance, one admission endpoint. No tokens, persistence, broadcasts or operation retries. */
export function createCustomerSessionAdmission(options: { fetchSession?:(signal:AbortSignal)=>Promise<Response>; onInvalid?:()=>void } = {}) {
  const initial:Snapshot={session:null,generation:0,context:0};
  let snapshot=initial,active=false,closed=false;
  let pending:AdmissionRequest|undefined;
  const listeners=new Set<()=>void>();
  const current=(generation:number)=>active&&!closed&&snapshot.generation===generation;
  const publish=(next:Snapshot)=>{snapshot=next;for(const listener of listeners){try{listener();}catch{/* Observation never grants admission. */}}};
  const identity=(s:CustomerSession|null)=>s===null?null:JSON.stringify([s.authRequired,s.authenticated,!!s.unavailable,s.user?.id??null,s.user?.role??null,[...(s.permissions??[])].sort(),!!s.mustChangePassword]);
  function accept(session:CustomerSession,generation:number){
    if(!current(generation))return;
    const next={session,generation:generation+1,context:snapshot.context+(snapshot.session!==null&&identity(snapshot.session)!==identity(session)?1:0)};
    publish(next);
    if(current(next.generation)&&!session.unavailable&&session.authRequired&&!session.authenticated)options.onInvalid?.();
  }
  const originCurrent=(origin:()=>boolean)=>{try{return origin();}catch{return false;}};
  const hasOrigin=(request:AdmissionRequest)=>request.initial||[...request.origins].some(originCurrent);
  const live=(request:AdmissionRequest)=>pending===request&&current(request.generation)&&!request.controller.signal.aborted&&hasOrigin(request);
  function load(generation:number,initialRead=false,origin:()=>boolean=()=>true):Promise<void>{
    if(!current(generation)||!originCurrent(origin))return Promise.resolve();
    if(pending?.generation===generation&&hasOrigin(pending)){pending.origins.add(origin);return pending.promise;}
    pending?.controller.abort();
    const request:AdmissionRequest={generation,initial:initialRead,origins:new Set([origin]),controller:new AbortController(),promise:Promise.resolve()};pending=request;
    request.promise=(async()=>{
      try{
        const response=await(options.fetchSession??(signal=>fetch('/api/auth/me',{cache:'no-store',signal})))(request.controller.signal);
        if(!live(request))return;
        if(!response.ok)throw Error('SESSION_UNAVAILABLE');
        const data=await response.json() as CustomerSession;
        if(!live(request))return;
        if(!data||typeof data.authenticated!=='boolean'||typeof data.authRequired!=='boolean'
          ||(data.permissions!==undefined&&(!Array.isArray(data.permissions)||data.permissions.some(p=>typeof p!=='string')))
          ||(data.user!==undefined&&(!data.user||typeof data.user.name!=='string'||typeof data.user.email!=='string'||typeof data.user.role!=='string'))
          ||(!initialRead&&data.authenticated&&(typeof data.user?.id!=='string'||!data.user.id)))throw Error('SESSION_UNAVAILABLE');
        accept(data,generation);
      }catch{if(live(request))accept({unavailable:true,authenticated:false,authRequired:true,permissions:[]},generation);}
      finally{if(pending===request)pending=undefined;}
    })();
    return request.promise;
  }
  return {
    snapshot:()=>snapshot,serverSnapshot:()=>initial,current,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    start:()=>{if(closed||active)return Promise.resolve();active=true;return load(snapshot.generation,true);},
    revalidate:(generation:number,origin:()=>boolean=()=>true)=>load(generation,false,origin),
    close:()=>{if(closed)return;closed=true;pending?.controller.abort();publish({...snapshot,generation:snapshot.generation+1});},
    stop:()=>{active=false;pending?.controller.abort();snapshot={...snapshot,generation:snapshot.generation+1};},
  };
}
