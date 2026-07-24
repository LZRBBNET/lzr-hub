import type { RelayConfig } from "../config.ts";

export function healthResponse() {
  return Response.json({ status: "ok" });
}

export function readinessResponse(config: RelayConfig) {
  const ready = config.host === "127.0.0.1"
    && config.allowedCustomerIds.size > 0
    && config.allowedOperations.size > 0
    && config.hmacSecret.length >= 32
    && config.apiToken.length > 0
    && config.upstreamBaseUrl.startsWith("https://");
  return Response.json({ status: ready ? "ok" : "not_ready" }, { status: ready ? 200 : 503 });
}
