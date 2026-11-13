import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

/**
 * O IXC exige **GET com corpo JSON** nas listagens — um padrão incomum que a
 * API `fetch` proíbe ("Request with GET/HEAD method cannot have body").
 *
 * Enquanto o LZR HUB falava com o IXC através da ponte na VM, isso não
 * aparecia: a ponte recebia POST e convertia para GET antes de repassar. Agora
 * que a aplicação chama o IXC direto (mesmo desenho do SeeNet), o problema
 * volta para cá — e é resolvido aqui, com o módulo `https` nativo.
 *
 * A função devolvida é compatível com `fetch`, então o provider continua
 * recebendo um `fetcher` injetável e os testes seguem usando dublês.
 */
export type IxcHttpMethod = "GET" | "POST";

export function resolveIxcHttpMethod(raw: string | undefined): IxcHttpMethod {
  return String(raw ?? "").trim().toUpperCase() === "POST" ? "POST" : "GET";
}

export function createIxcFetcher(method: IxcHttpMethod = "GET"): typeof fetch {
  // POST é suportado nativamente pelo fetch; só o GET com corpo precisa de ajuda.
  if (method === "POST") return fetch;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key] = value;
    headers["Content-Length"] = String(Buffer.byteLength(body));

    const send = url.protocol === "http:" ? httpRequest : httpsRequest;

    return new Promise<Response>((resolve, reject) => {
      const clientRequest = send({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve(new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 502,
            headers: Object.fromEntries(
              Object.entries(response.headers)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            ),
          }));
        });
        response.on("error", reject);
      });

      // O abort do AbortController precisa derrubar a conexão de verdade,
      // senão o timeout do provider não teria efeito.
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) { clientRequest.destroy(abortError()); return; }
        signal.addEventListener("abort", () => clientRequest.destroy(abortError()), { once: true });
      }

      clientRequest.on("error", reject);
      if (body) clientRequest.write(body);
      clientRequest.end();
    });
  }) as typeof fetch;
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/** Opt-in diagnostic bounds. Existing runtime calls retain their current policy. */
export interface IxcHttpLimits {
  origin: string;
  paths: readonly string[];
  timeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}

export type IxcTransportFailureCategory = "timeout" | "proxy-tunnel" | "tls-hostname" | "tls-trust" | "connection" | "response-limit" | "response-incomplete" | "response-invalid" | "policy" | "other";
/** Classify by closed equality catalogs only; never return exception content. */
export function diagnosticTransportFailure(error: unknown): IxcTransportFailureCategory {
  try {
    if (error instanceof DOMException && error.name === "AbortError") return "timeout";
    if (!(error instanceof Error)) return "other";
    const code = "code" in error ? error.code : undefined;
    if (code === "ERR_PROXY_TUNNEL") return "proxy-tunnel";
    if (code === "ERR_TLS_CERT_ALTNAME_INVALID") return "tls-hostname";
    if (["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_SIGNATURE_FAILURE"].includes(code as string)) return "tls-trust";
    if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(code as string)) return "connection";
    if (error.message === "IXC_RESPONSE_LIMIT") return "response-limit";
    if (error.message === "IXC_RESPONSE_INCOMPLETE" || error.message === "IXC_RESPONSE_ERROR") return "response-incomplete";
    if (error.message === "IXC_HTTP_RESPONSE_INVALID") return "response-invalid";
    if (error.message === "IXC_TRANSPORT_POLICY") return "policy";
    return "other";
  } catch { return "other"; }
}

export function createIxcDiagnosticFetcher(limits: IxcHttpLimits, agent?: import("node:https").Agent,
  onFailure?: (category: IxcTransportFailureCategory) => void): typeof fetch {
  if ((!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1
    || !Number.isSafeInteger(limits.maxRequestBytes) || limits.maxRequestBytes < 1
    || !Number.isSafeInteger(limits.maxResponseBytes) || limits.maxResponseBytes < 1)) throw new Error("IXC_TRANSPORT_POLICY");
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    if (limits && (url.origin !== limits.origin || url.username || url.password || url.search || url.hash
      || !limits.paths.includes(url.pathname) || Buffer.byteLength(body) > limits.maxRequestBytes)) throw new Error("IXC_TRANSPORT_POLICY");
    if (init?.signal?.aborted) throw new DOMException("Diagnostic transport aborted", "AbortError");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key] = value;
    headers["Content-Length"] = String(Buffer.byteLength(body));

    const send = url.protocol === "http:" ? httpRequest : httpsRequest;

    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const signal = init?.signal;
      const abort = () => {
        const error = new DOMException("Diagnostic transport aborted", "AbortError");
        fail(error); clientRequest.destroy(error);
      };
      const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
      const clientRequest = send({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: agent ?? false,
        ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
        headers,
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (limits && bytes > limits.maxResponseBytes) {
            const error = new Error("IXC_RESPONSE_LIMIT");
            fail(error); response.destroy(); clientRequest.destroy(); return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          cleanup();
          try { const result = new Response(Buffer.concat(chunks), {
            status: response.statusCode ?? 502,
            headers: Object.fromEntries(
              Object.entries(response.headers)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            ),
          }); if (!settled) { settled = true; resolve(result); } } catch { fail(new Error("IXC_HTTP_RESPONSE_INVALID")); }
        });
        response.on("aborted", () => fail(new Error("IXC_RESPONSE_INCOMPLETE")));
        response.on("error", () => fail(new Error("IXC_RESPONSE_ERROR")));
      });

      // O abort do AbortController precisa derrubar a conexão de verdade,
      // senão o timeout do provider não teria efeito.
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      if (limits) timer = setTimeout(() => {
        abort();
      }, limits.timeoutMs);

      clientRequest.on("error", fail);
      if (body) clientRequest.write(body);
      clientRequest.end();
    }).catch((error: unknown) => {
      try { onFailure?.(diagnosticTransportFailure(error)); } catch { /* Best-effort only. */ }
      throw error;
    });
  }) as typeof fetch;
}
