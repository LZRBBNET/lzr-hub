import { createHash } from 'node:crypto';
import { assertSyntheticWebDatabase } from '../runtime/synthetic-web.ts';
import { EMPTY_SQL, RESERVED_EMPTY_SQL } from './synthetic-inspection-sql.ts';
import manifest from './synthetic-schema-manifest.json' with { type: 'json' };

type Source = Record<string, string | undefined>;
export const MAX_INSPECTION_MS = 20000;
export const IDENTITY_ONLY_SQL = `SELECT current_database() AS database, current_user AS owner,
 (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS oid`;
export const TABLES_SQL = `SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relrowsecurity AS rls
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname='public' AND c.relname IN ('synthetic_init_reservation','synthetic_init_completion'))
 OR (n.nspname='drizzle' AND c.relname='__drizzle_migrations') LIMIT 4`;
export const RESERVATION_SQL = 'SELECT CASE WHEN length(attempt)<=79 THEN attempt END AS attempt,CASE WHEN length(manifest)=64 THEN manifest END AS manifest,CASE WHEN length(created_at)=24 THEN created_at END AS stamp FROM public.synthetic_init_reservation LIMIT 2';
export const COMPLETION_SQL = 'SELECT CASE WHEN length(attempt)<=79 THEN attempt END AS attempt,CASE WHEN length(manifest)=64 THEN manifest END AS manifest,CASE WHEN length(completed_at)=24 THEN completed_at END AS stamp FROM public.synthetic_init_completion LIMIT 2';
export const JOURNAL_SQL = `SELECT CASE WHEN length(hash)=64 THEN hash END AS hash,CASE WHEN length(created_at::text)<=16 THEN created_at::text END AS stamp FROM drizzle.__drizzle_migrations ORDER BY id LIMIT ${manifest.length+1}`;
export type InspectionConfig = { mode:'identify'|'inspect'; host:string; database:string; user:string; password:string; oid?:string; expires:number };
export type InspectionDiagnosticPhase = 'worker-start'|'connect'|'transaction'|'identity'|'catalog'|'reservation'|'completion'|'journal'|'close'|'ipc';
export type InspectionDiagnosticReason = 'setup-failed'|'connection-failed'|'query-failed'|'deadline'|'identity-mismatch'|'unexpected-shape'|'unexpected-structure'|'marker-mismatch'|'journal-mismatch'|'close-failed'|'child-failed'|'missing-message'|'invalid-message';
const diagnosticPairs: Readonly<Record<InspectionDiagnosticPhase, readonly InspectionDiagnosticReason[]>> = {
 'worker-start':['setup-failed'],connect:['connection-failed'],
 transaction:['query-failed','deadline','unexpected-shape'],
 identity:['query-failed','deadline','unexpected-shape','identity-mismatch'],
 catalog:['query-failed','deadline','unexpected-shape','unexpected-structure'],
 reservation:['query-failed','deadline','unexpected-shape','marker-mismatch'],
 completion:['query-failed','deadline','unexpected-shape','marker-mismatch'],
 journal:['query-failed','deadline','unexpected-shape','journal-mismatch'],
 close:['close-failed'],ipc:['child-failed','missing-message','invalid-message'],
};
/** A phase and reason are an exact closed pair, never arbitrary error text. */
export function isInspectionDiagnostic(phase:unknown,reason:unknown):boolean {
 return typeof phase==='string'&&typeof reason==='string'&&Object.hasOwn(diagnosticPairs,phase)&&
  diagnosticPairs[phase as InspectionDiagnosticPhase].includes(reason as InspectionDiagnosticReason);
}
export type InspectionReport = { state:'disabled'|'outside-window'|'refused'|'unknown'|'timeout'|'identity-observed'|'absence-observed'|'reservation-structural'|'completion-structural'; retryAllowed:false; initializationAllowed:false; credentialsVerified:false; attemptReconciled:false; oid?:string; phase?:InspectionDiagnosticPhase; reason?:InspectionDiagnosticReason };
export const report = (state:InspectionReport['state'],oid?:string):InspectionReport => ({state,retryAllowed:false,initializationAllowed:false,credentialsVerified:false,attemptReconciled:false,...(oid?{oid}:{})});
export function unknownReport(phase:InspectionDiagnosticPhase,reason:InspectionDiagnosticReason):InspectionReport {
 if(!isInspectionDiagnostic(phase,reason))throw Error('SYNTHETIC_RO_DIAGNOSTIC_INVALID');
 return {...report('unknown'),phase,reason};
}
class InspectionDiagnosticFailure extends Error {
 readonly phase:InspectionDiagnosticPhase; readonly reason:InspectionDiagnosticReason;
 constructor(phase:InspectionDiagnosticPhase,reason:InspectionDiagnosticReason){super('SYNTHETIC_RO_DIAGNOSTIC');this.phase=phase;this.reason=reason;}
}
const failInspection=(phase:InspectionDiagnosticPhase,reason:InspectionDiagnosticReason):never=>{throw new InspectionDiagnosticFailure(phase,reason);};
const refuse=():never=>{throw Error('SYNTHETIC_RO_REFUSED');};
const name=(s:string|undefined):s is string=>typeof s==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(s);
export const validOid=(s:unknown):s is string=>typeof s==='string'&&/^[1-9]\d{0,9}$/.test(s)&&Number(s)<=4294967295;
export function assertInspectionLauncher(source:Source) {
 assertSyntheticWebDatabase(source);
 if(source.SYNTHETIC_INIT_ENABLED!=='false'||source.SYNTHETIC_BROWSER_SETUP_ENABLED!=='false'||
   source.SYNTHETIC_INIT_CAPABILITY_SHA256!==undefined||source.SYNTHETIC_INIT_EXPIRES_AT!==undefined||source.NODE_OPTIONS!==undefined||source.NODE_EXTRA_CA_CERTS!==undefined)refuse();
}
/** Values are operator parameters, never proof of the operator's identity. */
export function inspectionPlan(source:Source,now:number):InspectionConfig|InspectionReport {
 assertInspectionLauncher(source);
 if(source.SYNTHETIC_RO_INSPECTION_ENABLED===undefined||source.SYNTHETIC_RO_INSPECTION_ENABLED==='false')return report('disabled');
 if(source.SYNTHETIC_RO_INSPECTION_ENABLED!=='true'||!Number.isFinite(now))refuse();
 const start=Date.parse(source.SYNTHETIC_RO_INSPECTION_NOT_BEFORE??''),end=Date.parse(source.SYNTHETIC_RO_INSPECTION_EXPIRES_AT??'');
 if(!Number.isFinite(start)||!Number.isFinite(end)||new Date(start).toISOString()!==source.SYNTHETIC_RO_INSPECTION_NOT_BEFORE||new Date(end).toISOString()!==source.SYNTHETIC_RO_INSPECTION_EXPIRES_AT||end<=start||end-start>600000)refuse();
 if(now<start||now>=end)return report('outside-window');
 const mode=source.SYNTHETIC_RO_INSPECTION_MODE;
 if(mode!=='identify'&&mode!=='inspect')refuse();
 const u=new URL(source.DATABASE_URL!),host=source.SYNTHETIC_RO_INSPECTION_EXPECTED_HOST,database=source.SYNTHETIC_RO_INSPECTION_EXPECTED_DATABASE,user=source.SYNTHETIC_RO_INSPECTION_EXPECTED_USER;
 if(!host||!/^([a-z0-9][a-z0-9-]*\.)*[a-z0-9][a-z0-9-]*$/.test(host)||u.hostname!==host||u.search||u.hash||(u.port&&u.port!=='5432')||!name(database)||!name(user)||u.pathname!==`/${database}`||decodeURIComponent(u.username)!==user)refuse();
 const password=decodeURIComponent(u.password);if(!password||password.includes('\0'))refuse();
 const oid=source.SYNTHETIC_RO_INSPECTION_EXPECTED_OID;
 if(mode==='identify'&&oid!==undefined||mode==='inspect'&&!validOid(oid))refuse();
 return {mode:mode as 'identify'|'inspect',host:host!,database:database!,user:user!,password,oid,expires:end};
}
export interface ReadClient {query(sql:string):Promise<{rows:Record<string,unknown>[]}>;}
/** No connector, mutable environment, write statements, initializer or account queries. Caller owns cleanup. */
export async function inspectOperational(client:ReadClient,config:InspectionConfig,now:()=>number=Date.now):Promise<InspectionReport> {
 const sqls=new Set(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',"SET LOCAL search_path = pg_catalog","SET LOCAL statement_timeout = '3s'","SET LOCAL lock_timeout = '1s'",'COMMIT',IDENTITY_ONLY_SQL,TABLES_SQL,RESERVATION_SQL,COMPLETION_SQL,JOURNAL_SQL,EMPTY_SQL,RESERVED_EMPTY_SQL]);
 let phase:InspectionDiagnosticPhase='transaction';
 let deadline=0;
 const query=async(sql:string,queryPhase:InspectionDiagnosticPhase)=>{
  phase=queryPhase;
  if(now()>=deadline)failInspection(phase,'deadline');
  if(!sqls.has(sql))refuse();
  let r:{rows:Record<string,unknown>[]};
  try{r=await client.query(sql);}catch{return failInspection(phase,'query-failed');}
  if(now()>=deadline)failInspection(phase,'deadline');
  if(!Array.isArray(r.rows)||r.rows.length>manifest.length+1)failInspection(phase,'unexpected-shape');
  return r.rows;
 };
 try{
  deadline=Math.min(now()+MAX_INSPECTION_MS,config.expires);
  await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','transaction');await query('SET LOCAL search_path = pg_catalog','transaction');await query("SET LOCAL statement_timeout = '3s'",'transaction');await query("SET LOCAL lock_timeout = '1s'",'transaction');
  const rows=await query(IDENTITY_ONLY_SQL,'identity'),identity=rows[0];
  if(rows.length!==1||identity.database!==config.database||identity.owner!==config.user||!validOid(identity.oid)||(config.mode==='inspect'&&identity.oid!==config.oid))failInspection('identity','identity-mismatch');
  if(config.mode==='identify'){await query('COMMIT','transaction');return report('identity-observed',identity.oid as string);}
  const tables=await query(TABLES_SQL,'catalog');
  if(tables.length>3||tables.some(t=>t.kind!=='r'||t.rls!==false||!((t.schema==='public'&&['synthetic_init_reservation','synthetic_init_completion'].includes(String(t.name)))||(t.schema==='drizzle'&&t.name==='__drizzle_migrations')))||new Set(tables.map(t=>t.name)).size!==tables.length)failInspection('catalog','unexpected-structure');
  const has=(n:string)=>tables.some(t=>t.name===n);let state:InspectionReport['state'];
  if(!has('synthetic_init_reservation')){
   if(tables.length)failInspection('catalog','unexpected-structure');const empty=await query(EMPTY_SQL,'catalog');if(empty.length!==1||empty[0].objects!==0)failInspection('catalog','unexpected-structure');state='absence-observed';
  }else{
   const digest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
   const reservation=await query(RESERVATION_SQL,'reservation'),r=reservation[0];
   if(reservation.length!==1||typeof r.attempt!=='string'||!/^synthetic-init-[a-z0-9-]{8,64}$/.test(r.attempt)||r.manifest!==digest||typeof r.stamp!=='string'||!Number.isFinite(Date.parse(r.stamp))||new Date(r.stamp).toISOString()!==r.stamp)failInspection('reservation','marker-mismatch');
   if(has('synthetic_init_completion')){
    if(!has('__drizzle_migrations'))failInspection('catalog','unexpected-structure');const completion=await query(COMPLETION_SQL,'completion'),c=completion[0];
    if(completion.length!==1||c.attempt!==r.attempt||c.manifest!==digest||c.stamp!==r.stamp)failInspection('completion','marker-mismatch');
    const journal=await query(JOURNAL_SQL,'journal');if(journal.length!==manifest.length||journal.some((j,i)=>j.hash!==manifest[i].sha256||j.stamp!==String(manifest[i].when)))failInspection('journal','journal-mismatch');state='completion-structural';
   }else{
    if(has('__drizzle_migrations'))failInspection('catalog','unexpected-structure');const empty=await query(RESERVED_EMPTY_SQL,'catalog');if(empty.length!==1||empty[0].objects!==0)failInspection('catalog','unexpected-structure');state='reservation-structural';
   }
  }
  await query('COMMIT','transaction');return report(state);
 }catch(error){
  return error instanceof InspectionDiagnosticFailure ? unknownReport(error.phase,error.reason) : unknownReport(phase,'unexpected-shape');
 } // Dedicated connection is destroyed, rolling back any open RO transaction.
}
