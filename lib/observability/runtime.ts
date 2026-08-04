import { LangfuseObservabilityProvider } from "./langfuse-provider.ts";
import type { ObservabilityProvider } from "../integrations/contracts.ts";

let runtime: ObservabilityProvider | undefined | null;

/** `undefined` = ainda não resolvido; `null` = resolvido como desligado. */
export function getObservabilityProvider(): ObservabilityProvider | null {
  if (runtime !== undefined) return runtime;
  if (process.env.FEATURE_LANGFUSE !== "true") return (runtime = null);
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return (runtime = null);
  return (runtime = new LangfuseObservabilityProvider({
    publicKey, secretKey,
    baseUrl: process.env.LANGFUSE_BASE_URL,
  }));
}

/** Só para os testes reiniciarem o singleton entre casos. */
export function resetObservabilityRuntime() { runtime = undefined; }
