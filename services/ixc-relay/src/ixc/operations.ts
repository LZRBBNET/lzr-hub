export const ALL_OPERATION_NAMES = [
  "testConnection",
  "getCustomer",
  "listContracts",
  "getPlan",
  "listInvoices",
  "listPayments",
  "listServiceOrders",
  "getConnection",
] as const;

export type RelayOperationName = typeof ALL_OPERATION_NAMES[number];

export interface RelayOperationRequest {
  operation: RelayOperationName;
  parameters: {
    customerId?: string;
    planId?: string;
    pageSize?: number;
  };
}

interface OperationDefinition {
  resource: string;
  qtype: string;
  query: (parameters: RelayOperationRequest["parameters"]) => string;
  requiresCustomer: boolean;
  maximumPageSize: number;
}

export const OPERATION_DEFINITIONS: Record<RelayOperationName, OperationDefinition> = {
  testConnection: { resource: "cliente", qtype: "id", query: () => "0", requiresCustomer: false, maximumPageSize: 1 },
  getCustomer: { resource: "cliente", qtype: "id", query: ({ customerId }) => required(customerId), requiresCustomer: true, maximumPageSize: 1 },
  listContracts: { resource: "cliente_contrato", qtype: "id_cliente", query: ({ customerId }) => required(customerId), requiresCustomer: true, maximumPageSize: 20 },
  getPlan: { resource: "vd_contratos", qtype: "id", query: ({ planId }) => required(planId), requiresCustomer: true, maximumPageSize: 1 },
  listInvoices: { resource: "fn_areceber", qtype: "id_cliente", query: ({ customerId }) => required(customerId), requiresCustomer: true, maximumPageSize: 20 },
  listPayments: { resource: "fn_movim_finan", qtype: "id_cliente", query: ({ customerId }) => required(customerId), requiresCustomer: true, maximumPageSize: 20 },
  listServiceOrders: { resource: "su_oss_chamado", qtype: "id_cliente", query: ({ customerId }) => required(customerId), requiresCustomer: true, maximumPageSize: 20 },
  getConnection: { resource: "radusuarios", qtype: "id_cliente", query: ({ customerId }) => required(customerId), requiresCustomer: true, maximumPageSize: 20 },
};

const identifier = /^[A-Za-z0-9_-]{1,64}$/;

export function parseOperationRequest(value: unknown): RelayOperationRequest {
  if (!isRecord(value)) throw new Error("RELAY_REQUEST_INVALID");
  assertExactKeys(value, ["operation", "parameters"]);
  if (!ALL_OPERATION_NAMES.includes(value.operation as RelayOperationName)) throw new Error("RELAY_OPERATION_FORBIDDEN");
  if (!isRecord(value.parameters)) throw new Error("RELAY_PARAMETERS_INVALID");
  assertExactKeys(value.parameters, ["customerId", "planId", "pageSize"]);

  const operation = value.operation as RelayOperationName;
  const definition = OPERATION_DEFINITIONS[operation];
  const customerId = optionalIdentifier(value.parameters.customerId);
  const planId = optionalIdentifier(value.parameters.planId);
  const pageSize = optionalPageSize(value.parameters.pageSize, definition.maximumPageSize);
  if (definition.requiresCustomer && !customerId) throw new Error("RELAY_CUSTOMER_REQUIRED");
  if (operation === "getPlan" && !planId) throw new Error("RELAY_PLAN_REQUIRED");
  if (operation === "testConnection" && Object.keys(value.parameters).length > 0) throw new Error("RELAY_PARAMETERS_INVALID");
  return { operation, parameters: { customerId, planId, pageSize } };
}

function optionalIdentifier(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !identifier.test(value)) throw new Error("RELAY_IDENTIFIER_INVALID");
  return value;
}

function optionalPageSize(value: unknown, maximum: number) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new Error("RELAY_PAGE_SIZE_INVALID");
  return Number(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("RELAY_FIELD_FORBIDDEN");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function required(value: string | undefined) {
  if (!value) throw new Error("RELAY_PARAMETER_REQUIRED");
  return value;
}
