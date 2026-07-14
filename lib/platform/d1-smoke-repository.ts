import { getD1 } from "../../db/index";
import type { SmokeRepository, SmokeResult } from "./ixc-smoke";

export class D1SmokeRepository implements SmokeRepository {
  async save(runId:string,results:SmokeResult[]){const db=await getD1();for(const item of results)await db.prepare("INSERT INTO ixc_smoke_results (id,run_id,operation,status,latency_ms,cache_state,record_count,error_code,correlation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),runId,item.operation,item.status,item.latencyMs,item.cache,item.recordCount,item.errorCode??null,item.correlationId,new Date().toISOString()).run();}
  async audit(runId:string,result:string,correlationId:string){const db=await getD1();await db.prepare("INSERT INTO audit_events (id,actor_id,role,action,entity,after_masked,reason,correlation_id,result,origin,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),"system","system","ixc.readonly.smoke",`smoke:${runId.slice(0,8)}`,"[SEM PII]","Smoke test somente leitura",correlationId,result,"human",new Date().toISOString()).run();}
}
