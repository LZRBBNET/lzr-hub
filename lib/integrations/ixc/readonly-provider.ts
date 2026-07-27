import { IxcConnectionMapper, IxcContractMapper, IxcCustomerMapper, IxcInvoiceMapper, IxcPaymentMapper, IxcPlanMapper, IxcServiceOrderMapper } from "./mappers.ts";
import { sanitizeTelemetry } from "./masking.ts";
import { ReadonlyIxcGuard } from "./guard.ts";
import { CircuitBreaker, SlidingWindowRateLimiter, TtlCache } from "./resilience.ts";
import type { IxcCustomerSnapshot, IxcListResponse, IxcReadOperation } from "./types.ts";

const endpoints:Record<Exclude<IxcReadOperation,"testConnection"|"findCustomer"|"getCustomer">,string>={listContracts:"cliente_contrato",getPlan:"vd_contratos",listInvoices:"fn_areceber",listPayments:"fn_movim_finan",listServiceOrders:"su_oss_chamado",getConnection:"radusuarios",getCity:"cidade"};
export interface IxcTrace { event:string; correlationId:string; durationMs:number; status:"success"|"failed"|"cache-hit"|"blocked"; attributes:Record<string,unknown> }
export interface IxcReadonlyOptions { baseUrl:string; token:string; allowedCustomerIds:string[]; timeoutMs?:number; retryLimit?:0|1; cacheTtlMs?:number; cityCacheTtlMs?:number; rateLimitPerMinute?:number; fetcher?:typeof fetch; trace?:(event:IxcTrace)=>void; now?:()=>number }

export class IxcReadonlyError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.name="IxcReadonlyError";this.code=code;}
}

function classifyError(error:unknown){
  if(error instanceof IxcReadonlyError)return error;
  if(error instanceof DOMException&&error.name==="AbortError")return new IxcReadonlyError("IXC_TIMEOUT");
  const message=error instanceof Error?error.message:"";
  if(/^IXC_HTTP_\d{3}$/.test(message))return new IxcReadonlyError(message);
  return new IxcReadonlyError("IXC_NETWORK_ERROR");
}

function apiError(body:IxcListResponse){
  const value=body as IxcListResponse&{type?:unknown;message?:unknown};
  if(value.type!=="error")return undefined;
  const message=String(value.message??"").toLocaleLowerCase("pt-BR");
  if(message.includes("ip")&&(message.includes("liberad")||message.includes("permitid")))return new IxcReadonlyError("IXC_IP_NOT_ALLOWED");
  if(message.includes("token")||message.includes("autentica")||message.includes("login"))return new IxcReadonlyError("IXC_AUTHENTICATION_FAILED");
  if(message.includes("permiss"))return new IxcReadonlyError("IXC_PERMISSION_DENIED");
  return new IxcReadonlyError("IXC_API_ERROR");
}

function basicCredential(token:string){
  const value=token.trim();
  return /^\d+:[A-Fa-f0-9]{32,}$/.test(value)?btoa(value):value;
}

