import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const shell='scripts/ephemeral/entrypoint.sh';
test('rejects preloads and database overrides before any Node invocation without echoing values',()=>{
 for(const key of ['NODE_OPTIONS','NODE_EXTRA_CA_CERTS','DATABASE_URL','PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','PGOPTIONS','PGSSLMODE','PGSERVICE','PGSERVICEFILE','PGPASSFILE','PGSSLROOTCERT','PGSSLCERT','PGSSLKEY','PGDATA']){
  const result=spawnSync('/bin/sh',[shell],{env:{PATH:'/usr/bin:/bin',[key]:'SENSITIVE_CANARY'},encoding:'utf8'});assert.equal(result.status,78,key);assert.doesNotMatch(result.stdout+result.stderr,/SENSITIVE_CANARY/);assert.match(result.stderr,/EPHEMERAL_EXTERNAL_(RUNTIME|DATABASE)_REFUSED/);
 }
 for(const key of ['NODE_OPTIONS','NODE_EXTRA_CA_CERTS'])assert.equal(spawnSync('/bin/sh',[shell],{env:{PATH:'/usr/bin:/bin',[key]:''}}).status,78);
});
