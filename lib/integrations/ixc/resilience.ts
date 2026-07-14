export class TtlCache<T> {
  private readonly entries = new Map<string,{value:T;expiresAt:number}>();
  private readonly ttlMs:number; private readonly now:()=>number;
  constructor(ttlMs:number,now=()=>Date.now()){this.ttlMs=ttlMs;this.now=now;}
  get(key:string){const entry=this.entries.get(key);if(!entry)return undefined;if(entry.expiresAt<=this.now()){this.entries.delete(key);return undefined}return entry.value;}
  set(key:string,value:T){this.entries.set(key,{value,expiresAt:this.now()+this.ttlMs});}
  delete(key:string){this.entries.delete(key);}
}

export class CircuitBreaker {
  private failures=0; private openedAt=0;
  private readonly threshold:number; private readonly cooldownMs:number; private readonly now:()=>number;
  constructor(threshold=3,cooldownMs=30000,now=()=>Date.now()){this.threshold=threshold;this.cooldownMs=cooldownMs;this.now=now;}
  canRequest(){if(!this.openedAt)return true;if(this.now()-this.openedAt>=this.cooldownMs){this.failures=0;this.openedAt=0;return true}return false;}
  success(){this.failures=0;this.openedAt=0;}
  failure(){this.failures+=1;if(this.failures>=this.threshold)this.openedAt=this.now();}
  state(){return this.canRequest()?"closed":"open";}
}

export class SlidingWindowRateLimiter {
  private calls:number[]=[];
  private readonly max:number; private readonly windowMs:number; private readonly now:()=>number;
  constructor(max:number,windowMs=60000,now=()=>Date.now()){this.max=max;this.windowMs=windowMs;this.now=now;}
  assert(){const cutoff=this.now()-this.windowMs;this.calls=this.calls.filter((time)=>time>cutoff);if(this.calls.length>=this.max)throw new Error("IXC_RATE_LIMITED");this.calls.push(this.now());}
}
