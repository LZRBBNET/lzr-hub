import assert from 'node:assert/strict';
import { IDENTITY_SQL, EMPTY_SQL, RESERVED_EMPTY_SQL, RESERVATION_SQL } from '../../lib/platform/synthetic-initialization.ts';
export const fresh=()=>({objects:0,reserved:false,completed:false,rows:[]});
export class Simulator {
  constructor(store=fresh(),fault=()=>false){this.store=store;this.fault=fault;this.calls=[];this.pending=null;this.destroyed=0;this.commits=0;this.peers=0;this.locked=true;}
  async query(sql,values=[]){
    this.calls.push({sql,values});const at=this.calls.length;
    if(this.fault(at,sql)==='before')throw new Error('invented-private-error');
    let rows=[];
    if(sql===IDENTITY_SQL)rows=[{database:'lzr_synthetic_demo',owner:'lzr_synthetic_demo',oid:'12345',peers:this.peers,...this.identity}];
    else if(sql===EMPTY_SQL)rows=[{objects:this.store.objects+(this.store.reserved?1:0)}];
    else if(sql===RESERVED_EMPTY_SQL)rows=[{objects:this.store.objects}];
    else if(sql===RESERVATION_SQL)rows=this.store.rows.filter(r=>r.sql.startsWith('INSERT INTO public.synthetic_init_reservation')).map(r=>({attempt:r.values[0],manifest:r.values[1],created_at:r.values[2]}));
    else if(sql.startsWith('SELECT pg_try_advisory_lock'))rows=[{locked:this.locked}];
    else if(sql==='BEGIN'){assert.equal(this.pending,null);this.pending=structuredClone(this.store);}
    else if(sql==='COMMIT'){assert.ok(this.pending);Object.assign(this.store,this.pending);this.pending=null;this.commits++;}
    else if(sql==='ROLLBACK')this.pending=null;
    else if(sql==='SET search_path = pg_catalog')assert.equal(this.pending,null);
    else if(sql.startsWith('SET LOCAL'))assert.ok(this.pending);
    else {
      assert.ok(this.pending,'writes must share dedicated transaction');
      assert.doesNotMatch(sql,/\b(DROP|DELETE|TRUNCATE|UPDATE|GRANT|REVOKE)\b/i);
      if(sql.startsWith('INSERT INTO public.synthetic_init_reservation'))this.pending.reserved=true;
      if(sql.startsWith('INSERT INTO public.synthetic_init_completion'))this.pending.completed=true;
      if(sql.startsWith('INSERT INTO '))this.pending.rows.push({sql,values});
    }
    if(this.fault(at,sql)==='after')throw new Error('invented-private-error');
    return {rows};
  }
  async destroy(){this.destroyed++;this.pending=null;if(this.failDestroy)throw new Error('invented-disposal-error');}
}
