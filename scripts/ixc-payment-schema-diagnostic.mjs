import {request as httpsRequest} from 'node:https';
import {open, constants} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// A closed vocabulary prevents a malicious/dynamic JSON key from becoming PII in stdout.
const FIELDS=new Set(['id','id_receber','id_fatura','id_areceber','id_cliente','id_movimento','id_conta','conta_','credito','debito','valor','valor_liquido_recebido','valor_pago','data','data_pagamento','tipo_recebimento','forma_pagamento','historico','documento','filial_id','ultima_atualizacao','vacrescimo','vdesconto','pacrescimo','pdesconto','descontos_adicionais','id_motivo_desconto']);
const fail=()=>{throw Error('DIAGNOSTIC_STOP');};
const id=v=>typeof v==='string'&&/^[1-9]\d{0,31}$/.test(v);
const sameId=(v,expected)=>(typeof v==='string'&&v===expected)||(typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&String(v)===expected);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function diagnosticConfig(env,now=Date.now()){
  if(env.IXC_SCHEMA_DIAGNOSTIC_APPROVED!=='true')fail();
  const deadline=Date.parse(env.IXC_SCHEMA_DIAGNOSTIC_EXPIRES_AT??'');
  if(!Number.isFinite(deadline)||deadline<=now||deadline-now>15*60_000)fail();
  if(!id(env.IXC_SCHEMA_CUSTOMER_ID)||!id(env.IXC_SCHEMA_INVOICE_ID))fail();
  let base;try{base=new URL(env.IXC_BASE_URL);}catch{fail();}
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||!['','/'].includes(base.pathname)||base.origin!==env.IXC_SCHEMA_APPROVED_ORIGIN)fail();
  if(!env.IXC_API_TOKEN||/[\r\n]/.test(env.IXC_API_TOKEN)||!['GET','POST'].includes(env.IXC_HTTP_METHOD))fail();
  return {origin:base.origin,token:env.IXC_API_TOKEN,method:env.IXC_HTTP_METHOD,customerId:env.IXC_SCHEMA_CUSTOMER_ID,invoiceId:env.IXC_SCHEMA_INVOICE_ID,deadline};
}
export function projectPaymentShape(records){
  if(!Array.isArray(records)||records.length>1||records.some(r=>!object(r)))fail();
  const fields={},types=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
  let omittedFields=false;
  for(const row of records){if(Object.keys(row).length>200)fail();for(const key of Object.keys(row)){if(!FIELDS.has(key)){omittedFields=true;continue;}fields[key]=types(row[key]);}}
  return {fields:Object.fromEntries(Object.entries(fields).sort(([a],[b])=>a.localeCompare(b))),omittedFields};
}
// HTTPS only, no redirects, no retries, strict response-size and time bounds. Never log an error/body.
export function createSchemaTransport(config,{request=httpsRequest}={}){
  return (resource,payload)=>new Promise((resolve,reject)=>{
    if(!['fn_areceber','fn_movim_finan'].includes(resource))return reject(Error('DIAGNOSTIC_STOP'));
    const token=config.token.trim();
    const credential=/^\d+:[A-Fa-f0-9]{32,}$/.test(token)?Buffer.from(token).toString('base64'):token;
    const body=JSON.stringify(payload);
    const req=request(new URL(`/webservice/v1/${resource}`,config.origin),{method:config.method,headers:{Authorization:`Basic ${credential}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),ixcsoft:'listar'}},res=>{
      if(res.statusCode!==200){res.destroy();reject(Error('DIAGNOSTIC_STOP'));return;}
      let length=0;const chunks=[];
      res.on('data',chunk=>{length+=chunk.length;if(length>65536){res.destroy();reject(Error('DIAGNOSTIC_STOP'));}else chunks.push(chunk);});
      res.on('error',()=>reject(Error('DIAGNOSTIC_STOP')));
      res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('DIAGNOSTIC_STOP'));}});
    });
    const timer=setTimeout(()=>{req.destroy();reject(Error('DIAGNOSTIC_STOP'));},5000);
    req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(Error('DIAGNOSTIC_STOP')));
    req.end(body);
  });
}
export async function collectPaymentShape(config,{transport,reserve,now=Date.now}){
  const active=()=>{if(!Number.isFinite(config.deadline)||now()>=config.deadline)fail();};
  active();await reserve(); // Durable reservation BEFORE any request; never auto-delete or retry.
  const read=async(resource,qtype,query,rp)=>{active();const result=await transport(resource,{qtype,query,oper:'=',page:'1',rp:String(rp),sortname:`${resource}.id`,sortorder:'desc'});active();if(!object(result)||result.type==='error'||!Array.isArray(result.registros)||result.registros.length>rp||result.registros.some(r=>!object(r))||(result.page!==undefined&&String(result.page)!=='1'))fail();return result;};
  const ownership=async()=>{const b=await read('fn_areceber','fn_areceber.id',config.invoiceId,2);if(!['1',1].includes(b.total)||b.registros.length!==1||!sameId(b.registros[0].id,config.invoiceId)||!sameId(b.registros[0].id_cliente,config.customerId))fail();};
  await ownership();
  const payment=await read('fn_movim_finan','id_receber',config.invoiceId,1);
  const shape=projectPaymentShape(payment.registros);
  await ownership();
  return shape; // Never include total, IDs, values, raw error or source response.
}
export async function reserveOnce(path){
  if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('/tmp/')||path.startsWith('/proc/'))fail();
  const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await file.writeFile('reserved; do not retry automatically\n');await file.sync();await file.close();
}
export async function runSchemaCli(env,{transport,reserve,write=console.log}={}){
  try{const config=diagnosticConfig(env);const result=await collectPaymentShape(config,{transport:transport??createSchemaTransport(config),reserve:reserve??(()=>reserveOnce(env.IXC_SCHEMA_RESERVATION_PATH))});write(JSON.stringify(result));return 0;}
  catch{write('DIAGNOSTIC_STOP: no result confirmed; do not repeat.');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runSchemaCli(process.env);
