/* Standalone first-access page. Secrets stay in this tab; no storage/URL/telemetry. */
(() => {
  const byId=id=>document.getElementById(id);
  const message=value=>{byId('message').textContent=value;};
  const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  let token='',attempt='',expires=0,used=false,checked=false;
  byId('origin').textContent=`Ambiente a conferir: ${location.origin}`;
  const disable=()=>{for(const id of ['prepare','check','password','repeat','approve','submit'])byId(id).disabled=true;};
  const valid=()=>token&&Date.now()<expires;
  async function request(method,body,status=false){
    if(!valid())throw Error();
    const response=await fetch(`/api/demo/browser-setup${status?'?status=1':''}`,{method,headers:{'x-synthetic-init-capability':token,'x-browser-init-attempt':attempt,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(method==='POST'?120000:20000)});
    if(!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))throw Error();
    const reader=response.body.getReader(),parts=[];let size=0;
    try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>4096)throw Error();parts.push(p.value);}}finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
    return{status:response.status,body:JSON.parse(new TextDecoder().decode(bytes))};
  }
  byId('prepare').onclick=async()=>{
    byId('prepare').disabled=true;
    try{
      if(!isSecureContext||location.protocol!=='https:'||!/^[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(location.hostname)||location.port||location.search||location.hash)throw Error();
      const bytes=crypto.getRandomValues(new Uint8Array(32));token=hex(bytes);bytes.fill(0);
      attempt=`synthetic-init-browser-${crypto.randomUUID()}`;expires=Date.now()+15*60*1000;
      const verifier=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))));
      byId('configuration').textContent=`SYNTHETIC_INIT_CAPABILITY_SHA256=${verifier}\nSYNTHETIC_INIT_EXPIRES_AT=${new Date(expires).toISOString()}\nTentativa: ${attempt}\nOrigem: ${location.origin}`;
      byId('check').disabled=false;message('Aguarde a equipe autorizar este verificador e confirmar a implantação. Não recarregue a página.');
    }catch{token='';disable();message('Não foi possível preparar este navegador. Nenhuma inicialização foi solicitada. Pare e fale com a equipe.');}
  };
  byId('check').onclick=async()=>{
    byId('check').disabled=true;
    try{
      const r=await request('GET');
      if(r.status!==200||r.body.state!=='ready'||r.body.attempt!==attempt||r.body.retryAllowed!==false||Date.parse(r.body.expiresAt)!==expires||!/^[1-9]\d{0,9}$/.test(r.body.databaseOid))throw Error();
      checked=true;byId('target').textContent=`Banco descartável observado: OID ${r.body.databaseOid}. Confira com a equipe antes de autorizar.`;
      for(const id of ['password','repeat','approve','submit'])byId(id).disabled=false;
      message('Autorização conferida. Escolha uma senha provisória que você não usa em outro serviço. A senha não será mostrada ao agente.');
    }catch{disable();byId('status').disabled=!valid();message('Autorização não confirmada. Não repita nem gere outra chave; peça conferência à equipe.');}
  };
  byId('setup').onsubmit=async event=>{
    event.preventDefault();if(used||!checked)return;
    let password=byId('password').value;
    if(!valid()||!byId('approve').checked||password.length<10||password.length>256||password!==byId('repeat').value){password='';message('Confira prazo, confirmação e senhas iguais de 10 a 256 caracteres.');return;}
    used=true;disable();byId('password').value='';byId('repeat').value='';message('Solicitação única em andamento. Não feche ou repita.');
    let body={password,confirmation:'CREATE_EMPTY_SYNTHETIC_DATABASE_V1'};password='';
    try{
      const pending=request('POST',body);body.password='';body=undefined;
      const r=await pending;if(r.status!==201||r.body.state!=='completion-confirmed'||r.body.retryAllowed!==false)throw Error();
      token='';message('Conclusão confirmada. Aguarde a equipe fechar a janela; depois abra /login e troque a senha provisória.');
    }catch{byId('status').disabled=!valid();message('Resultado não confirmado. NÃO repita a inicialização. Consulte somente o resultado ou peça conferência à equipe.');}
  };
  byId('status').onclick=async()=>{
    byId('status').disabled=true;
    try{const r=await request('GET',undefined,true);if(r.status!==200||r.body.retryAllowed!==false||!['absence-observed','reservation-observed','completion-observed'].includes(r.body.state))throw Error();message(`Observação somente leitura: ${r.body.state}. Não autoriza repetir escrita. Peça conferência à equipe.`);}
    catch{message('Consulta não confirmada. Pare e peça conferência; não repita escrita.');}
  };
  addEventListener('pagehide',()=>{token='';used=true;byId('password').value='';byId('repeat').value='';});
  addEventListener('pageshow',event=>{if(event.persisted){disable();byId('status').disabled=true;message('Sessão descartada ao sair da página. Peça conferência à equipe antes de qualquer nova tentativa.');}});
})();
