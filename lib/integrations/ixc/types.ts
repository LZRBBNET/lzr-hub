export type IxcReadOperation =
  | "testConnection"
  | "findCustomer"
  | "getCustomer"
  | "listCustomers"
  | "listContracts"
  | "getPlan"
  | "listInvoices"
  | "listPayments"
  | "listServiceOrders"
  | "getConnection"
  | "getCity"
  /** Assuntos e setores de OS: configuração do provedor, não dado de cliente. */
  | "listOsCatalog"
  /** Carteiras de cobrança e condições de pagamento: definem juro, multa e parcelamento. */
  | "listFinanceCatalog";

/** Assunto de ordem de serviço (`su_oss_assunto`) — é o `id_assunto` que a OS exige. */
export interface IxcOsSubjectDto { id:string; name:string }
/** Setor (`empresa_setor`) — é o campo `setor` da OS, a fila que vai receber o chamado. */
export interface IxcSectorDto { id:string; name:string }
/** Carteira de cobrança (`fn_carteira_cobranca`) — é ela que define juro e multa da renegociação. */
export interface IxcCollectionWalletDto { id:string; name:string }
/** Condição de pagamento (`condicoes_pagamento`) — define em quantas parcelas a dívida é dividida. */
export interface IxcPaymentTermDto { id:string; name:string; installments?:number }

export interface IxcCustomerDto { id:string; name:string; document:string; phone:string; email:string; city:string; neighborhood:string; address:string; status:string; customerSince?:string; updatedAt?:string; /** `filial_id` do cadastro. A BBNET tem 21 filiais — abrir OS numa constante mandaria o chamado para a empresa errada. */ branchId?:string; /** `id_conta` do cadastro, exigido pelo wizard de renegociação. É por cliente, não do provedor. */ accountId?:string }
export interface IxcContractDto { id:string; customerId:string; planId?:string; planName:string; status:string; dueDay?:number; monthlyValue?:number; activatedAt?:string }
export interface IxcPlanDto { id:string; name:string; speed?:string; value?:number }
export interface IxcInvoiceDto { id:string; customerId:string; contractId?:string; status:string; dueAt?:string; value?:number; paymentCode?:string }
export interface IxcPaymentDto { id:string; customerId:string; invoiceId?:string; paidAt?:string; value?:number; method:string }
export interface IxcServiceOrderDto { id:string; customerId:string; status:string; subject:string; openedAt?:string; closedAt?:string; address?:string }
export interface IxcConnectionDto { id:string; customerId:string; login:string; status:string; lastAccessAt?:string; address?:string; equipmentDescriptor?:string; connectionType?:string }
/** Página da listagem de clientes. `total` é o tamanho do resultado no IXC, não o da página. */
export interface IxcCustomerPage { items:IxcCustomerDto[]; total:number; page:number; pageSize:number }
export interface IxcCustomerSnapshot { customer:IxcCustomerDto; contracts:IxcContractDto[]; plan:IxcPlanDto|null; invoices:IxcInvoiceDto[]; payments:IxcPaymentDto[]; serviceOrders:IxcServiceOrderDto[]; connection:IxcConnectionDto|null; partialSources:string[]; metrics:{totalLatencyMs:number;blockLatencies:Record<string,number>}; fetchedAt:string; mode:"staging-readonly"; cache:"hit"|"miss" }
export interface IxcListResponse { registros?:unknown[]; total?:number|string; page?:number|string; [key:string]:unknown }
