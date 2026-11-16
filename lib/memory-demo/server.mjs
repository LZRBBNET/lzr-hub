import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {sharedState} from './state.mjs';
import {handleApi,routes} from './api.mjs';
export async function serve(config,assets){
 const state=await sharedState(config);const html=await readFile(assets+'/index.html'),js=await readFile(assets+'/ui.js');
 const responseHeaders={'cache-control':'no-store','x-robots-tag':'noindex, nofollow','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
 const server=createServer(async(req,res)=>{
  const finish=(code,body,type='application/json')=>{res.writeHead(code,{...responseHeaders,'content-type':type});res.end(body);};
  try{
   if(req.headers.host!==config.host)return finish(403,'{"error":"Host não autorizado"}');
   const path=new URL(req.url,config.origin).pathname;
   if(req.method==='GET'&&['/','/login','/ui.js'].includes(path))return finish(200,path==='/ui.js'?js:html,path==='/ui.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');
   if(!routes.has(path))return finish(404,'{"error":"Fora desta demonstração"}');
   if(!routes.get(path).includes(req.method))return finish(405,'{"error":"Método indisponível"}');
   if(req.method!=='GET'&&req.headers.origin!==config.origin)return finish(403,'{"error":"Origem não autorizada"}');
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384){finish(413,'{"error":"Corpo excede o limite"}');return;}chunks.push(chunk);}
   const body=Buffer.concat(chunks);const request=new Request(new URL(req.url,config.origin),{method:req.method,headers:req.headers,...(req.method==='POST'?{body}: {})});
   const response=await handleApi(request,state,config);res.writeHead(response.status,{...responseHeaders,...Object.fromEntries(response.headers)});res.end(Buffer.from(await response.arrayBuffer()));
  }catch{if(!res.headersSent)finish(503,'{"error":"Demonstração indisponível"}');else res.end();}
 });server.requestTimeout=10000;server.headersTimeout=10000;server.timeout=15000;server.maxHeadersCount=50;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.bind,resolve);});
 return server;
}
