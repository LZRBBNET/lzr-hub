/**
 * Roda o diagnóstico de conexão de verdade, contra o IXC de produção, no
 * cadastro de TESTE autorizado pela BBNET (21857 — login `copadomundo2026`).
 * **Só lê.** As massivas ficam de fora: estão no banco do LZR HUB, não no IXC.
 *
 *   node --experimental-strip-types scripts/ixc-probe-diagnosis.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { createIxcFetcher, resolveIxcHttpMethod } from "../lib/integrations/ixc/http.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { diagnoseConnection } from "../lib/platform/connection-diagnosis-shared.ts";

const TEST_CUSTOMER = "21857";

function fromEnvFile(name) {
  if (!existsSync(".env.local")) return undefined;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (trimmed.slice(0, separator) === name) return trimmed.slice(separator + 1).trim();
  }
  return undefined;
}

const baseUrl = process.env.IXC_BASE_URL || fromEnvFile("IXC_BASE_URL");
const token = process.env.IXC_API_TOKEN || fromEnvFile("IXC_API_TOKEN");
if (!baseUrl || !token || baseUrl.includes("localhost")) { console.error("Faltam IXC_BASE_URL e IXC_API_TOKEN reais no .env.local."); process.exit(1); }

const provider = new IxcReadonlyProvider({ baseUrl, token, allowedCustomerIds: [TEST_CUSTOMER], fetcher: createIxcFetcher(resolveIxcHttpMethod(process.env.IXC_HTTP_METHOD)) });
const started = Date.now();
const data = await provider.getServiceDiagnosis(TEST_CUSTOMER, "probe-diagnosis");
const diagnosis = diagnoseConnection(data, []);
console.log(`Leitura do IXC: ${Date.now() - started} ms`);
console.log(`Veredito: ${diagnosis.verdict}`);
for (const fact of diagnosis.facts) console.log(`  · ${fact}`);
console.log(`Próximo passo: ${diagnosis.next}`);
console.log(`Desbloqueio de confiança possível: ${diagnosis.trustUnlockEligible ? "sim" : "não"}`);
