/**
 * O que a IA diz quando o cliente manda algo que não é texto: áudio (sem transcrição), foto, vídeo, documento ou
 * figurinha. Antes só o áudio tinha resposta; foto e figurinha ficavam sem nada — em 24/11/2026 uma conversa nova
 * começou com uma figurinha e a IA ficou calada. Cliente de provedor manda foto do roteador e comprovante o tempo
 * todo, e muita gente abre a conversa com uma figurinha de "bom dia".
 *
 * Regras:
 * - rajada (três fotos seguidas, dois áudios) ganha UMA resposta, não uma por arquivo;
 * - figurinha no meio da conversa é reação ("joinha"), não pedido: só cumprimenta quem chega agora.
 */

export const AUDIO_REPLY = "Recebi seu áudio, mas aqui eu só consigo ler mensagem escrita. Pode me escrever rapidinho o que está acontecendo?";
export const FILE_REPLY = "Recebi seu arquivo, mas por aqui ainda não consigo abrir foto, vídeo nem documento. Me conta em poucas palavras o que está acontecendo? Se for comprovante de pagamento, me diz o dia em que pagou.";
export const STICKER_GREETING = "Olá! Aqui é o suporte da BBNET. Me conta o que está acontecendo?";

const BURST_MS = 30 * 60 * 1000;
const CONVERSATION_MS = 6 * 3600 * 1000;

export interface VisibleMessage { role: string; content: string; createdAt?: string | null }

/** A resposta para uma fala sem texto, ou `undefined` para não responder. `history` em ordem, sem sugestões. */
export function mediaReply(kind: string, history: VisibleMessage[], now: number): string | undefined {
  const reply = kind === "audio" ? AUDIO_REPLY
    : kind === "image" || kind === "video" || kind === "document" ? FILE_REPLY
      : kind === "sticker" ? STICKER_GREETING : undefined;
  if (!reply) return undefined;
  const lastAgent = [...history].reverse().find((row) => row.role === "agent");
  const lastAgentAt = lastAgent?.createdAt ? Date.parse(lastAgent.createdAt) : NaN;
  // Sem data legível conta como recente: na dúvida, não repete.
  const age = Number.isFinite(lastAgentAt) ? now - lastAgentAt : 0;
  if (lastAgent && lastAgent.content === reply && age < BURST_MS) return undefined;
  if (kind === "sticker" && lastAgent && age < CONVERSATION_MS) return undefined;
  return reply;
}
