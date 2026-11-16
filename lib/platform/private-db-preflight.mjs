// Metadata only. This is never an initialization or isolation authorization.
export const NAMES=Object.freeze({database:'lzr_h100_demo',owner:'lzr_h100_owner',app:'lzr_h100_app'});
export const IDENTITY_SQL=`SELECT pg_catalog.current_database() AS database,current_user AS owner,(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS oid`;
export const CATALOG_SQL=`SELECT
 (SELECT rolcreatedb FROM pg_catalog.pg_roles WHERE rolname=current_user) AS createdb,
 (SELECT rolcreaterole FROM pg_catalog.pg_roles WHERE rolname=current_user) AS createrole,
 EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname='lzr_h100_demo') AS database_exists,
 EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('lzr_h100_owner','lzr_h100_app')) AS role_exists,
 EXISTS(SELECT 1 FROM pg_catalog.pg_database d CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a WHERE d.datallowconn AND a.grantee=0 AND a.privilege_type='CONNECT') AS public_connect,
 EXISTS(SELECT 1 FROM pg_catalog.pg_database d CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a WHERE d.datallowconn AND a.grantee=0 AND a.privilege_type='TEMPORARY') AS public_temp,
 EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee=0) AS public_schema_acl,
 (EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a WHERE n.nspname='public' AND a.grantee=0)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE n.nspname='public' AND a.grantee=0)) AS public_object_acl`;
export const CAPACITY_SQL=`SELECT CASE WHEN size IS NULL THEN NULL WHEN size<1073741824 THEN 'below-one-gib' WHEN size<10737418240 THEN 'one-to-ten-gib' ELSE 'at-least-ten-gib' END AS size_bucket,
 CASE WHEN backends IS NULL THEN NULL WHEN backends<10 THEN 'below-ten' WHEN backends<50 THEN 'ten-to-fortynine' ELSE 'at-least-fifty' END AS connections_bucket
 FROM (SELECT pg_catalog.pg_database_size(pg_catalog.current_database()) AS size,(SELECT numbackends FROM pg_catalog.pg_stat_database WHERE datname=pg_catalog.current_database()) AS backends) bounded`;
const flags=['retryAllowed','initializationAllowed','credentialsVerified','attemptReconciled','remoteExecutionAllowed','capacityVerified'];
const reasons=['disabled','refused','identity-mismatch','query-failed','shape-invalid','deadline','close-failed','child-failed','invalid-message','name-collision','public-connect','public-acl','capability-unobserved','capacity-unverified'];
export function result(reason,observations){if(!reasons.includes(reason))throw Error('PREFLIGHT_REASON');return{state:'blocked',reason,...Object.fromEntries(flags.map(k=>[k,false])),...(observations?{observations}:{} )};}
const boolKeys=['createdb','createrole','database_exists','role_exists','public_connect','public_temp','public_schema_acl','public_object_acl'];
const size=['below-one-gib','one-to-ten-gib','at-least-ten-gib'],connections=['below-ten','ten-to-fortynine','at-least-fifty'];
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
export function project(value){
 if(!exact(value,['state','reason',...flags,...(Object.hasOwn(value??{},'observations')?['observations']:[])])||value.state!=='blocked'||!reasons.includes(value.reason)||flags.some(k=>value[k]!==false))return result('invalid-message');
 if(Object.hasOwn(value,'observations')){const o=value.observations;if(!exact(o,[...boolKeys,'size_bucket','connections_bucket'])||boolKeys.some(k=>typeof o[k]!=='boolean')||!size.includes(o.size_bucket)||!connections.includes(o.connections_bucket))return result('invalid-message');}
 return result(value.reason,value.observations?{...value.observations}:undefined);
}
export async function inspect(client,plan,now=Date.now){
 const deadline=Math.min(now()+18000,plan.expires);let reason='query-failed';
 const query=async sql=>{if(now()>=deadline){reason='deadline';throw Error();}const r=await client.query(sql);if(now()>=deadline){reason='deadline';throw Error();}if(!Array.isArray(r.rows)||r.rows.length>1){reason='shape-invalid';throw Error();}return r.rows;};
 try{
  await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await query('SET LOCAL search_path = pg_catalog');await query("SET LOCAL statement_timeout = '3s'");await query("SET LOCAL lock_timeout = '1s'");
  const ids=await query(IDENTITY_SQL),id=ids[0];if(ids.length!==1||!exact(id,['database','owner','oid'])||id.database!==plan.database||id.owner!==plan.user||id.oid!==plan.oid)return result('identity-mismatch');
  const rows=await query(CATALOG_SQL),o=rows[0];if(rows.length!==1||!exact(o,boolKeys)||boolKeys.some(k=>typeof o[k]!=='boolean'))return result('shape-invalid');
  const capacity=await query(CAPACITY_SQL),c=capacity[0];if(capacity.length!==1||!exact(c,['size_bucket','connections_bucket'])||!size.includes(c.size_bucket)||!connections.includes(c.connections_bucket))return result('shape-invalid');
  await query('COMMIT');
  return result(o.database_exists||o.role_exists?'name-collision':o.public_connect?'public-connect':o.public_temp||o.public_schema_acl||o.public_object_acl?'public-acl':!o.createdb||!o.createrole?'capability-unobserved':'capacity-unverified',{...o,...c});
 }catch{return result(reason);}
}
