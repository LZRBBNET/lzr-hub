import {diagnosticConfig} from '../../scripts/ixc-payment-schema-diagnostic.mjs';

export const PAYMENT_SCHEMA_RESERVATION_ID='ixc-payment-schema-once-v1';
const headers={'cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const reply=(status:number,body:Record<string,unknown>)=>Response.json(body,{status,headers});
type Env=Record<string,string|undefined>;
type User={id:string;role:string};
type Config=ReturnType<typeof diagnosticConfig>;
export type SchemaWebDependencies={
  env:()=>Env; now?:()=>number;
  authorize:(request:Request)=>Promise<{allowed:boolean;user?:User}>;
  reserve:()=>Promise<boolean>;
  complete:()=>Promise<void>;
  status:()=>Promise<'unused'|'reserved'|'completed'|'unverified'>;
  collect:(config:Config,reserve:()=>Promise<void>)=>Promise<unknown>;
};
function config(env:Env,now:number){
  if(env.IXC_SCHEMA_WEB_ENABLED!=='true'||env.FEATURE_AUTH!=='true')throw Error('OFF');
  const start=Date.parse(env.IXC_SCHEMA_WEB_STARTED_AT??'');
  const expires=Date.parse(env.IXC_SCHEMA_DIAGNOSTIC_EXPIRES_AT??'');
  if(!Number.isFinite(start)||now<start||expires-start>900000||expires<=start)throw Error('OFF');
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(env.IXC_SCHEMA_WEB_OPERATOR_ID??''))throw Error('OFF');
  const origin=new URL(env.IXC_SCHEMA_WEB_ORIGIN??'');
  if(origin.protocol!=='https:'||origin.origin!==env.IXC_SCHEMA_WEB_ORIGIN)throw Error('OFF');
  return {read:diagnosticConfig(env,now),origin:origin.origin,operatorId:env.IXC_SCHEMA_WEB_OPERATOR_ID};
}
export function createPaymentSchemaWebDiagnostic(deps:SchemaWebDependencies){
  return async(request:Request):Promise<Response>=>{
    let settings;try{settings=config(deps.env(),(deps.now??Date.now)());}catch{return reply(404,{error:'Indisponível.'});}
    const url=new URL(request.url);
    if(url.origin!==settings.origin||url.search||request.headers.get('sec-fetch-site')!=='same-origin')return reply(403,{error:'Solicitação bloqueada.'});
    if(request.method!=='GET'&&request.method!=='POST')return reply(405,{error:'Método bloqueado.'});
    let guard;try{guard=await deps.authorize(request);}catch{return reply(401,{error:'Autenticação obrigatória.'});}
    if(!guard.allowed||!guard.user)return reply(401,{error:'Autenticação obrigatória.'});
    if(guard.user.role!=='Administrador'||guard.user.id!==settings.operatorId)return reply(403,{error:'Operador não autorizado.'});
    if(request.method==='GET'){
      // Status never touches IXC and never contains the collected shape or target identifiers.
      try{return reply(200,{state:await deps.status(),retryAllowed:false});}catch{return reply(503,{state:'unverified',retryAllowed:false});}
    }
    if(request.headers.get('origin')!==settings.origin||request.headers.get('x-lzr-diagnostic-action')!=='collect-shape')return reply(403,{error:'Solicitação bloqueada.'});
    // No client-supplied targets, body, arbitrary resource or URL. Header absence cannot hide chunked content.
    if(request.body!==null)return reply(400,{error:'Corpo não permitido.'});
    try{
      const result=await deps.collect(settings.read,async()=>{
        if(!await deps.reserve())throw Error('RESERVED');
      });
      await deps.complete();
      if((deps.now??Date.now)()>=settings.read.deadline)throw Error('EXPIRED');
      return reply(200,{shape:result,retryAllowed:false});
    }catch{return reply(503,{error:'Diagnóstico sem confirmação. Não repetir.',retryAllowed:false});}
  };
}
