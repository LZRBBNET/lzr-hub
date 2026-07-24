import type { ToolReceipt } from "./types.ts";
import { isSuccessfulReceipt } from "./tool-engine.ts";

const successClaims = [
  /\b(?:gerei|enviei|anexei|abri|desbloqueei|agendei|reiniciei|normalizei|resolvi|ativei|liberei|alterei)\b/gi,
  /\b(?:pix|boleto|fatura|segunda via|documento|link)\s+(?:foi|está|esta|ficou)\s+(?:gerad[oa]|enviad[oa]|anexad[oa]|disponível|disponivel)\b/gi,
  /\b(?:chamado|protocolo|ordem(?: de serviço)?|os)\s+(?:foi|está|esta|ficou)\s+(?:abert[oa]|criad[oa]|registrad[oa])\b/gi,
  /\b(?:contrato|cliente|acesso)\s+(?:foi|está|esta|ficou)\s+(?:desbloquead[oa]|liberad[oa]|reativad[oa])\b/gi,
  /\b(?:visita|atendimento|horário|horario)\s+(?:foi|está|esta|ficou)\s+agendad[oa]\b/gi,
  /\b(?:roteador|equipamento|onu|cpe)\s+(?:foi|está|esta|ficou)\s+reiniciad[oa]\b/gi,
  /\bpagamento\s+(?:foi|está|esta|ficou|consta como)\s+(?:reconhecid[oa]|confirmad[oa]|compensad[oa]|pag[oa])\b/gi,
  /\b(?:problema|falha|incidente)\s+(?:foi|está|esta|ficou)\s+(?:resolvid[oa]|normalizad[oa])\b/gi,
  /\b(?:conexão|conexao|internet|serviço|servico)\s+(?:voltou|foi normalizad[oa]|está normalizad[oa]|esta normalizad[oa])\b/gi,
];

const simulationDisclosure = /\b(homologa(?:ção|cao)|simulad[oa]s?|fictíci[oa]s?|fictici[oa]s?|não executei|nao executei|sem executar|nenhuma ação real|nenhuma acao real|nenhuma alteração real|nenhuma alteracao real)\b/i;

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function explicitlyNegated(response: string, claimIndex: number): boolean {
  const prefix = normalized(response.slice(Math.max(0, claimIndex - 48), claimIndex));
  return /(?:^|[\s,;:.!?])(?:nao|nunca|jamais)\s+(?:\w+\s+){0,2}$/.test(prefix)
    || /(?:^|[\s,;:.!?])nenhum[ao]?\s+$/.test(prefix);
}

function hasPositiveSuccessClaim(response: string): boolean {
  return successClaims.some((pattern) => {
    pattern.lastIndex = 0;
    return [...response.matchAll(pattern)].some((match) =>
      !explicitlyNegated(response, match.index ?? 0),
    );
  });
}

export function validEvidence(receipts: ToolReceipt[]) {
  return receipts.flatMap((receipt) =>
    isSuccessfulReceipt(receipt) && receipt.evidence?.valid ? [receipt.evidence] : [],
  );
}

export function hasUnsafeSuccessClaim(response: string, receipts: ToolReceipt[]): boolean {
  if (!hasPositiveSuccessClaim(response)) return false;
  if (receipts.some((receipt) => receipt.status === "failed")) return true;
  const evidence = validEvidence(receipts);
  if (!evidence.length) return true;
  if (evidence.every((item) => item.simulated) && !simulationDisclosure.test(response)) return true;
  return false;
}

export function simulationIsDisclosed(response: string, receipts: ToolReceipt[]): boolean {
  const hasSimulation = receipts.some((receipt) => receipt.simulated);
  return !hasSimulation || simulationDisclosure.test(response);
}
