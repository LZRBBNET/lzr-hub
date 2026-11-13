import { validateHeaderValue } from "node:http";

/** Syntax only: no documented placeholder format proves a network-secret binding. */
export function diagnosticAuthorization(source: Record<string, string | undefined>): string {
  const value = source.IXC_DIRECT_AUTHORIZATION;
  if (typeof value !== "string" || !value || value.length > 512 || value !== value.trim() || /[\r\n]/.test(value)) {
    throw new Error("IXC_DIAGNOSTIC_AUTHORIZATION_UNCONFIRMED");
  }
  try { validateHeaderValue("Authorization", value); }
  catch { throw new Error("IXC_DIAGNOSTIC_AUTHORIZATION_UNCONFIRMED"); }
  return value;
}

/** Override the provider's unused Basic header; never encode or prefix the opaque value. */
export function withDiagnosticAuthorization(transport: typeof fetch, value: string): typeof fetch {
  const authorization = diagnosticAuthorization({ IXC_DIRECT_AUTHORIZATION: value });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", authorization);
    return transport(input, { ...init, headers: Object.fromEntries(headers.entries()) });
  }) as typeof fetch;
}
