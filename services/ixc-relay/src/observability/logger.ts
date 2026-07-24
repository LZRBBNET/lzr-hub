import { sanitizeLogValue } from "../security/sanitization.ts";

export type LogSink = (event: Record<string, unknown>) => void;

export class RelayMetrics {
  relay_requests_total = 0;
  relay_success_total = 0;
  relay_errors_total = 0;
  relay_auth_failures_total = 0;
  relay_replay_blocked_total = 0;
  relay_ixc_timeout_total = 0;
  relay_ixc_ip_not_allowed_total = 0;
  relay_latency_ms = 0;
  relay_circuit_breaker_state: "closed" | "open" = "closed";

  snapshot() {
    return { ...this };
  }
}

export function createLogger(environment: string, sink: LogSink = (event) => console.log(JSON.stringify(event))) {
  return (event: Record<string, unknown>) => sink(sanitizeLogValue({
    timestamp: new Date().toISOString(),
    environment,
    relayVersion: "0.1.0",
    ...event,
  }) as Record<string, unknown>);
}
