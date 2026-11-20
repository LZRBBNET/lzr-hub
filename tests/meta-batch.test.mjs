import test from 'node:test';
import assert from 'node:assert/strict';
import {processMetaBatch} from '../lib/platform/meta-batch-service.ts';
import {readFileSync} from 'node:fs';

test('failed item does not abort siblings; batch retry deduplicates completed items',async()=>{
  const completed=new Set(), attempts=[], effects=[];let blocked=true;
  const handle=async id=>{
    attempts.push(id);
    if(completed.has(id))return;
    if(id==='blocked'&&blocked)throw Error('HUMAN_HANDOFF_NOT_RECORDED');
    effects.push(id);completed.add(id);
  };
  const items=['before','blocked','after'];
  assert.deepEqual(await processMetaBatch(items,handle),{failed:1});
  assert.deepEqual(effects,['before','after']);assert.equal(completed.has('blocked'),false);
  blocked=false;assert.deepEqual(await processMetaBatch(items,handle),{failed:0});
  assert.deepEqual(effects,['before','after','blocked']);assert.equal(attempts.length,6);
});
test('all failures stay retryable without exposing exception content',async()=>{
  assert.deepEqual(await processMetaBatch([1,2],async()=>{throw Error('private detail');}),{failed:2});
  const route=readFileSync(new URL('../app/api/channels/meta/route.ts',import.meta.url),'utf8');
  assert.match(route,/await processMetaBatch\(messages/);
  assert.match(route,/status: batch.failed \? 503 : 200/);
});
