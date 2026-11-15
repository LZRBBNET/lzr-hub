import test from 'node:test';import assert from 'node:assert/strict';import {grants} from '../scripts/ephemeral/grants.mjs';
test('grant contract excludes blanket privileges and identity/role columns',()=>{
 for(const sql of grants){assert.doesNotMatch(sql,/ALL PRIVILEGES|GRANT OPTION|SUPERUSER|CREATEROLE|CREATEDB|BYPASSRLS|GRANT (CREATE|TEMP|TRUNCATE|TRIGGER|REFERENCES)|GRANT .* ON ALL /i);assert.match(sql,/^(?:REVOKE ALL ON (?:DATABASE lzr_synthetic_demo|SCHEMA public) FROM PUBLIC|GRANT .+ TO lzr_demo_app)$/);}
 const userUpdates=grants.filter(s=>/^GRANT UPDATE.* ON public\.users /.test(s));assert.equal(userUpdates.length,1);assert.match(userUpdates[0],/^GRANT UPDATE \(password_hash,password_salt,must_change_password,last_login_at,updated_at\)/);assert.doesNotMatch(userUpdates[0],/\b(role|active|email|name)\b/);
 assert.ok(grants.includes('GRANT SELECT,INSERT,DELETE ON public.sessions TO lzr_demo_app'));
 assert.ok(grants.includes('GRANT UPDATE (status,updated_at) ON public.payment_promises TO lzr_demo_app'));
 assert.ok(grants.includes('REVOKE ALL ON DATABASE lzr_synthetic_demo FROM PUBLIC'));
 assert.ok(grants.includes('REVOKE ALL ON SCHEMA public FROM PUBLIC'));
 for(const sql of grants.filter(s=>s.startsWith('GRANT')))assert.doesNotMatch(sql,/synthetic_init|drizzle|pg_authid|pg_read_file|pg_execute_server_program/);
});
