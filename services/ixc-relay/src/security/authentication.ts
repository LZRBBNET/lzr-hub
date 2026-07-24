import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RelayConfig } from "../config.ts";
import { RelayError } from "../ixc/errors.ts";
import { NonceStore } from "./replay-protection.ts";

const correlationPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const noncePattern = /^[A-Za-z0-9-]{16,128}$/;

export function authenticateRequest(
  request: Request,
  body: string,
  config: RelayConfig,
  nonceStore: NonceStore,
  now = () => Date.now(),
) {
  if (!request.headers.get("CF-Access-Client-Id") || !request.headers.get("CF-Access-Client-Secret")) {
    throw new RelayError("RELAY_UNAUTHORIZED", 401, "Não autorizado");
  }
  const timestamp = request.headers.get("X-LZR-Timestamp") ?? "";
  const nonce = request.headers.get("X-LZR-Nonce") ?? "";
  const receivedSignature = request.headers.get("X-LZR-Signature") ?? "";
  const correlationId = request.headers.get("X-Correlation-Id") ?? "";
  if (!correlationPattern.test(correlationId)) throw new RelayError("RELAY_CORRELATION_INVALID", 400, "Identificador de correlação inválido");
  if (!noncePattern.test(nonce)) throw new RelayError("RELAY_NONCE_INVALID", 401, "Não autorizado");
  if (!/^\d{10,13}$/.test(timestamp)) throw new RelayError("RELAY_TIMESTAMP_INVALID", 401, "Não autorizado");
  const timestampMs = Number(timestamp) * 1000;
  if (Math.abs(now() - timestampMs) > config.maxClockSkewSeconds * 1000) {
    throw new RelayError("RELAY_TIMESTAMP_INVALID", 401, "Não autorizado");
  }
  if (!/^[a-f0-9]{64}$/.test(receivedSignature)) throw new RelayError("RELAY_SIGNATURE_INVALID", 401, "Não autorizado");

  const pathname = new URL(request.url).pathname;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [
    "v1",
    timestamp,
    nonce,
    request.method.toUpperCase(),
    pathname,
    bodyHash,
    correlationId,
  ].join("\n");
  const expected = createHmac("sha256", config.hmacSecret).update(canonical).digest();
  const received = Buffer.from(receivedSignature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new RelayError("RELAY_SIGNATURE_INVALID", 401, "Não autorizado");
  }
  if (!nonceStore.consume(nonce)) throw new RelayError("RELAY_REPLAY_DETECTED", 409, "Solicitação repetida");
  return { correlationId };
}
