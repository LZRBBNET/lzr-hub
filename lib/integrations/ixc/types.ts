export type IxcReadOperation =
  | "testConnection"
  | "findCustomer"
  | "getCustomer"
  | "listContracts"
  | "getPlan"
  | "listInvoices"
  | "listPayments"
  | "listServiceOrders"
  | "getConnection"
  | "getCity";

export interface IxcCustomerDto { id:string; name:string; document:string; phone:string; email:string; city:string; neighborhood:string; address:string; status:string; customerSince?:string; updatedAt?:string }
export interface IxcContractDto { id:string; customerId:string; planId?:string; planName:string; status:string; dueDay?:number; monthlyValue?:number; activatedAt?:string }
export interface IxcPlanDto { id:string; name:string; speed?:string; value?:number }
export interface IxcInvoiceDto { id:string; customerId:string; contractId?:string; status:string; dueAt?:string; value?:number; paymentCode?:string }
export interface IxcPaymentDto { id:string; customerId:string; invoiceId?:string; paidAt?:string; value?:number; method:string }
export interface IxcServiceOrderDto { id:string; customerId:string; status:string; subject:string; openedAt?:string; closedAt?:string }
export interface IxcConnectionDto { id:string; customerId:string; login:string; status:string; lastAccessAt?:string; address?:string; equipmentDescriptor?:string; connectionType?:string }
export interface IxcCustomerSnapshot { customer:IxcCustomerDto; contracts:IxcContractDto[]; plan:IxcPlanDto|null; invoices:IxcInvoiceDto[]; payments:IxcPaymentDto[]; serviceOrders:IxcServiceOrderDto[]; connection:IxcConnectionDto|null; partialSources:string[]; metrics:{totalLatencyMs:number;blockLatencies:Record<string,number>}; fetchedAt:string; mode:"staging-readonly"; cache:"hit"|"miss" }
export interface IxcListResponse { registros?:unknown[]; total?:number|string; page?:number|string; [key:string]:unknown }
