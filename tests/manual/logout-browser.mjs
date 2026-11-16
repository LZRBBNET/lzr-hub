import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {hashPassword} from '../../lib/platform/auth.ts';
export async function runLogoutBrowser({pool,dir,root,record}){
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE),password=randomBytes(24).toString('hex'),{hash,salt}=await hashPassword(password),now=new Date().toISOString();
 await pool.query("INSERT INTO users(id,email,name,role,password_hash,password_salt,created_at,updated_at) VALUES('auth-visual','visual@example.invalid','Operador Sintético','Atendente',$1,$2,$3,$3)",[hash,salt,now]);
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin=`http://127.0.0.1:${port}`;
 const entry=join(dir,'auth-visual-server.mjs');await writeFile(entry,`import {startProdServer} from ${JSON.stringify(join(root,'node_modules/vinext/dist/server/prod-server.js'))};let calls=0;globalThis.fetch=async()=>{calls++;throw Error('External transport forbidden');};process.on('message',()=>process.send({calls}));await startProdServer({port:${port},host:'127.0.0.1',outDir:${JSON.stringify(join(root,'dist'))}});`);
 const app=spawn(process.execPath,[entry],{cwd:root,env:{PATH:process.env.PATH,LANG:'C.UTF-8',NODE_ENV:'production',FEATURE_AUTH:'true',FEATURE_COPILOT_LLM:'false',FEATURE_LLM_INTENT:'false',FEATURE_LANGFUSE:'false',FEATURE_N8N_CHANNEL:'false',FEATURE_N8N_AUTOREPLY:'false',FEATURE_ATTENDANT_REPLY:'false',FEATURE_META_WHATSAPP:'false',IXC_MODE:'disabled',DATABASE_URL:`postgresql://synthetic_auth_visual@localhost/handoff_synthetic?host=${encodeURIComponent(dir)}`},stdio:['ignore','pipe','pipe','ipc']});let serverOutput='';app.stdout.on('data',chunk=>serverOutput+=chunk);app.stderr.on('data',chunk=>serverOutput+=chunk);
 let browser;try{
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(origin+'/login')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),external=[];
  await context.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();external.push(r.request().url());return r.abort();});
  await page.goto(origin+'/login');await page.getByLabel('E-mail',{exact:true}).fill('visual@example.invalid');await page.getByLabel('Senha',{exact:true}).fill(password);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL(origin+'/');
  assert.equal((await (await context.request.get(origin+'/api/auth/me')).json()).authenticated,true);
  const cookieBefore=(await context.cookies()).find(x=>x.name==='lzr_session')?.value;assert.ok(cookieBefore);
  await page.locator('.app-shell').waitFor();
  await pool.query('REVOKE DELETE ON sessions FROM synthetic_auth_visual');
  const attempt=async()=>{await page.locator('.user-trigger').click();const response=page.waitForResponse(r=>r.url().endsWith('/api/auth/logout'));await page.getByRole('menuitem',{name:'Sair',exact:true}).click();return response;};
  const failed=await attempt();assert.equal(failed.status(),503);assert.equal(failed.headers()['set-cookie'],undefined);assert.equal(failed.headers()['cache-control'],'no-store');
  await page.getByRole('alert').waitFor();assert.equal(new URL(page.url()).pathname,'/');assert.equal(await page.locator('.app-shell,input,textarea').count(),0);
  const visible=await page.locator('body').innerText();assert.match(visible,/Não foi possível confirmar/);assert.match(visible,/pode continuar ativa/);assert.match(visible,/Recarregar ou reabrir esta página não encerra a sessão/);assert.doesNotMatch(visible,/postgres|permission denied|synthetic_auth_visual|DATABASE_URL|visual@example|sessão encerrada/i);assert.ok(!visible.includes(cookieBefore));assert.ok(!visible.includes(password));
  assert.equal((await context.cookies()).find(x=>x.name==='lzr_session')?.value,cookieBefore);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id='auth-visual'")).rows[0].n,1);
  const button=page.getByRole('button',{name:'Tentar sair novamente',exact:true});await page.keyboard.press('Tab');assert.equal(await button.evaluate(el=>el===document.activeElement),true);
  await page.screenshot({path:join(dir,'logout-failed-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(dir,'logout-failed-mobile.png')});
  const size=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));assert.equal(size.width,size.scrollWidth);
  const retryFailure=page.waitForResponse(r=>r.url().endsWith('/api/auth/logout'));await page.keyboard.press('Enter');assert.equal((await retryFailure).status(),503);await button.waitFor();
  record('logout_failure',{status:503,cookiePreserved:true,sessionPresent:true,modulesAbsent:true,noSuccessClaim:true,noSensitiveText:true,keyboardRetry:true,mobile:size});
  // Reload cannot revoke a session: prove the limitation rather than claiming persistent lockout.
  await page.reload();await page.locator('.app-shell').waitFor();assert.equal((await (await context.request.get(origin+'/api/auth/me')).json()).authenticated,true);
  record('reopen_before_revocation',{sessionStillActive:true,localBlockNotPersistent:true});
  assert.equal((await attempt()).status(),503);await page.getByRole('alert').waitFor();
  await pool.query('GRANT DELETE ON sessions TO synthetic_auth_visual');
  await button.focus();const recovered=page.waitForResponse(r=>r.url().endsWith('/api/auth/logout'));await page.keyboard.press('Enter');const success=await recovered;assert.equal(success.status(),200);await page.waitForURL(origin+'/login');
  assert.equal((await context.cookies()).find(x=>x.name==='lzr_session'),undefined);assert.equal((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id='auth-visual'")).rows[0].n,0);
  await page.screenshot({path:join(dir,'logout-recovered-login-mobile.png')});
  record('login_mobile_geometry',await page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,inputs:[...document.querySelectorAll('input')].map(el=>({width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})),scrollHeight:document.documentElement.scrollHeight})));
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:900});
   const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,fieldWidth:document.querySelector('input').getBoundingClientRect().width,columns:getComputedStyle(document.querySelector('.login-shell')).gridTemplateColumns.split(' ').length}));
   assert.equal(geometry.scrollWidth,width);assert.ok(geometry.fieldWidth>=230);assert.equal(geometry.columns,width<=900?1:2);
   record('login_responsive',geometry);await page.screenshot({path:join(dir,'login-width-'+width+'.png')});
  }
  await page.setViewportSize({width:390,height:844});
  const replay=await fetch(origin+'/api/auth/me',{headers:{cookie:'lzr_session='+cookieBefore}});assert.equal((await replay.json()).authenticated,false);
  await page.goto(origin+'/');await page.waitForURL(origin+'/login');
  const reopened=await context.newPage();await reopened.goto(origin+'/');await reopened.waitForURL(origin+'/login');await reopened.close();
  record('logout_recovery',{status:200,cookieRemoved:true,sessionRevoked:true,oldTokenRejected:true,reopenRedirectsLogin:true});
  await page.getByLabel('E-mail',{exact:true}).fill('visual@example.invalid');await page.getByLabel('Senha',{exact:true}).fill(password);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL(origin+'/');await page.locator('.app-shell').waitFor();assert.notEqual((await context.cookies()).find(x=>x.name==='lzr_session')?.value,cookieBefore);
  record('new_login',{authenticated:true,newSessionCookie:true});
  const reply=once(app,'message');app.send({});const stats=(await reply)[0];assert.equal(stats.calls,0);assert.equal(external.length,0);record('isolation',{externalServerCalls:stats.calls,externalBrowserRequests:external.length});
 }finally{
  try{if(browser)await browser.close();}finally{
   if(app.exitCode===null && app.signalCode===null){const exited=once(app,'exit');app.kill('SIGTERM');const timer=setTimeout(()=>app.kill('SIGKILL'),5000);try{await exited;}finally{clearTimeout(timer);}}
   await writeFile(join(dir,'server.log'),serverOutput);
  }
 }
}
