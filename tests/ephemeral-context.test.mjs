import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,readFile,access} from 'node:fs/promises';import {dirname,join} from 'node:path';
import {allowlist,buildContext} from '../scripts/ephemeral/context.mjs';
test('build context excludes unlisted credentials and rejects external symlinks',async()=>{
 const original=process.cwd(),fixture=await mkdtemp('/tmp/lzr-context-unit-');let context;
 try{
  for(const path of allowlist){await mkdir(dirname(join(fixture,path)),{recursive:true});await writeFile(join(fixture,path),'fixed fixture');}
  await rm(join(fixture,'app'));await mkdir(join(fixture,'app'));await writeFile(join(fixture,'app','.env.secret'),'PRIVATE_CANARY');await writeFile(join(fixture,'.env'),'PRIVATE_CANARY');
  process.chdir(fixture);context=await buildContext();assert.equal(await readFile(join(context,'package.json'),'utf8'),'fixed fixture');
  for(const path of ['.env','app/.env.secret'])await assert.rejects(access(join(context,path)),e=>e.code==='ENOENT');
  await rm(context,{recursive:true,force:true});context=undefined;
  await rm(join(fixture,'public'));await symlink(join(fixture,'.env'),join(fixture,'public'));await assert.rejects(buildContext(),/CONTEXT_LINK_REFUSED/);
 }finally{process.chdir(original);if(context)await rm(context,{recursive:true,force:true});await rm(fixture,{recursive:true,force:true});}
});
