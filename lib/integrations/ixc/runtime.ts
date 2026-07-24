import { loadRuntimeConfig } from "../../runtime/environment.ts";
import { recordTelemetry } from "../../observability/telemetry.ts";
import { IxcReadonlyProvider } from "./readonly-provider.ts";
import { DirectIxcTransport, RelayIxcTransport } from "./transport.ts";

let runtime:ReturnType<typeof create>|undefined;
function create(){const config=loadRuntimeConfig();if(config.ixcTransport==="disabled")return{config,provider:undefined};const transport=config.ixcTransport==="relay"?new RelayIxcTransport({relayUrl:config.ixcRelayUrl!,hmacSecret:config.ixcRelayHmacSecret!,accessClientId:config.cfAccessClientId!,accessClientSecret:config.cfAccessClientSecret!,timeoutMs:config.ixcTimeoutMs}):new DirectIxcTransport({baseUrl:config.ixcBaseUrl!,token:config.ixcToken!,timeoutMs:config.ixcTimeoutMs});const provider=new IxcReadonlyProvider({mode:config.ixcMode==="production-readonly"?"production-readonly":"staging-readonly",transport,allowedCustomerIds:config.ixcAllowlist,timeoutMs:config.ixcTimeoutMs,retryLimit:config.ixcTransport==="relay"?0:config.ixcRetryLimit as 0|1,cacheTtlMs:config.ixcCacheTtlSeconds*1000,rateLimitPerMinute:config.ixcRateLimitPerMinute,trace:(event)=>recordTelemetry({name:event.event,correlationId:event.correlationId,status:event.status,durationMs:event.durationMs,provider:"IXC",cache:event.status==="cache-hit"?"hit":event.event==="ixc.snapshot"?"miss":undefined,attributes:event.attributes})});return{config,provider};}
export function getIxcRuntime(){return runtime??=create();}
