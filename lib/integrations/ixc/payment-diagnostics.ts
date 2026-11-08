/** Fixed vocabulary only. Never pass business identity, request or exception content. */
const phases = ["runtime", "provider-guard", "ownership-before", "movements", "movement-validation", "ownership-after", "projection", "response-identity", "audit", "response"] as const;
const steps = ["configuration", "guard", "rate-limit", "transport", "http-status", "json", "api-status", "shape", "identity", "serialization"] as const;
export type PaymentDiagnosticPhase = typeof phases[number];
export type PaymentDiagnosticStep = typeof steps[number];
export type PaymentDiagnosticObserver = (phase:PaymentDiagnosticPhase,step:PaymentDiagnosticStep)=>void;
export function paymentDiagnosticProgress(observer:PaymentDiagnosticObserver|undefined,phase:PaymentDiagnosticPhase,step:PaymentDiagnosticStep):void {
  try { if(phases.includes(phase)&&steps.includes(step))observer?.(phase,step); } catch { /* Observational only. */ }
}
const categories = new Set([
  "IXC_INVALID_PAYMENT_PAGE", "IXC_INVOICE_OWNERSHIP_UNCONFIRMED", "IXC_PAYMENT_ROWS_INVALID", "IXC_PAYMENT_PAGE_MISMATCH", "IXC_PAYMENT_PAGE_LIMIT",
  "IXC_PAYMENT_INVOICE_LINK_INVALID", "IXC_PAYMENT_INVOICE_LINK_MISSING", "IXC_PAYMENT_INVOICE_LINK_CONFLICT", "IXC_PAYMENT_INVOICE_LINK_MISMATCH",
  "IXC_PAYMENT_ID_DUPLICATE", "IXC_PAYMENT_ORDER_UNCONFIRMED", "IXC_PAYMENT_CARDINALITY_UNCONFIRMED", "IXC_TIMEOUT", "IXC_NETWORK_ERROR",
  "IXC_API_ERROR", "IXC_IP_NOT_ALLOWED", "IXC_AUTHENTICATION_FAILED", "IXC_PERMISSION_DENIED", "IXC_RATE_LIMITED", "IXC_CIRCUIT_OPEN",
]);
function category(error:unknown):string {
  try {
    if(!(error instanceof Error))return "unclassified";
    if(error.name==="IxcCustomerNotAllowedError")return "customer-scope-rejected";
    if(categories.has(error.message))return error.message;
    if(/^IXC_HTTP_[1-5]\d{2}$/.test(error.message))return "ixc-http-error";
    return "unclassified";
  } catch { return "unclassified"; }
}
/** One terminal event per invocation. Local closure cannot leak state across requests. */
export function createPaymentDiagnostic(){
  let phase:PaymentDiagnosticPhase="runtime",step:PaymentDiagnosticStep="configuration";
  const progress:PaymentDiagnosticObserver=(nextPhase,nextStep)=>{
    if(phases.includes(nextPhase)&&steps.includes(nextStep)){phase=nextPhase;step=nextStep;}
  };
  const finish=(outcome:"success"|"failure"|"unavailable",error?:unknown)=>{
    try { console.info(JSON.stringify({event:"ixc.paymentLookupDiagnostic",version:1,phase,step,outcome,category:outcome==="failure"?category(error):"none"})); } catch { /* Logging never changes result. */ }
  };
  return {progress,finish};
}
