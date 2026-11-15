// Supervisor-only lifecycle helpers; no credentials, filesystem paths or DB SQL.
export const childRunning=child=>Boolean(child&&Number.isInteger(child.pid)&&child.pid>0&&child.exitCode===null&&child.signalCode===null);
export function createAppStopper({schedule=setTimeout,cancel=clearTimeout,graceMs=3000}={}){
 let requested;
 return child=>{
  if(!childRunning(child)||requested===child)return;
  requested=child;let timer;
  child.once('exit',()=>{if(timer)cancel(timer);});
  child.kill('SIGTERM');
  if(childRunning(child)){timer=schedule(()=>{if(childRunning(child))child.kill('SIGKILL');},graceMs);timer.unref?.();}
 };
}
export function checkStop(stopping){if(stopping)throw Error('STOP_REQUESTED');}
export async function withClosingClient(client,operation){
 // A failed connection/query must not leave an unowned client during PG shutdown.
 // The initializer can call close itself; all paths share one disposal promise.
 let closing,failed=false;
 const onError=()=>{failed=true;};client.on('error',onError);
 const close=()=>{closing??=Promise.resolve().then(()=>client.end());return closing;};
 let result;try{result=await operation(client,close);}finally{await close();}
 if(failed)throw Error('EPHEMERAL_CLIENT_FAILED');
 return result;
}
