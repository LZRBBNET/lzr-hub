import type { ToolReceipt } from "./types.ts";
import { isSuccessfulReceipt } from "./tool-engine.ts";

const successClaims = /\b(enviei|anexei|abri|desbloqueei|agendei|reiniciei|normalizei|resolvi|pagamento (?:foi |está )?reconhecido|conexão voltou)\b/i;
const simulationDisclosure = /\b(homologa(?:ção|cao)|simulad[oa]s?|fictíci[oa]s?|fictici[oa]s?|não executei|nao executei|sem executar|nenhuma ação real|nenhuma acao real|nenhuma alteração real|nenhuma alteracao real|preparad[oa]s?)\b/i;

export function validEvidence(receipts: ToolReceipt[]) {
  return receipts.flatMap((receipt) =>
    isSuccessfulReceipt(receipt) && receipt.evidence?.valid ? [receipt.evidence] : [],
  );
}

export function hasUnsafeSuccessClaim(response: string, receipts: ToolReceipt[]): boolean {
  if (!successClaims.test(response)) return false;
  const evidence = validEvidence(receipts);
  if (!evidence.length) return true;
  if (evidence.every((item) => item.simulated) && !simulationDisclosure.test(response)) return true;
  return receipts.some((receipt) => receipt.status === "failed") && !/não consegui|nao consegui|falhou|indisponível|indisponivel|não confirmei|nao confirmei/i.test(response);
}

export function simulationIsDisclosed(response: string, receipts: ToolReceipt[]): boolean {
  const hasSimulation = receipts.some((receipt) => receipt.simulated);
  return !hasSimulation || simulationDisclosure.test(response);
}
