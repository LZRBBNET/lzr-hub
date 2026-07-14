import type { IxcReadonlyProvider } from "../integrations/ixc/readonly-provider.ts";
import { telemetrySummary } from "../observability/telemetry.ts";

export interface SmokeResult { operation:string;status:"success"|"failed";latencyMs:number;cache:"hit"|"miss"|"none";recordCount:number;errorCode?:string;correlationId:string }
export interface SmokeRepository { save(runId:string,results:SmokeResult[]):Promise<void>; audit(runId:string,result:string,correlationId:string):Promise<void> }

function safeErrorCode(error:unknown){const value=error instanceof Error?error.message:"";return /^IXC_[A-Z0-9_]+$/.test(value)?value:"IXC_UNKNOWN_ERROR";}

export class IxcReadonlySmokeRunner {
  private readonly provider:IxcReadonlyProvider;private readonly repository:SmokeRepository;
  constructor(provider:IxcReadonlyProvider,repository:SmokeRepository){this.provider=provider;this.repository=repository;}
  async run(customerId:string){const runId=crypto.randomUUID();const correlationId=crypto.randomUUID();const results:SmokeResult[]=[];const execute=async(operation:string,work:()=>Promise<{count:number;cache?:"hit"|"miss"}>)=>{const started=Date.now();try{const value=await work();results.push({operation,status:"success",latencyMs:Date.now()-started,cache:value.cache??"none",recordCount:value.count,correlationId});}catch(error){results.push({operation,status:"failed",latencyMs:Date.now()-started,cache:"none",recordCount:0,errorCode:safeErrorCode(error),correlationId});}};
    await execute("authentication",async()=>{await this.provider.testConnection(correlationId);return{count:1}});
    let snapshot:Awaited<ReturnType<IxcReadonlyProvider["getSnapshot"]>>|undefined;
    await execute("customer360",async()=>{snapshot=await this.provider.getSnapshot(customerId,correlationId,true);return{count:1,cache:snapshot.cache}});
    if(snapshot){results.push(...[["customer",1],["contracts",snapshot.contracts.length],["plan",snapshot.plan?1:0],["invoices",snapshot.invoices.length],["payments",snapshot.payments.length],["serviceOrders",snapshot.serviceOrders.length],["connection",snapshot.connection?1:0]].map(([operation,count])=>({operation:String(operation),status:snapshot!.partialSources.includes(String(operation))?"failed" as const:"success" as const,latencyMs:operationLatency(correlationId,String(operation)),cache:snapshot!.cache,recordCount:Number(count),correlationId})));await execute("cache",async()=>{const cached=await this.provider.getSnapshot(customerId,correlationId);return{count:1,cache:cached.cache}});}
    await this.repository.save(runId,results);await this.repository.audit(runId,results.some((item)=>item.status==="failed")?"partial":"success",correlationId);return{runId,correlationId,status:results.some((item)=>item.status==="failed")?"partial" as const:"success" as const,results};}
}

function operationLatency(correlationId:string,operation:string){const aliases:Record<string,string>={customer:"ixc.getCustomer",contracts:"ixc.listContracts",plan:"ixc.getPlan",invoices:"ixc.listInvoices",payments:"ixc.listPayments",serviceOrders:"ixc.listServiceOrders",connection:"ixc.getConnection"};const match=telemetrySummary().recent.find((item)=>item.correlationId===correlationId&&item.name===aliases[operation]);return match?.durationMs??0;}

export class MemorySmokeRepository implements SmokeRepository {readonly rows:SmokeResult[]=[];readonly audits:string[]=[];async save(_runId:string,results:SmokeResult[]){this.rows.push(...results);}async audit(runId:string,result:string,correlationId:string){this.audits.push(`${runId}:${result}:${correlationId}`);}}
