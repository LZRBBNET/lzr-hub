import { getIxcRuntime } from "../integrations/ixc/runtime.ts";
import { Customer360Service } from "./customer360-service";

let service:Customer360Service|undefined;
export function getCustomer360Service(){
  if(service)return service;const {config,provider}=getIxcRuntime();
  if(!provider)return service=new Customer360Service();
  return service=new Customer360Service(undefined,provider,config.ixcAllowlist);
}
