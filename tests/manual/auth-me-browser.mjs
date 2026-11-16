import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {hashPassword} from '../../lib/platform/auth.ts';
export async function runAuthBrowser({pool,dir,root,record}){
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),password=randomBytes(24).toString('hex'),{hash,salt}=await hashPassword(password),now=new Date().toISOString();
 await pool.query("INSERT INTO users(id,email,name,role,password_hash,password_salt,created_at,updated_at) VALUES('auth-visual','visual@example.invalid','Operador Sintético','Atendente',$1,$2,$3,$3)",[hash,salt,now]);
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin=`http://127.0.0.1:${port}`;
 const entry=join(dir,'auth-visual-server.mjs');await writeFile(entry,`import {startProdServer} from ${JSON.stringify(join(root,'node_modules/vinext/dist/server/prod-server.js'))};let calls=0;globalThis.fetch=async()=>{calls++;throw Error('External transport forbidden');};process.on('message',()=>process.send({calls}));await startProdServer({port:${port},host:'127.0.0.1',outDir:${JSON.stringify(join(root,'dist'))}});`);
 const app=spawn(process.execPath,[entry],{cwd:root,env:{PATH:process.env.PATH,LANG:'C.UTF-8',NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_COPILOT_LLM:'false',FEATURE_LLM_INTENT:'false',FEATURE_LANGFUSE:'false',FEATURE_N8N_CHANNEL:'false',FEATURE_N8N_AUTOREPLY:'false',FEATURE_ATTENDANT_REPLY:'false',FEATURE_META_WHATSAPP:'false',IXC_MODE:'disabled',DATABASE_URL:`postgresql://synthetic_auth_visual@localhost/handoff_synthetic?host=${encodeURIComponent(dir)}`},stdio:['ignore','pipe','pipe','ipc']});app.stdout.on('data',()=>{});app.stderr.on('data',()=>{});
 let browser;try{
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(origin+'/login')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),external=[];
  await context.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();external.push(r.request().url());return r.abort();});
  await page.goto(origin+'/login');await page.getByLabel('E-mail',{exact:true}).fill('visual@example.invalid');await page.getByLabel('Senha',{exact:true}).fill(password);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL(origin+'/');
  assert.equal((await (await context.request.get(origin+'/api/auth/me')).json()).authenticated,true);
  const cookieBefore=(await context.cookies()).find(x=>x.name==='lzr_session')?.value;assert.ok(cookieBefore);
  // Only this new cluster: deny authentication reads to inject a database lookup failure.
  await pool.query('REVOKE SELECT ON sessions,users FROM synthetic_auth_visual');
  const failed=page.waitForResponse(r=>r.url().endsWith('/api/auth/me'));await page.reload();assert.equal((await failed).status(),503);
  await page.getByRole('alert').waitFor();assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.locator('.app-shell').count(),0);assert.equal(await page.locator('input,textarea').count(),0);
  const button=page.getByRole('button',{name:'Tentar novamente',exact:true});await page.keyboard.press('Tab');assert.equal(await button.evaluate(el=>el===document.activeElement),true);
  await page.screenshot({path:join(dir,'auth-unavailable-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(dir,'auth-unavailable-mobile.png')});
  const size=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));assert.equal(size.width,size.scrollWidth);
  assert.equal((await context.cookies()).find(x=>x.name==='lzr_session')?.value,cookieBefore);
  record('visual_unavailable',{status:503,modulesAbsent:true,noLoginRedirect:true,cookiePreserved:true,alertRole:true,buttonKeyboardReachable:true,mobile:size});
  await pool.query('GRANT SELECT ON sessions,users TO synthetic_auth_visual');
  const restored=page.waitForResponse(r=>r.url().endsWith('/api/auth/me'));await page.keyboard.press('Enter');assert.equal((await restored).status(),200);await page.locator('.app-shell').waitFor();assert.equal(await page.getByRole('alert').count(),0);
  assert.equal((await (await context.request.get(origin+'/api/auth/me')).json()).authenticated,true);assert.equal((await context.cookies()).find(x=>x.name==='lzr_session')?.value,cookieBefore);
  await page.screenshot({path:join(dir,'auth-recovered-mobile.png')});record('visual_manual_recovery',{sameCookie:true,authenticated:true,keyboardEnter:true,viewport:390});
  await pool.query("DELETE FROM sessions WHERE user_id='auth-visual'");await page.reload();await page.waitForURL(origin+'/login');await page.getByLabel('E-mail',{exact:true}).waitFor();record('visual_invalid_session',{loginRedirect:true});
  const reply=once(app,'message');app.send({});const stats=(await reply)[0];assert.equal(stats.calls,0);assert.equal(external.length,0);record('isolation',{externalServerCalls:stats.calls,externalBrowserRequests:external.length});
 }finally{if(browser)await browser.close();app.kill('SIGTERM');await once(app,'exit').catch(()=>{});}
}
