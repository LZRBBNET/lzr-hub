import { customers } from "./demo-data.ts";
import { businessToday } from "./billing-service.ts";
import type { IxcCustomerSnapshot, IxcSnapshotCoverage } from "../integrations/ixc/types.ts";
import type { CustomerSummary, DataSource } from "./types.ts";
import type { IxcReadonlyProvider } from "../integrations/ixc/readonly-provider.ts";

export interface Customer360 {
  customer: CustomerSummary;
  contact: { phone:string; email:string; address:string; customerSince:string };
  contract: { id:string; plan:string; monthlyValue:number|null; dueDay:number; status:string; since:string };
  finance: { openInvoices:number; overdueAmount:number|null; lastPayment:string; paymentMethod:string };
  network: { onu:string; onuStatus:string; pppoe:string; opticalPower:string; uptime:string; devices:number; equipmentDescriptor:string; connectionType:string };
  support: { openTickets:number; lastProtocol:string; lastReason:string; csat:number };
  intelligence: { health:number; churnRisk:string; upgradeEligible:boolean; recommendedPlan:string; reason:string };
  details?: { contracts:number; invoices:number; payments:number; serviceOrders:number };
  reading?: {
    observedAt:string; referenceDate:string;
    coverage:Record<"contracts"|"invoices"|"payments"|"serviceOrders",IxcSnapshotCoverage>;
    contracts:Array<{id:string;status:string;plan:string}>;
    contractSelection:"single"|"ambiguous"|"none"|"unavailable";
    financeAvailable:boolean; financeComplete:boolean; excludedInvoices:number; nominalValueInvoices:number;
  };
  totalLatencyMs?:number;
  mode: "demo"|"staging-readonly";
  sources: DataSource[];
  partial: boolean;
}

