import { assertSyntheticDemo } from '../integrations/ixc/synthetic-demo.ts';
import { getIxcRuntime } from "../integrations/ixc/runtime.ts";
import { Customer360Service } from "./customer360-service";

const coverageKeys={"IXC contratos":"contracts","IXC financeiro":"invoices","IXC pagamentos":"payments","IXC ordens de serviço":"serviceOrders"} as const;
let service:Customer360Service|undefined;
export function getCustomer360Service(){
  if(process.env.FEATURE_SYNTHETIC_INVOICES!==undefined&&process.env.FEATURE_SYNTHETIC_INVOICES!=="false"){
    assertSyntheticDemo();
    const {provider}=getIxcRuntime();
    const synthetic=new Customer360Service(undefined,provider,["10"],false);
    return new Proxy(synthetic,{get(target,key){
      const value=Reflect.get(target,key);
      if(typeof value!=="function")return value;
      return async (...args:unknown[])=>{
        assertSyntheticDemo();
        const result=await value.apply(target,args);
        if(result){
          result.mode="demo";
          if(result.customer)result.customer={...result.customer,tags:["DEMO sintética"]};
          if(result.sources)result.sources=result.sources.map((source:Record<string,unknown>)=>({...source,coverageKey:coverageKeys[source.provider as keyof typeof coverageKeys],provider:"Fonte sintética",mode:"demo",detail:"Dados fictícios; sem consulta ao IXC"}));
          if(result.items)result.items=result.items.map((item:Record<string,unknown>)=>({...item,tags:["DEMO sintética"]}));
        }
        return result;
      };
    }});
  }
  if(service)return service;const {config,provider}=getIxcRuntime();
  if(!provider)return service=new Customer360Service();
  return service=new Customer360Service(undefined,provider,config.ixcAllowlist,config.ixcFullBase);
}
