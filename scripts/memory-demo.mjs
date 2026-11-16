// Exclusive memory launcher. Existing build/start/database launchers are untouched.
import {readFile,writeFile,mkdir,rm,copyFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {configuration} from '../lib/memory-demo/config.mjs';
import {denyExternalTransport} from '../lib/memory-demo/egress.mjs';
const output=new URL('../work/memory-demo/',import.meta.url);
export async function run(command,source=process.env){
 const config=configuration(source,command==='build');
 if(command==='build'){
  await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
  const {build}=await import('esbuild');
  await build({entryPoints:[fileURLToPath(new URL('../lib/memory-demo/server.mjs',import.meta.url))],outfile:fileURLToPath(new URL('server.mjs',output)),bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',plugins:[{name:'memory-db-refused',setup(b){b.onResolve({filter:/(?:^|\/)db(?:\/index(?:\.ts)?)?$/},()=>({path:'blocked-db',namespace:'memory'}));b.onLoad({filter:/.*/,namespace:'memory'},()=>({contents:"export function getDb(){throw Error('MEMORY_DATABASE_FORBIDDEN')} export function getPool(){throw Error('MEMORY_DATABASE_FORBIDDEN')}"}));}}]});
  for(const name of ['index.html','ui.js'])await copyFile(new URL('../lib/memory-demo/'+name,import.meta.url),new URL(name,output));
  await writeFile(new URL('manifest.json',output),JSON.stringify({kind:'exclusive-memory-demo-v1',database:false,volatile:true}));return;
 }
 if(command!=='start')throw Error('MEMORY_COMMAND_REFUSED');
 const manifest=JSON.parse(await readFile(new URL('manifest.json',output),'utf8'));if(manifest.kind!=='exclusive-memory-demo-v1'||manifest.database!==false)throw Error('MEMORY_ARTIFACT_REFUSED');
 // Fixed off-switches precede imports and bootstrap. No external network fallback.
 Object.assign(process.env,config.env);denyExternalTransport(config.bind);
 const {serve}=await import(new URL('server.mjs',output).href);const server=await serve(config,fileURLToPath(output));
 delete process.env.MEMORY_DEMO_PASSWORD;delete process.env.MEMORY_DEMO_READER_PASSWORD;config.password=undefined;config.readerPassword=undefined;
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close(()=>process.exit(0));server.closeAllConnections();});
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run(process.argv[2]).catch(()=>{console.error('MEMORY_DEMO_REFUSED');process.exitCode=1;});
