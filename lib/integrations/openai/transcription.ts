import { OPENAI_BASE_URL } from "../../agent/llm-classifier.ts";

/**
 * Transcrição do áudio do cliente (OpenAI, `/audio/transcriptions`).
 *
 * É a primeira vez que o **áudio** de um cliente sai do LZR para um provedor externo — até aqui só
 * saía texto sanitizado. Por isso nasce desligada (`FEATURE_AUDIO_TRANSCRIPTION`), o arquivo não é
 * gravado em lugar nenhum e só o texto transcrito entra na conversa. Nunca lança e nunca registra a chave.
 */

export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const TRANSCRIPTION_TIMEOUT_MS = 15000;
/** Dica de vocabulário: ajuda o modelo com o nome da empresa e as palavras do assunto, sem ditar o conteúdo. */
const HINT = "Atendimento de provedor de internet por fibra, BBNET: internet, Wi-Fi, roteador, fatura, boleto, PIX, segunda via, desbloqueio, visita técnica.";

export interface TranscriptionConfig { apiKey: string; model: string; baseUrl: string; fetcher?: typeof fetch; timeoutMs?: number }

/** Flag ligada e chave presente; sem uma das duas, o áudio segue como hoje (a IA pede para escrever). */
export function transcriptionConfigFromEnv(env: Record<string, string | undefined> = process.env): TranscriptionConfig | undefined {
  if (env.FEATURE_AUDIO_TRANSCRIPTION !== "true") return undefined;
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return { apiKey, model: env.OPENAI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIPTION_MODEL, baseUrl: env.OPENAI_BASE_URL?.trim() || OPENAI_BASE_URL };
}

export type TranscriptionResult = { ok: true; text: string } | { ok: false; reason: string };

const EXTENSIONS: Record<string, string> = { "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "m4a", "audio/amr": "amr", "audio/webm": "webm", "audio/wav": "wav" };

export async function transcribeAudio(config: TranscriptionConfig, audio: { bytes: Uint8Array; mimeType: string }): Promise<TranscriptionResult> {
  const form = new FormData();
  const ext = EXTENSIONS[audio.mimeType.toLowerCase()] ?? "ogg";
  form.append("file", new Blob([audio.bytes as BlobPart], { type: audio.mimeType }), `audio.${ext}`);
  form.append("model", config.model);
  form.append("language", "pt");
  form.append("prompt", HINT);
  form.append("response_format", "json");
  try {
    const response = await (config.fetcher ?? fetch)(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST", headers: { Authorization: `Bearer ${config.apiKey}` }, body: form, signal: AbortSignal.timeout(config.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({})) as { text?: string; error?: { message?: string } };
    if (!response.ok) return { ok: false, reason: `A OpenAI recusou a transcrição (HTTP ${response.status}).` };
    const text = String(body.text ?? "").trim();
    // O modelo, diante de silêncio ou ruído, às vezes devolve só a dica de vocabulário: isso não é fala do cliente.
    if (!text || text === HINT) return { ok: false, reason: "Não entendi nada no áudio." };
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "Não consegui transcrever o áudio agora." };
  }
}
