import { getSyntheticInvoiceDemo } from './synthetic-demo.ts';
import { loadRuntimeConfig } from "../../runtime/environment.ts";
import { recordTelemetry } from "../../observability/telemetry.ts";
import { createIxcFetcher, resolveIxcHttpMethod } from "./http.ts";
import { IxcReadonlyProvider } from "./readonly-provider.ts";

let runtime:ReturnType<typeof create>|undefined;
function create(){const config=loadRuntimeConfig();if(config.ixcMode!=="staging-readonly")return{config,provider:undefined};const provider=new IxcReadonlyProvider({baseUrl:config.ixcBaseUrl!,token:config.ixcToken!,allowedCustomerIds:config.ixcAllowlist,fullBase:config.ixcFullBase,timeoutMs:config.ixcTimeoutMs,retryLimit:config.ixcRetryLimit as 0|1,cacheTtlMs:config.ixcCacheTtlSeconds*1000,rateLimitPerMinute:config.ixcRateLimitPerMinute,fetcher:createIxcFetcher(resolveIxcHttpMethod(process.env.IXC_HTTP_METHOD)),trace:(event)=>recordTelemetry({name:event.event,correlationId:event.correlationId,status:event.status,durationMs:event.durationMs,provider:"IXC",cache:event.status==="cache-hit"?"hit":event.event==="ixc.snapshot"?"miss":undefined,attributes:event.attributes})});return{config,provider};}
export function getIxcRuntime(){
  if(process.env.FEATURE_SYNTHETIC_INVOICES!==undefined&&process.env.FEATURE_SYNTHETIC_INVOICES!=="false"){
    const demo=getSyntheticInvoiceDemo();const config=loadRuntimeConfig();
    return {config:{...config,ixcAllowlist:["10"],ixcFullBase:false},provider:demo.provider};
  }
  return runtime??=create();
}
