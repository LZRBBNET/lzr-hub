import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const image=await readFile(new URL('./manual/ephemeral-image.mjs',import.meta.url),'utf8');
const footer=image.slice(image.lastIndexOf('process.exitCode='))+'\n'+image.split('\n').find(line=>line.includes("stage:'final-verdict'"));
for(const failed of [false,true])test(`image final verdict fails closed (failure=${failed})`,()=>{
 const rows=[];
 const sandbox={failed,process:{},record:row=>rows.push(row)};
 vm.runInNewContext(footer,sandbox,{timeout:1000});
 assert.equal(sandbox.process.exitCode,failed?1:2);
 assert.equal(rows.length,1);
 assert.equal(rows[0].pass,false);
 assert.equal(rows[0].status,failed?'failed':'blocked');
 assert.equal(rows[0].scope,'image-and-resource-gate');
 assert.equal(rows[0].exitCode,sandbox.process.exitCode);
});
test('cleanup and interruption failures remain fatal before final verdict',()=>{
 const ordered=[image.indexOf("if(!containers||!files||!imageRemoved||interrupted)failed=true;"),image.indexOf("record({stage:'final-verdict'"),image.indexOf("await writeFile('/workspace/evidence/ephemeral-image-results.json'"),image.lastIndexOf('process.exitCode=')];
 assert.ok(ordered.every((position,index)=>position>=0&&(index===0||position>ordered[index-1])));
 assert.match(image,/await writeFile[\s\S]*process.exitCode=failed\?1:2/);
});
test('local runtime evidence explicitly excludes image and resource validation',async()=>{
 const source=await readFile(new URL('./manual/runtime-grants-pg17.mjs',import.meta.url),'utf8');
 const outcome=source.split('\n').find(line=>line.includes("stage:'outcome'"));
 const rows=[];
 vm.runInNewContext(outcome,{baseline:false,record:row=>rows.push(row)},{timeout:1000});
 assert.equal(rows[0].scope,'host-mounted-runtime-only');
 assert.equal(rows[0].status,'functional-only');
 assert.equal(rows[0].imageValidation,false);
 assert.equal(rows[0].resourceGate,'unverified');
 assert.equal(rows[0].freeViabilityProven,false);
});
