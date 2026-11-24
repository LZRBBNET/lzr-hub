import type { MetaSendConfig } from "./cloud-client.ts";

/**
 * Download de mídia recebida (áudio do cliente) pela Cloud API, em dois passos:
 *   GET /{media-id}  → { url, mime_type, file_size }
 *   GET {url}        → o arquivo (com o mesmo token)
 * Nunca lança e nunca registra o token. O arquivo fica só na memória: quem chama transcreve e descarta.
 */

/** Áudio de WhatsApp (opus) gasta ~8–16 KB por segundo: 4 MB cobre vários minutos, e acima disso não vale a transcrição. */
export const MEDIA_MAX_BYTES = 4 * 1024 * 1024;
export const MEDIA_TIMEOUT_MS = 10000;

/** O endereço do arquivo vem da resposta da Meta, e o token vai junto: só segue para domínio da própria Meta. */
const META_MEDIA_HOST = /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net|whatsapp\.com)$/i;

export type MediaResult =
  | { ok: true; bytes: Uint8Array; mimeType: string }
  | { ok: false; reason: string };

export async function downloadMetaMedia(config: MetaSendConfig, mediaId: string): Promise<MediaResult> {
  if (!/^\d{5,30}$/.test(mediaId)) return { ok: false, reason: "Identificador de mídia inválido." };
  const fetcher = config.fetcher ?? fetch;
  const headers = { Authorization: `Bearer ${config.accessToken}` };
  const signal = () => AbortSignal.timeout(config.timeoutMs ?? MEDIA_TIMEOUT_MS);
  try {
    const meta = await fetcher(`https://graph.facebook.com/${config.graphVersion}/${mediaId}`, { headers, signal: signal() });
    const info = await meta.json().catch(() => ({})) as { url?: string; mime_type?: string; file_size?: number | string };
    if (!meta.ok || !info.url) return { ok: false, reason: `A Meta não devolveu o endereço do áudio (HTTP ${meta.status}).` };
    const size = Number(info.file_size);
    if (Number.isFinite(size) && size > MEDIA_MAX_BYTES) return { ok: false, reason: "Áudio grande demais para transcrever." };
    let host: string;
    try { const parsed = new URL(info.url); if (parsed.protocol !== "https:") throw new Error("não-https"); host = parsed.hostname; }
    catch { return { ok: false, reason: "Endereço do áudio inválido." }; }
    if (!META_MEDIA_HOST.test(host)) return { ok: false, reason: "Endereço do áudio fora dos domínios da Meta." };
    const file = await fetcher(info.url, { headers, signal: signal() });
    if (!file.ok) return { ok: false, reason: `A Meta recusou o download do áudio (HTTP ${file.status}).` };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength === 0) return { ok: false, reason: "Áudio vazio." };
    if (bytes.byteLength > MEDIA_MAX_BYTES) return { ok: false, reason: "Áudio grande demais para transcrever." };
    return { ok: true, bytes, mimeType: String(info.mime_type ?? file.headers.get("content-type") ?? "audio/ogg").split(";")[0] };
  } catch {
    return { ok: false, reason: "Não consegui baixar o áudio da Meta agora." };
  }
}
