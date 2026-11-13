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
export type InspectionReport = { state:'disabled'|'outside-window'|'refused'|'unknown'|'timeout'|'identity-observed'|'absence-observed'|'reservation-structural'|'completion-structural'; retryAllowed:false; initializationAllowed:false; credentialsVerified:false; attemptReconciled:false; oid?:string };
export const report = (state:InspectionReport['state'],oid?:string):InspectionReport => ({state,retryAllowed:false,initializationAllowed:false,credentialsVerified:false,attemptReconciled:false,...(oid?{oid}:{})});
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
 const deadline=Math.min(now()+MAX_INSPECTION_MS,config.expires);
 const query=async(sql:string)=>{if(now()>=deadline||!sqls.has(sql))refuse();const r=await client.query(sql);if(now()>=deadline||!Array.isArray(r.rows)||r.rows.length>manifest.length+1)refuse();return r.rows;};
 try{
  await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await query('SET LOCAL search_path = pg_catalog');await query("SET LOCAL statement_timeout = '3s'");await query("SET LOCAL lock_timeout = '1s'");
  const rows=await query(IDENTITY_ONLY_SQL),identity=rows[0];
  if(rows.length!==1||identity.database!==config.database||identity.owner!==config.user||!validOid(identity.oid)||(config.mode==='inspect'&&identity.oid!==config.oid))refuse();
  if(config.mode==='identify'){await query('COMMIT');return report('identity-observed',identity.oid as string);}
  const tables=await query(TABLES_SQL);
  if(tables.length>3||tables.some(t=>t.kind!=='r'||t.rls!==false||!((t.schema==='public'&&['synthetic_init_reservation','synthetic_init_completion'].includes(String(t.name)))||(t.schema==='drizzle'&&t.name==='__drizzle_migrations')))||new Set(tables.map(t=>t.name)).size!==tables.length)refuse();
  const has=(n:string)=>tables.some(t=>t.name===n);let state:InspectionReport['state'];
  if(!has('synthetic_init_reservation')){
   if(tables.length)refuse();const empty=await query(EMPTY_SQL);if(empty.length!==1||empty[0].objects!==0)refuse();state='absence-observed';
  }else{
   const digest=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
   const reservation=await query(RESERVATION_SQL),r=reservation[0];
   if(reservation.length!==1||typeof r.attempt!=='string'||!/^synthetic-init-[a-z0-9-]{8,64}$/.test(r.attempt)||r.manifest!==digest||typeof r.stamp!=='string'||!Number.isFinite(Date.parse(r.stamp))||new Date(r.stamp).toISOString()!==r.stamp)refuse();
   if(has('synthetic_init_completion')){
    if(!has('__drizzle_migrations'))refuse();const completion=await query(COMPLETION_SQL),c=completion[0];
    if(completion.length!==1||c.attempt!==r.attempt||c.manifest!==digest||c.stamp!==r.stamp)refuse();
    const journal=await query(JOURNAL_SQL);if(journal.length!==manifest.length||journal.some((j,i)=>j.hash!==manifest[i].sha256||j.stamp!==String(manifest[i].when)))refuse();state='completion-structural';
   }else{
    if(has('__drizzle_migrations'))refuse();const empty=await query(RESERVED_EMPTY_SQL);if(empty.length!==1||empty[0].objects!==0)refuse();state='reservation-structural';
   }
  }
  await query('COMMIT');return report(state);
 }catch{return report('unknown');} // Dedicated connection is destroyed, rolling back any open RO transaction.
}
