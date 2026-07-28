import { getPool } from "../../db/index";
import type { SmokeRepository, SmokeResult } from "./ixc-smoke";

export class D1SmokeRepository implements SmokeRepository {
  async save(runId:string,results:SmokeResult[]){const pool=getPool();for(const item of results)await pool.query("INSERT INTO ixc_smoke_results (id,run_id,operation,status,latency_ms,cache_state,record_count,error_code,correlation_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[crypto.randomUUID(),runId,item.operation,item.status,item.latencyMs,item.cache,item.recordCount,item.errorCode??null,item.correlationId,new Date().toISOString()]);}
  async audit(runId:string,result:string,correlationId:string){const pool=getPool();await pool.query("INSERT INTO audit_events (id,actor_id,role,action,entity,after_masked,reason,correlation_id,result,origin,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[crypto.randomUUID(),"system","system","ixc.readonly.smoke",`smoke:${runId.slice(0,8)}`,"[SEM PII]","Smoke test somente leitura",correlationId,result,"human",new Date().toISOString()]);}
}
