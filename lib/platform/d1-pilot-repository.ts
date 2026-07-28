import { getPool } from "../../db/index";
import type { PilotEvent, PilotRepository } from "./pilot-service";

export class D1PilotRepository implements PilotRepository {
  async save(event:PilotEvent){const pool=getPool();await pool.query("INSERT INTO pilot_events (id,event_type,module,severity,description_sanitized,steps_sanitized,expected_sanitized,actual_sanitized,screenshot_ref,participant_alias,metric_name,metric_value,status,owner_role,correlation_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",[event.id,event.eventType,event.module,event.severity??"info",event.description,event.steps??null,event.expected??null,event.actual??null,event.screenshotRef??null,event.participantAlias,event.metricName??null,event.metricValue??null,event.status??"open",event.ownerRole??null,event.correlationId,event.createdAt,event.updatedAt]);}
  async summary(){const pool=getPool();const result=await pool.query<{event_type:string;total:string}>("SELECT event_type, COUNT(*) AS total FROM pilot_events GROUP BY event_type");return Object.fromEntries(result.rows.map((row)=>[row.event_type,Number(row.total)]));}
}
