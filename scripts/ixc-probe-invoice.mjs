/**
 * Prova a segunda via contra o IXC de produção, no cadastro de TESTE autorizado
 * pela BBNET (21857 — login `copadomundo2026`). **Só lê.**
 *
 * Faz o caminho inteiro da conferência: lê o documento do cadastro, confere um
 * CPF certo e um errado, e lista as faturas em aberto. O CPF não aparece na
 * saída — só o resultado.
 *
 *   node --experimental-strip-types scripts/ixc-probe-invoice.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { createIxcFetcher, resolveIxcHttpMethod } from "../lib/integrations/ixc/http.ts";
import { IxcReadonlyProvider } from "../lib/integrations/ixc/readonly-provider.ts";
import { ixcInvoiceLookup, verifyHolder } from "../lib/platform/triage-service.ts";

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
const lookup = ixcInvoiceLookup(provider, "probe-invoice");
const ticket = { ixcCustomerId: TEST_CUSTOMER };

const document = (await lookup.documentOf(TEST_CUSTOMER)) ?? "";
const digits = document.replace(/\D/g, "");
console.log(`Documento no cadastro: ${digits.length} dígitos${document.includes(".") ? " (gravado com máscara)" : ""}`);

const started = Date.now();
const certo = await verifyHolder(ticket, digits, { lookup, sendData: false }, 1);
console.log(`\nCPF do titular → ${certo.step} em ${Date.now() - started} ms`);
console.log(`Faturas em aberto: ${certo.invoices?.length ?? "—"}`);
for (const invoice of certo.invoices ?? []) console.log(`  fatura ${invoice.id} · vence ${invoice.dueAt ?? "sem data"} · ${invoice.value ?? "sem valor"} · linha digitável: ${invoice.paymentCode ? "sim" : "não"}${invoice.overdue ? " · vencida" : ""}`);
console.log(`Rascunho:\n${certo.draft ?? "—"}`);

const errado = await verifyHolder(ticket, "11144477735", { lookup, sendData: false }, 1);
console.log(`\nCPF de outra pessoa → ${errado.step} (faturas lidas: ${errado.invoices ? "sim" : "não"})`);
