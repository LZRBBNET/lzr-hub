import { IxcConnectionMapper, IxcContractMapper, IxcCustomerMapper, IxcInvoiceMapper, IxcPaymentMapper, IxcPlanMapper, IxcServiceOrderMapper } from "./mappers.ts";
import { sanitizeTelemetry } from "./masking.ts";
import { ReadonlyIxcGuard } from "./guard.ts";
import { CircuitBreaker, SlidingWindowRateLimiter, TtlCache } from "./resilience.ts";
import { DirectIxcTransport, IxcTransportError, type IxcTransport } from "./transport.ts";
import type { IxcCustomerSnapshot, IxcReadOperation } from "./types.ts";

export interface IxcTrace { event:string; correlationId:string; durationMs:number; status:"success"|"failed"|"cache-hit"|"blocked"; attributes:Record<string,unknown> }
export interface IxcReadonlyOptions { mode?:"staging-readonly"|"production-readonly"; baseUrl?:string; token?:string; transport?:IxcTransport; allowedCustomerIds:string[]; timeoutMs?:number; retryLimit?:0|1; cacheTtlMs?:number; rateLimitPerMinute?:number; fetcher?:typeof fetch; trace?:(event:IxcTrace)=>void; now?:()=>number }

export class IxcReadonlyError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.name="IxcReadonlyError";this.code=code;}
}

function classifyError(error:unknown){
  if(error instanceof IxcReadonlyError)return error;
  if(error instanceof IxcTransportError)return new IxcReadonlyError(error.code);
  const message=error instanceof Error?error.message:"";
  if(/^IXC_HTTP_\d{3}$/.test(message))return new IxcReadonlyError(message);
  return new IxcReadonlyError("IXC_NETWORK_ERROR");
}

