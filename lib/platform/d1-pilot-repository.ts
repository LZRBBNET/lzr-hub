import { getD1 } from "../../db/index";
import type { PilotEvent, PilotRepository } from "./pilot-service";

export class D1PilotRepository implements PilotRepository {
  async save(event:PilotEvent){const db=await getD1();await db.prepare("INSERT INTO pilot_events (id,event_type,module,severity,description_sanitized,steps_sanitized,expected_sanitized,actual_sanitized,screenshot_ref,participant_alias,metric_name,metric_value,status,owner_role,correlation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(event.id,event.eventType,event.module,event.severity??"info",event.description,event.steps??null,event.expected??null,event.actual??null,event.screenshotRef??null,event.participantAlias,event.metricName??null,event.metricValue??null,event.status??"open",event.ownerRole??null,event.correlationId,event.createdAt,event.updatedAt).run();}
  async summary(){const db=await getD1();const result=await db.prepare("SELECT event_type, COUNT(*) AS total FROM pilot_events GROUP BY event_type").all<{event_type:string;total:number}>();return Object.fromEntries(result.results.map((row)=>[row.event_type,row.total]));}
}