/** No evidence of completeness is different from an empty, complete response. */
function scopedRows<T extends {id:string;customerId:string}>(rows:T[],customerId:string):T[]{
  const counts=new Map<string,number>();
  for(const row of rows)counts.set(row.id,(counts.get(row.id)??0)+1);
  return rows.filter(row=>typeof row.id==="string"&&!!row.id.trim()&&row.customerId===customerId&&counts.get(row.id)===1);
}
function coverageOf(snapshot:IxcCustomerSnapshot,key:"contracts"|"invoices"|"payments"|"serviceOrders",rawCount:number,validCount:number):IxcSnapshotCoverage{
  const metadata=snapshot.coverage?.[key];const limit=key==="payments"?100:20;
  const total=metadata?.total;
  const knownTotal=typeof total==="number"&&Number.isSafeInteger(total)&&total>=rawCount?total:null;
  return {read:validCount,total:knownTotal,limit,complete:!snapshot.partialSources.includes(key)&&metadata?.complete===true&&metadata.read===rawCount&&knownTotal===rawCount&&rawCount===validCount&&rawCount<=limit};
}
function calendarDate(raw:string|undefined):string|null{
  if(!raw||!/^\d{4}-\d{2}-\d{2}$/.test(raw))return null;
  const date=new Date(`${raw}T00:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===raw?raw:null;
}
/** Pagamentos não têm horário/fuso garantido. Comparamos a data, não uma hora inventada. */
function paymentDate(raw:string|undefined):string|null{
  if(!raw)return null;
  if(calendarDate(raw))return raw;
  const match=/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(raw);
  if(!match||!calendarDate(match[1])||Number(match[2])>23||Number(match[3])>59||Number(match[4])>59)return null;
  if(!match[5])return match[1];
  if(match[5]!=="Z"&&(Number(match[5].slice(1,3))>23||Number(match[5].slice(4))>59))return null;
  const moment=new Date(raw.replace(" ","T"));
  return Number.isFinite(moment.getTime())?businessToday(moment):null;
}
function invoiceFinance(snapshot:IxcCustomerSnapshot,invoices:IxcCustomerSnapshot["invoices"],coverage:IxcSnapshotCoverage,today:string){
  const available=!snapshot.partialSources.includes("invoices");
  let cents=0,knownAmounts=0,openInvoices=0,excludedInvoices=snapshot.invoices.length-invoices.length,nominalValueInvoices=0;
  for(const invoice of invoices){
    const status=invoice.status.trim().toUpperCase();
    if(status==="R"||status==="C")continue;
    if(status!=="A"){excludedInvoices++;continue;}
    openInvoices++;
    const due=calendarDate(invoice.dueAt);
    if(!due){excludedInvoices++;continue;}
    if(due>=today)continue;
    const value=invoice.value;
    const amount=typeof value==="number"?Math.round(value*100):NaN;
    if(typeof value!=="number"||!Number.isFinite(value)||value<0||!Number.isSafeInteger(amount)||!Number.isSafeInteger(cents+amount)){excludedInvoices++;continue;}
    if(invoice.valueSource!=="open-balance"){nominalValueInvoices++;continue;}
    cents+=amount;knownAmounts++;
  }
  const complete=available&&coverage.complete&&excludedInvoices===0&&nominalValueInvoices===0;
  // Partial/unknown evidence cannot turn into an apparent zero debt.
  const overdueAmount=!available||(!complete&&cents===0)||(!knownAmounts&&excludedInvoices>0)?null:cents/100;
  return {available,complete,openInvoices,overdueAmount,excludedInvoices,nominalValueInvoices};
}

type Loader<T> = () => Promise<T>;
const delay = async <T>(value:T,ms=12) => { await new Promise((resolve)=>setTimeout(resolve,ms)); return value; };

export class Customer360Service {
  private readonly loaders?:Partial<Record<"contract"|"finance"|"network"|"support"|"intelligence",Loader<unknown>>>; private readonly ixc?:IxcReadonlyProvider; private readonly allowedIds:string[]; private readonly fullBase:boolean; private readonly now:()=>Date;
  constructor(loaders?: Partial<Record<"contract"|"finance"|"network"|"support"|"intelligence",Loader<unknown>>>,ixc?:IxcReadonlyProvider,allowedIds:string[]=[],fullBase=false,now:()=>Date=()=>new Date()){this.loaders=loaders;this.ixc=ixc;this.allowedIds=allowedIds;this.fullBase=fullBase;this.now=now;}

  async list(query="",risk="all",page=1,pageSize=10) {
    if(this.ixc)return this.listIxc(query,page,pageSize);
    const term=query.trim().toLocaleLowerCase("pt-BR");
    const filtered=customers.filter((customer)=>(!term||[customer.name,customer.city,customer.neighborhood,customer.id].some((value)=>value.toLocaleLowerCase("pt-BR").includes(term)))&&(risk==="all"||customer.churnRisk===risk));
    return { items:filtered.slice((page-1)*pageSize,page*pageSize), total:filtered.length, page, pageSize, mode:"demo" as const };
  }

  /**
   * O IXC não expõe uma listagem segura de toda a base, então a lista é a
   * allowlist — mas com o cadastro real de cada um, buscado do próprio ERP
   * (o snapshot é cacheado, então abrir o detalhe depois não consulta de novo).
   * Se a consulta de um cadastro falhar, ele aparece marcado como indisponível;
   * nunca com nome ou plano inventado.
   */
  private async listIxc(query:string,page:number,pageSize:number){
    // Base inteira liberada: uma consulta paginada resolve a lista. Com allowlist
    // continua sendo o snapshot de cada cadastro autorizado (são no máximo 10).
    if(this.fullBase){
      const result=await this.ixc!.listCustomers(query,page,pageSize,crypto.randomUUID());
      return{items:result.items.map((customer):CustomerSummary=>({id:customer.id,name:customer.name,maskedDocument:customer.document,city:customer.city,neighborhood:customer.neighborhood,plan:"Abrir para consultar",status:customer.status==="S"?"Ativo":customer.status==="N"?"Inativo":customer.status,priority:"—",tags:["IXC somente leitura"]})),total:result.total,page:result.page,pageSize:result.pageSize,mode:"staging-readonly" as const,scope:"full-base" as const};
    }
    const settled=await Promise.allSettled(this.allowedIds.map((id)=>this.ixc!.getSnapshot(id,crypto.randomUUID())));
    const items=settled.map((result,index):CustomerSummary=>{
      const id=this.allowedIds[index];
      if(result.status!=="fulfilled")return{id,name:`Cadastro ${id}`,maskedDocument:"Consulta indisponível",city:"—",neighborhood:"—",plan:"—",status:"Fonte indisponível",priority:"Indisponível",tags:["IXC indisponível"]};
      const snapshot=result.value;
      if(snapshot.customer.id!==id)return{id,name:`Cadastro ${id}`,maskedDocument:"Consulta indisponível",city:"—",neighborhood:"—",plan:"—",status:"Fonte indisponível",priority:"Indisponível",tags:["IXC indisponível"]};
      const contracts=scopedRows(snapshot.contracts,id);const complete=coverageOf(snapshot,"contracts",snapshot.contracts.length,contracts.length).complete;const contract=complete&&contracts.length===1?contracts[0]:undefined;
      return{id,name:snapshot.customer.name,maskedDocument:snapshot.customer.document,city:snapshot.customer.city,neighborhood:snapshot.customer.neighborhood,plan:contract?.planName??"Abrir para consultar",status:snapshot.customer.status,priority:"Controlada",tags:["IXC somente leitura"]};
    });
    const term=query.trim().toLocaleLowerCase("pt-BR");
    const filtered=term?items.filter((item)=>[item.id,item.name,item.maskedDocument,item.city,item.neighborhood].some((value)=>value.toLocaleLowerCase("pt-BR").includes(term))):items;
    return{items:filtered.slice((page-1)*pageSize,page*pageSize),total:filtered.length,page,pageSize,mode:"staging-readonly" as const,scope:"allowlist" as const};
  }

  async get(customerId:string):Promise<Customer360|null> {
    if(this.ixc)return this.getIxc(customerId,false);
    const customer=customers.find((item)=>item.id===customerId); if(!customer) return null;
    const defaults = {
      contract:()=>delay({id:"CTR-2022-1934",plan:customer.plan,monthlyValue:89.9,dueDay:10,status:customer.status,since:"18/03/2022"}),
      finance:()=>delay({openInvoices:1,overdueAmount:customer.status==="Bloqueado"?179.8:0,lastPayment:"10/06/2026",paymentMethod:"PIX"}),
      network:()=>delay({onu:"FiberHome AN5506",onuStatus:"Online",pppoe:customer.id==="DEMO-CLI-001"?"Offline":"Online",opticalPower:"-19,8 dBm",uptime:"2d 14h",devices:8,equipmentDescriptor:"OLT-DEMO / PON 4",connectionType:"Fibra (fictício)"}),
      support:()=>delay({openTickets:customer.churnRisk==="high"?2:0,lastProtocol:"LZR-260711-1842",lastReason:"Intermitência",csat:(customer.health??0)>80?5:3}),
      intelligence:()=>delay({health:customer.health,churnRisk:customer.churnRisk,upgradeEligible:customer.plan!=="600 Mega",recommendedPlan:"600 Mega",reason:"Uso e quantidade de dispositivos"}),
    };
    const keys=Object.keys(defaults) as (keyof typeof defaults)[];
    const results=await Promise.allSettled(keys.map((key)=>(this.loaders?.[key]??defaults[key])()));
    const sources:DataSource[]=results.map((result,index)=>({provider:keys[index]==="network"?"Monitoramento Mock":keys[index]==="intelligence"?"LZR HUB":"IXC Mock",updatedAt:new Date().toISOString(),state:result.status==="fulfilled"?"ready":"error",detail:result.status==="rejected"?"Fonte temporariamente indisponível":undefined}));
    const value=<T>(key:keyof typeof defaults,fallback:T):T=>{const result=results[keys.indexOf(key)]; return result.status==="fulfilled"?result.value as T:fallback;};
    return { customer, contact:{phone:"(00) 00000-0000 (sintético inválido)",email:`${customer.id.toLowerCase()}@exemplo.invalid`,address:`Rua Demonstração, 100 - ${customer.neighborhood}, ${customer.city}`,customerSince:"18/03/2022"}, contract:value("contract",{id:"—",plan:customer.plan,monthlyValue:0,dueDay:0,status:"Indisponível",since:"—"}), finance:value("finance",{openInvoices:0,overdueAmount:0,lastPayment:"Indisponível",paymentMethod:"—"}), network:value("network",{onu:"Indisponível",onuStatus:"Indisponível",pppoe:"—",opticalPower:"—",uptime:"—",devices:0,equipmentDescriptor:"—",connectionType:"—"}), support:value("support",{openTickets:0,lastProtocol:"—",lastReason:"Indisponível",csat:0}), intelligence:value("intelligence",{health:customer.health??0,churnRisk:customer.churnRisk??"low",upgradeEligible:false,recommendedPlan:"—",reason:"Fonte indisponível"}), sources, partial:results.some((item)=>item.status==="rejected"),mode:"demo" };
  }

  async refresh(customerId:string){if(!this.ixc)return this.get(customerId);return this.getIxc(customerId,true);}

  private async getIxc(customerId:string,force:boolean):Promise<Customer360>{
    const snapshot=await this.ixc!.getSnapshot(customerId,crypto.randomUUID(),force);
    if(snapshot.customer.id!==customerId)throw new Error("IXC_CUSTOMER_SCOPE_MISMATCH");
    const contracts=scopedRows(snapshot.contracts,customerId).slice(0,20);
    const invoices=scopedRows(snapshot.invoices,customerId).slice(0,20);
    const invoiceIds=new Set(invoices.map(row=>row.id));
    const today=businessToday(this.now());
    const payments=scopedRows(snapshot.payments,customerId).flatMap(row=>{
      const paidOn=paymentDate(row.paidAt);
      return row.invoiceId&&invoiceIds.has(row.invoiceId)&&paidOn&&paidOn<=today?[{...row,paidOn}]:[];
    }).slice(0,100);
    const orders=scopedRows(snapshot.serviceOrders,customerId).slice(0,20);
    const coverage={
      contracts:coverageOf(snapshot,"contracts",snapshot.contracts.length,contracts.length),
      invoices:coverageOf(snapshot,"invoices",snapshot.invoices.length,invoices.length),
      payments:coverageOf(snapshot,"payments",snapshot.payments.length,payments.length),
      serviceOrders:coverageOf(snapshot,"serviceOrders",snapshot.serviceOrders.length,orders.length),
    };
    const contract=coverage.contracts.complete&&contracts.length===1?contracts[0]:undefined;
    const contractSelection=snapshot.partialSources.includes("contracts")?"unavailable":contract?"single":coverage.contracts.complete&&contracts.length===0?"none":"ambiguous";
    const finance=invoiceFinance(snapshot,invoices,coverage.invoices,today);
    const latestPayment=[...payments].sort((a,b)=>b.paidOn.localeCompare(a.paidOn))[0];
    const connection=snapshot.connection?.customerId===customerId?snapshot.connection:null;
    // CustomerSummary é o tipo compartilhado com a lista/modo demo -- a chave continua
    // "maskedDocument" por compatibilidade, mas em staging-readonly carrega o CPF/CNPJ
    // completo: a proteção passou a ser sessão + RBAC (login obrigatório), não mais texto
    // truncado. Ver decisão registrada ao lado do pedido do Breno de tela completa.
    const customer:CustomerSummary={id:snapshot.customer.id,name:snapshot.customer.name,maskedDocument:snapshot.customer.document,city:snapshot.customer.city,neighborhood:snapshot.customer.neighborhood,plan:contract?.planName??"Não informado",status:snapshot.customer.status,priority:"Controlada",tags:["IXC somente leitura"]};
    const source=(provider:string,key:string,partialKey:string):DataSource=>({provider,updatedAt:snapshot.fetchedAt,state:snapshot.partialSources.includes(partialKey)?"error":"ready",detail:snapshot.partialSources.includes(partialKey)?"Fonte indisponível; restante preservado":"Dado real do IXC",mode:"staging-readonly",cache:snapshot.cache,masked:false,latencyMs:snapshot.metrics.blockLatencies[key]??0});
    return{
      customer,
      contact:{phone:snapshot.customer.phone,email:snapshot.customer.email,address:snapshot.customer.address,customerSince:snapshot.customer.customerSince??"Não informado"},
      contract:{id:contract?.id??"—",plan:contract?.planName??"Nenhum contrato selecionado",monthlyValue:contract?.monthlyValue??null,dueDay:contract?.dueDay??0,status:contract?.status??"Indisponível",since:contract?.activatedAt??"—"},
      finance:{openInvoices:finance.openInvoices,overdueAmount:finance.overdueAmount,lastPayment:latestPayment?.paidOn??"Não encontrado nos registros consultados",paymentMethod:latestPayment?.method??"—"},
      // ONU, potência óptica e quantidade de dispositivos genuinamente não vêm do endpoint
      // de conexão do IXC (confirmado consultando um cliente real) -- mensagem honesta em
      // vez de sugerir que só não perguntamos.
      network:{onu:"Não disponibilizado pelo IXC",onuStatus:connection?.status==="N"?"Offline":connection?.status==="S"?"Online":connection?.status??"Indisponível",pppoe:connection?.login??"Indisponível",opticalPower:"Não disponibilizado pelo IXC",uptime:connection?.lastAccessAt??"—",devices:0,equipmentDescriptor:connection?.equipmentDescriptor??"Não disponibilizado pelo IXC",connectionType:connection?.connectionType??"Não informado"},
      support:{openTickets:orders.filter((item)=>!/[F]|fechad/i.test(item.status)).length,lastProtocol:orders[0]?.id??"—",lastReason:orders[0]?.subject??"Sem OS",csat:0},
      intelligence:{health:0,churnRisk:"não calculado",upgradeEligible:false,recommendedPlan:"—",reason:"Nenhum modelo calcula saúde ou risco: os sinais necessários não são coletados. Ver docs/telas-removidas.md"},
      details:{contracts:contracts.length,invoices:invoices.length,payments:payments.length,serviceOrders:orders.length},
      reading:{observedAt:snapshot.fetchedAt,referenceDate:today,coverage,contracts:contracts.map(item=>({id:item.id,status:item.status,plan:item.planName})),contractSelection,financeAvailable:finance.available,financeComplete:finance.complete,excludedInvoices:finance.excludedInvoices,nominalValueInvoices:finance.nominalValueInvoices},
      totalLatencyMs:snapshot.metrics.totalLatencyMs,
      sources:[source("IXC cliente","getCustomer","customer"),source("IXC contratos","listContracts","contracts"),source("IXC plano","getPlan","plan"),source("IXC financeiro","listInvoices","invoices"),source("IXC pagamentos","listPayments","payments"),source("IXC ordens de serviço","listServiceOrders","serviceOrders"),source("IXC conexão","getConnection","connection")],
      partial:snapshot.partialSources.length>0||!finance.complete||!coverage.contracts.complete||!coverage.payments.complete||!coverage.serviceOrders.complete,
      mode:"staging-readonly",
    };
  }
}