export class IxcReadonlyProvider {
  readonly mode:"staging-readonly"|"production-readonly";
  private readonly guard:ReadonlyIxcGuard; private readonly transport:IxcTransport; private readonly cache:TtlCache<IxcCustomerSnapshot>; private readonly breaker:CircuitBreaker; private readonly limiter:SlidingWindowRateLimiter; private readonly now:()=>number; private readonly options:IxcReadonlyOptions;private readonly durations=new Map<string,Record<string,number>>();
  constructor(options:IxcReadonlyOptions){this.options=options;this.mode=options.mode??"staging-readonly";this.guard=new ReadonlyIxcGuard(options.allowedCustomerIds);this.transport=options.transport??new DirectIxcTransport({baseUrl:requiredOption(options.baseUrl,"IXC_BASE_URL"),token:requiredOption(options.token,"IXC_API_TOKEN"),timeoutMs:options.timeoutMs,fetcher:options.fetcher});this.now=options.now??(()=>Date.now());this.cache=new TtlCache<IxcCustomerSnapshot>(options.cacheTtlMs??300000,this.now);this.breaker=new CircuitBreaker(3,30000,this.now);this.limiter=new SlidingWindowRateLimiter(options.rateLimitPerMinute??30,60000,this.now);}
  async testConnection(correlationId:string){await this.read("testConnection",{},correlationId);return true;}
  async getSnapshot(customerId:string,correlationId:string,force=false):Promise<IxcCustomerSnapshot>{
    this.guard.assertCustomer(customerId); const cached=!force?this.cache.get(customerId):undefined;if(cached){this.emit("ixc.snapshot",correlationId,0,"cache-hit",{customerId:"[MASKED]"});return{...cached,cache:"hit",metrics:{...cached.metrics,totalLatencyMs:0}};}this.durations.set(correlationId,{});
    const started=this.now();
    try{
      const customerRows=await this.read("getCustomer",{customerId,pageSize:1},correlationId);if(!customerRows[0])throw new Error("IXC_CUSTOMER_NOT_FOUND");
      const settled=await Promise.allSettled([
        this.read("listContracts",{customerId},correlationId),
        this.read("listInvoices",{customerId},correlationId),
        this.read("listPayments",{customerId},correlationId),
        this.read("listServiceOrders",{customerId},correlationId),
        this.read("getConnection",{customerId},correlationId),
      ]);
      const rows=(index:number)=>settled[index].status==="fulfilled"?settled[index].value:[];
      const sourceNames=["contracts","invoices","payments","serviceOrders","connection"];const contracts=rows(0).map(IxcContractMapper.map);let plan=null;let planFailed=false;
      if(contracts[0]?.planId){try{const planRows=await this.read("getPlan",{customerId,planId:contracts[0].planId,pageSize:1},correlationId);plan=planRows[0]?IxcPlanMapper.map(planRows[0]):null;if(plan&&contracts[0])contracts[0]={...contracts[0],planName:plan.name};}catch{planFailed=true;}}
      const snapshot:IxcCustomerSnapshot={customer:IxcCustomerMapper.map(customerRows[0]),contracts,plan,invoices:rows(1).map(IxcInvoiceMapper.map),payments:rows(2).map(IxcPaymentMapper.map),serviceOrders:rows(3).map(IxcServiceOrderMapper.map),connection:rows(4)[0]?IxcConnectionMapper.map(rows(4)[0]):null,partialSources:[...settled.flatMap((item,index)=>item.status==="rejected"?[sourceNames[index]]:[]),...(planFailed?["plan"]:[])],metrics:{totalLatencyMs:this.now()-started,blockLatencies:{...(this.durations.get(correlationId)??{})}},fetchedAt:new Date(this.now()).toISOString(),mode:this.mode,cache:"miss"};
      this.cache.set(customerId,snapshot);this.emit("ixc.snapshot",correlationId,this.now()-started,"success",{partial:settled.some((item)=>item.status==="rejected")});return snapshot;
    }catch(error){this.emit("ixc.snapshot",correlationId,this.now()-started,"failed",{error:error instanceof Error?error.name:"unknown"});throw error;}
  }
  invalidate(customerId:string){this.guard.assertCustomer(customerId);this.cache.delete(customerId);}
  health(){return{service:"IXC",mode:this.mode,state:this.breaker.state()==="open"?"degraded":"healthy",detail:"Somente leitura; allowlist ativa",allowlist:this.guard.listMasked()};}
  private async read(operation:IxcReadOperation,parameters:{customerId?:string;planId?:string;pageSize?:number},correlationId:string):Promise<Record<string,unknown>[]>{
    this.guard.assertOperation(operation);if(operation!=="testConnection")this.guard.assertCustomer(parameters.customerId??"");if(!this.breaker.canRequest())throw new Error("IXC_CIRCUIT_OPEN");this.limiter.assert();let last:unknown;
    const maxAttempts=1+(this.options.retryLimit??1);for(let attempt=0;attempt<maxAttempts;attempt+=1){const started=this.now();try{const result=await this.transport.execute({operation:operation as Exclude<IxcReadOperation,"findCustomer">,parameters,correlationId});this.breaker.success();this.emit(`ixc.${operation}`,correlationId,this.now()-started,"success",{count:result.records.length,transport:this.transport.kind,attempt:attempt+1});return result.records;}catch(error){last=classifyError(error);const transportError=error instanceof IxcTransportError?error:undefined;if(attempt+1<maxAttempts&&transportError?.retryable)continue;break;}}
    const failure=classifyError(last);this.breaker.failure();this.emit(`ixc.${operation}`,correlationId,0,"failed",sanitizeTelemetry({error:failure.code}) as Record<string,unknown>);throw failure;
  }
  private emit(event:string,correlationId:string,durationMs:number,status:IxcTrace["status"],attributes:Record<string,unknown>){if(event.startsWith("ixc.")&&event!=="ixc.snapshot"){const key=event.slice(4);this.durations.set(correlationId,{...(this.durations.get(correlationId)??{}),[key]:durationMs});}this.options.trace?.({event,correlationId,durationMs,status,attributes:sanitizeTelemetry(attributes) as Record<string,unknown>});}
}

function requiredOption(value:string|undefined,name:string){if(!value)throw new Error(`${name} obrigatório para transporte direto`);return value;}
