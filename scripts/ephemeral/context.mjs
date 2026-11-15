import {cp,mkdtemp,rm,writeFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
export const allowlist=['package.json','package-lock.json','app','components','lib','db','types','public','drizzle','services/queue-runtime/src/promise-hold.mjs','scripts/synthetic-web.mjs','scripts/prepare-synthetic-initialization.mjs','scripts/ephemeral','proxy.ts','tsconfig.json','next.config.ts','deploy/ephemeral/Dockerfile'];
async function rejectLinks(path){const s=await lstat(path);if(s.isSymbolicLink())throw Error('CONTEXT_LINK_REFUSED');if(s.isDirectory())for(const name of await readdir(path))await rejectLinks(join(path,name));}
export async function buildContext(){
 const root=await mkdtemp('/tmp/lzr-image-context-');
 try{for(const path of allowlist)await rejectLinks(path);for(const path of allowlist)await cp(path,join(root,path),{recursive:true,filter:path=>!path.split('/').some(part=>part.startsWith('.env')||['node_modules','.git','work'].includes(part))});
 await writeFile(join(root,'.dockerignore'),'**/.env*\n**/.git\n**/node_modules\n**/work\n');return root;
 }catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
