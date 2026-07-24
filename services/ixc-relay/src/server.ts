import { createServer } from "node:http";
import { Readable } from "node:stream";
import { loadRelayConfig } from "./config.ts";
import { createRelayApp } from "./app.ts";

const config = loadRelayConfig();
const app = createRelayApp(config);

const server = createServer(async (incoming, outgoing) => {
  try {
    const origin = `http://${config.host}:${config.port}`;
    const body = incoming.method === "GET" || incoming.method === "HEAD"
      ? undefined
      : Readable.toWeb(incoming) as ReadableStream;
    const request = new Request(new URL(incoming.url ?? "/", origin), {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body,
      duplex: body ? "half" : undefined,
    } as RequestInit & { duplex?: "half" });
    const response = await app.fetch(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    if (!response.body) return outgoing.end();
    Readable.fromWeb(response.body as never).pipe(outgoing);
  } catch {
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ status: "error" }));
  }
});

server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.keepAliveTimeout = 5_000;
server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    status: "listening",
    host: config.host,
    port: config.port,
    environment: config.environment,
  }));
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
