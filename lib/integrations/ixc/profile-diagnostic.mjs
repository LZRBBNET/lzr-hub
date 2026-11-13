// Dedicated metadata-only validation. No runtime, provider, mapper, cache or fallback.
export const PROFILE_ORIGIN='https://ixc.bbnetup.com.br';
export const PROFILE_PATHS=['/webservice/v1/cliente','/webservice/v1/cliente_contrato'];
const identifier=v=>typeof v==='string'&&/^[1-9]\d{0,31}$/.test(v);
class Refusal extends Error {constructor(category){super('PROFILE_REFUSED');this.category=category;}}
const fail=category=>{throw new Refusal(category);};
const count=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&Number.isSafeInteger(Number(v))?Number(v):null;
export function profileConfiguration(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='customerId,origin,scope'||value.origin!==PROFILE_ORIGIN||!identifier(value.customerId)||!['customer','customer-contracts'].includes(value.scope))fail('configuration');
 return Object.freeze({...value});
}
export async function diagnoseProfile(input,transport){
 let calls=0;const result={outcome:'rejected',calls:0,customerConfirmed:false,contracts:{state:'not-requested',count:null,complete:false},finance:{state:'not-requested'},payments:{state:'not-requested'},serviceOrders:{state:'not-requested'},connection:{state:'not-requested'}};
 try{
  const config=profileConfiguration(input),cap=config.scope==='customer'?1:3;
  async function read(resource,qtype,rp){
   if(calls>=cap||!['cliente','cliente_contrato'].includes(resource))fail('scope');calls++;
   const response=await transport(PROFILE_ORIGIN+'/webservice/v1/'+resource,{method:'GET',headers:{'ixcsoft':'listar','Content-Type':'application/json','Accept':'application/json','Accept-Encoding':'identity'},body:JSON.stringify({qtype,query:config.customerId,oper:'=',page:'1',rp:String(rp),sortname:resource+'.id',sortorder:'desc'})});
   if(response.status!==200)fail('http');
   const type=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
   if(!['application/json','text/x-json'].includes(type)||!['','identity'].includes((response.headers.get('content-encoding')??'').toLowerCase()))fail('response-type');
   let body;try{body=await response.json();}catch{fail('json');}
   if(!body||typeof body!=='object'||Array.isArray(body)||body.type==='error'||!Array.isArray(body.registros)||body.registros.length>rp||!body.registros.every(r=>r&&typeof r==='object'&&!Array.isArray(r)))fail('envelope');
   if(body.page!==undefined&&count(body.page)!==1)fail('page');
   const total=body.total===undefined?null:count(body.total);if(body.total!==undefined&&total===null)fail('coverage');
   if(total!==null&&(total<body.registros.length||body.registros.length!==Math.min(total,rp)))fail('coverage');
   return {rows:body.registros,total};
  }
  async function customer(){const page=await read('cliente','cliente.id',2);if(page.total!==1||page.rows.length!==1||page.rows[0].id!==config.customerId)fail('customer-identity');}
  await customer();
  if(config.scope==='customer-contracts'){
   result.contracts.state='unconfirmed';
   const page=await read('cliente_contrato','cliente_contrato.id_cliente',20);const ids=new Set();
   for(const row of page.rows){if(!identifier(row.id)||row.id_cliente!==config.customerId||ids.has(row.id))fail('contract-ownership');ids.add(row.id);}
   await customer();
   result.contracts={state:'observed',count:page.rows.length,complete:page.total!==null&&page.total===page.rows.length};
  }
  result.customerConfirmed=true;result.outcome='accepted';
 }catch(error){result.outcome='rejected';result.category=error instanceof Refusal?error.category:error?.name==='AbortError'?'timeout':'transport';}
 return {...result,calls};
}
