export type PilotEventType="metric"|"feedback"|"bug"|"suggestion";
export interface PilotInput {eventType:PilotEventType;module:string;severity?:"info"|"low"|"medium"|"high"|"critical";description:string;steps?:string;expected?:string;actual?:string;screenshotRef?:string;metricName?:string;metricValue?:number;status?:"open"|"triaged"|"resolved";ownerRole?:"atendente"|"supervisor"|"ti"}
export interface PilotEvent extends PilotInput {id:string;participantAlias:string;correlationId:string;createdAt:string;updatedAt:string;description:string}
export interface PilotRepository {save(event:PilotEvent):Promise<void>;summary():Promise<Record<string,number>>}
const metricNames=new Set(["customer_lookup_ms","customer360_load_ms","ixc_latency_ms","cache_hit","ixc_error","timeout","circuit_open","allowlist_block","partial_failure","ai_repetition","handoff","satisfaction"]);
export function sanitizePilotText(value=""){return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[EMAIL REDACTED]").replace(/\b\d{10,14}\b/g,"[NÚMERO REDACTED]").replace(/\b(?:rua|avenida|av\.|travessa)\s+[^,.;\n]+/gi,"[ENDEREÇO REDACTED]").slice(0,2000);}

export class PilotService {
  private readonly repository:PilotRepository;private readonly users:string[];
  constructor(repository:PilotRepository,users:string[]){if(users.length<2||users.length>3)throw new Error("Piloto exige 2 a 3 usuários");this.repository=repository;this.users=users;}
  alias(userId:string){const index=this.users.indexOf(userId);if(index<0)throw new Error("PILOT_USER_NOT_ALLOWED");return`pilot-user-${index+1}`;}
  async record(userId:string,input:PilotInput){if(!["metric","feedback","bug","suggestion"].includes(input.eventType))throw new Error("PILOT_EVENT_INVALID");if(input.eventType==="metric"&&(!input.metricName||!metricNames.has(input.metricName)||!Number.isFinite(input.metricValue)))throw new Error("PILOT_METRIC_INVALID");if(input.screenshotRef&&!input.screenshotRef.startsWith("sanitized://"))throw new Error("PILOT_SCREENSHOT_NOT_SANITIZED");const now=new Date().toISOString();const event:PilotEvent={...input,id:crypto.randomUUID(),participantAlias:this.alias(userId),correlationId:crypto.randomUUID(),description:sanitizePilotText(input.description),steps:input.steps?sanitizePilotText(input.steps):undefined,expected:input.expected?sanitizePilotText(input.expected):undefined,actual:input.actual?sanitizePilotText(input.actual):undefined,createdAt:now,updatedAt:now};await this.repository.save(event);return event;}
  summary(){return this.repository.summary();}
}

export class MemoryPilotRepository implements PilotRepository {readonly events:PilotEvent[]=[];async save(event:PilotEvent){this.events.push(event);}async summary(){return this.events.reduce<Record<string,number>>((totals,event)=>{totals[event.eventType]=(totals[event.eventType]??0)+1;return totals;},{});}}
