import { sanitizeTelemetry } from "../integrations/ixc/masking.ts";

export interface TelemetryEvent { name:string; correlationId:string; status:string; durationMs?:number; provider?:string; cache?:"hit"|"miss"; attributes?:Record<string,unknown>; at:string }
const events:TelemetryEvent[]=[];
export function recordTelemetry(event:Omit<TelemetryEvent,"at">){const safe={...event,attributes:sanitizeTelemetry(event.attributes??{}) as Record<string,unknown>,at:new Date().toISOString()};events.push(safe);if(events.length>200)events.shift();console.info(JSON.stringify({level:"info",...safe}));}
export function telemetrySummary(){const total=events.length;const failures=events.filter((event)=>event.status==="failed").length;const hits=events.filter((event)=>event.cache==="hit").length;const misses=events.filter((event)=>event.cache==="miss").length;const latencies=events.flatMap((event)=>typeof event.durationMs==="number"?[event.durationMs]:[]);return{total,failures,cacheHitRate:hits+misses?Math.round(hits/(hits+misses)*100):0,averageLatencyMs:latencies.length?Math.round(latencies.reduce((sum,value)=>sum+value,0)/latencies.length):0,recent:events.slice(-20).reverse()};}
