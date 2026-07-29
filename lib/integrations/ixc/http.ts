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
