import type { RelayConfig } from "./config.ts";
import { RelayIxcClient } from "./ixc/client.ts";
import { createLogger, RelayMetrics, type LogSink } from "./observability/logger.ts";
import { healthResponse, readinessResponse } from "./routes/health.ts";
import { handleIxcRead } from "./routes/ixc-read.ts";
import { NonceStore } from "./security/replay-protection.ts";

export interface RelayAppOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  logSink?: LogSink;
}

export function createRelayApp(config: RelayConfig, options: RelayAppOptions = {}) {
  const client = new RelayIxcClient(config, { fetcher: options.fetcher, now: options.now });
  const nonces = new NonceStore(config.nonceTtlSeconds * 1000, options.now);
  const metrics = new RelayMetrics();
  const log = createLogger(config.environment, options.logSink);

  return {
    metrics,
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz" && request.method === "GET") return healthResponse();
      if (url.pathname === "/readyz" && request.method === "GET") return readinessResponse(config);
      if (url.pathname === "/v1/ixc/read" || url.pathname === "/v1/ixc/test-connection") {
        return handleIxcRead(request, { config, client, nonces, metrics, log, now: options.now });
      }
      return Response.json({ status: "not_found" }, { status: 404 });
    },
  };
}
