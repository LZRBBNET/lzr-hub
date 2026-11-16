// Fixed read-only catalog queries, shared without importing initialization code.
export const IDENTITY_SQL = `SELECT current_database() AS database, current_user AS owner,
  (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
  (SELECT count(*)::int FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()) AS peers`;
function emptinessQuery(reserved: boolean) {
  const relationExclusion = reserved ? " AND NOT (n.nspname='public' AND c.relname IN ('synthetic_init_reservation','synthetic_init_reservation_pkey'))" : '';
  const typeExclusion = reserved ? " AND NOT (n.nspname='public' AND t.typname IN ('synthetic_init_reservation','_synthetic_init_reservation'))" : '';
  return `SELECT (
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'${relationExclusion}) +
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') +
  (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'${typeExclusion}) +
  (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')) +
  (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql') +
  (SELECT count(*) FROM pg_event_trigger) + (SELECT count(*) FROM pg_foreign_server) + (SELECT count(*) FROM pg_publication) +
  (SELECT count(*) FROM pg_largeobject_metadata) + (SELECT count(*) FROM pg_default_acl) +
  (SELECT count(*) FROM pg_ts_config c JOIN pg_namespace n ON n.oid=c.cfgnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')
  )::int AS objects`;
}
export const EMPTY_SQL = emptinessQuery(false);
export const RESERVED_EMPTY_SQL = emptinessQuery(true);