export class IxcReadonlyProvider {
  readonly mode="staging-readonly" as const;
  private readonly guard:ReadonlyIxcGuard; private readonly fetcher:typeof fetch; private readonly timeoutMs:number; private readonly cache:TtlCache<IxcCustomerSnapshot>; private readonly cityCache:TtlCache<string>; private readonly breaker:CircuitBreaker; private readonly limiter:SlidingWindowRateLimiter; private readonly now:()=>number; private readonly options:IxcReadonlyOptions;private readonly durations=new Map<string,Record<string,number>>();
  constructor(options:IxcReadonlyOptions){this.options=options;this.guard=new ReadonlyIxcGuard(options.allowedCustomerIds);this.fetcher=options.fetcher??fetch;this.timeoutMs=options.timeoutMs??3500;this.now=options.now??(()=>Date.now());this.cache=new TtlCache<IxcCustomerSnapshot>(options.cacheTtlMs??300000,this.now);this.cityCache=new TtlCache<string>(options.cityCacheTtlMs??86400000,this.now);this.breaker=new CircuitBreaker(3,30000,this.now);this.limiter=new SlidingWindowRateLimiter(options.rateLimitPerMinute??30,60000,this.now);}
  async testConnection(correlationId:string){await this.read("testConnection","cliente","id","0",correlationId,1);return true;}
  async getSnapshot(customerId:string,correlationId:string,force=false):Promise<IxcCustomerSnapshot>{
    this.guard.assertCustomer(customerId); const cached=!force?this.cache.get(customerId):undefined;if(cached){this.emit("ixc.snapshot",correlationId,0,"cache-hit",{customerId:"[MASKED]"});return{...cached,cache:"hit",metrics:{...cached.metrics,totalLatencyMs:0}};}this.durations.set(correlationId,{});
    const started=this.now();
    try{
      const customerRows=await this.read("getCustomer","cliente","id",customerId,correlationId,1);if(!customerRows[0])throw new Error("IXC_CUSTOMER_NOT_FOUND");
      const settled=await Promise.allSettled([
        this.read("listContracts",endpoints.listContracts,"id_cliente",customerId,correlationId),
        this.read("listInvoices",endpoints.listInvoices,"id_cliente",customerId,correlationId),
        this.read("listPayments",endpoints.listPayments,"id_cliente",customerId,correlationId),
        this.read("listServiceOrders",endpoints.listServiceOrders,"id_cliente",customerId,correlationId),
        this.read("getConnection",endpoints.getConnection,"id_cliente",customerId,correlationId),
      ]);
      const rows=(index:number)=>settled[index].status==="fulfilled"?settled[index].value:[];
      const sourceNames=["contracts","invoices","payments","serviceOrders","connection"];const contracts=rows(0).map(IxcContractMapper.map);let plan=null;let planFailed=false;
      if(contracts[0]?.planId){try{const planRows=await this.read("getPlan",endpoints.getPlan,"id",contracts[0].planId,correlationId,1,customerId);plan=planRows[0]?IxcPlanMapper.map(planRows[0]):null;if(plan&&contracts[0])contracts[0]={...contracts[0],planName:plan.name};}catch{planFailed=true;}}
      let customer=IxcCustomerMapper.map(customerRows[0]);
      const cityCode=String(customerRows[0].cidade??"").trim();
      if(cityCode){const cityName=await this.resolveCityName(cityCode,correlationId,customerId);if(cityName)customer={...customer,city:cityName};}
      const snapshot:IxcCustomerSnapshot={customer,contracts,plan,invoices:rows(1).map(IxcInvoiceMapper.map),payments:rows(2).map(IxcPaymentMapper.map),serviceOrders:rows(3).map(IxcServiceOrderMapper.map),connection:rows(4)[0]?IxcConnectionMapper.map(rows(4)[0]):null,partialSources:[...settled.flatMap((item,index)=>item.status==="rejected"?[sourceNames[index]]:[]),...(planFailed?["plan"]:[])],metrics:{totalLatencyMs:this.now()-started,blockLatencies:{...(this.durations.get(correlationId)??{})}},fetchedAt:new Date(this.now()).toISOString(),mode:"staging-readonly",cache:"miss"};
      this.cache.set(customerId,snapshot);this.emit("ixc.snapshot",correlationId,this.now()-started,"success",{partial:settled.some((item)=>item.status==="rejected")});return snapshot;
    }catch(error){this.emit("ixc.snapshot",correlationId,this.now()-started,"failed",{error:error instanceof Error?error.name:"unknown"});throw error;}
  }
  invalidate(customerId:string){this.guard.assertCustomer(customerId);this.cache.delete(customerId);}
  private async resolveCityName(cityCode:string,correlationId:string,customerId:string):Promise<string|undefined>{
    const cached=this.cityCache.get(cityCode);if(cached)return cached;
    try{
      const rows=await this.read("getCity",endpoints.getCity,"id",cityCode,correlationId,1,customerId);
      const raw=rows[0] as Record<string,unknown>|undefined;if(!raw)return undefined;
      const name=["nome","cidade","descricao"].map((key)=>raw[key]).find((value)=>value!==undefined&&value!==null&&String(value).trim());
      if(!name)return undefined;
      const value=String(name).trim();this.cityCache.set(cityCode,value);return value;
    }catch{return undefined;}
  }
  health(){return{service:"IXC",mode:this.mode,state:this.breaker.state()==="open"?"degraded":"healthy",detail:"Somente leitura; allowlist ativa",allowlist:this.guard.listMasked()};}
  private async read(operation:IxcReadOperation,resource:string,qtype:string,query:string,correlationId:string,rp=20,authorizedCustomerId=query):Promise<Record<string,unknown>[]>{
    this.guard.assertOperation(operation);if(operation!=="testConnection")this.guard.assertCustomer(authorizedCustomerId);if(!this.breaker.canRequest())throw new Error("IXC_CIRCUIT_OPEN");this.limiter.assert();
    const url=`${this.options.baseUrl.replace(/\/$/,"")}/webservice/v1/${resource}`;let last:unknown;
    const maxAttempts=1+(this.options.retryLimit??1);for(let attempt=0;attempt<maxAttempts;attempt+=1){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),this.timeoutMs);const started=this.now();try{const response=await this.fetcher(url,{method:"POST",headers:{Authorization:`Basic ${basicCredential(this.options.token)}`,"Content-Type":"application/json","ixcsoft":"listar","x-correlation-id":correlationId},body:JSON.stringify({qtype,query,oper:"=",page:"1",rp:String(rp),sortname:"id",sortorder:"asc"}),signal:controller.signal});clearTimeout(timer);if(!response.ok){const retry=response.status===429||response.status>=500;if(retry&&attempt+1<maxAttempts){last=new IxcReadonlyError(`IXC_HTTP_${response.status}`);continue}throw new IxcReadonlyError(`IXC_HTTP_${response.status}`)}const body=await response.json() as IxcListResponse;const contractError=apiError(body);if(contractError)throw contractError;const records=Array.isArray(body.registros)?body.registros.filter((item):item is Record<string,unknown>=>!!item&&typeof item==="object"):[];this.breaker.success();this.emit(`ixc.${operation}`,correlationId,this.now()-started,"success",{count:records.length});return records;}catch(error){clearTimeout(timer);last=classifyError(error);if(attempt+1<maxAttempts&&(last as IxcReadonlyError).code==="IXC_TIMEOUT")continue;break;}}
    const failure=classifyError(last);this.breaker.failure();this.emit(`ixc.${operation}`,correlationId,0,"failed",sanitizeTelemetry({error:failure.code}) as Record<string,unknown>);throw failure;
  }
  private emit(event:string,correlationId:string,durationMs:number,status:IxcTrace["status"],attributes:Record<string,unknown>){if(event.startsWith("ixc.")&&event!=="ixc.snapshot"){const key=event.slice(4);this.durations.set(correlationId,{...(this.durations.get(correlationId)??{}),[key]:durationMs});}this.options.trace?.({event,correlationId,durationMs,status,attributes:sanitizeTelemetry(attributes) as Record<string,unknown>});}
}
