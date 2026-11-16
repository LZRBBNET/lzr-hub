/** Browser journal: never stores message text or a plaintext recipient. */
export const UNCERTAIN_REPLY = "O envio está sem confirmação. Não reenvie: use Enviar para consultar a mesma tentativa, sem mandar outra mensagem.";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Result = { accepted: true; recovered: boolean; recorded?: boolean } | { accepted: false; error: string };
export interface AttemptDeps {
  storage: Storage;
  fetch: typeof fetch;
  uuid: () => string;
  lock: <T>(name: string, action: () => Promise<T>) => Promise<T>;
}

/** Persist before POST. An interrupted attempt can only be reconciled, never replayed. */
export async function runReplyAttempt(deps: AttemptDeps, input: {
  journalKey: string; conversationId: string; text: string; reconcileOnly?: boolean;
}): Promise<Result> {
  return deps.lock(input.journalKey, async () => {
    let key: string | null;
    try { key = deps.storage.getItem(input.journalKey); }
    catch { return { accepted: false, error: "Não foi possível proteger esta tentativa no navegador. Nenhum novo envio foi iniciado." }; }
    if (key) {
      if (!/^[\w-]{8,100}$/.test(key)) return { accepted: false, error: UNCERTAIN_REPLY };
      try {
        const query = new URLSearchParams({ conversationId: input.conversationId, idempotencyKey: key });
        const response = await deps.fetch(`/api/conversations/reply?${query}`, { cache: "no-store" });
        const payload = await response.json();
        if (response.ok && payload.state === "sent" && typeof payload.messageId === "string" && payload.messageId) {
          deps.storage.removeItem(input.journalKey);
          return { accepted: true, recovered: true, recorded: false };
        }
      } catch { /* Keep the journal on transport, JSON or storage failure. */ }
      return { accepted: false, error: UNCERTAIN_REPLY };
    }
    if (input.reconcileOnly) return { accepted: false, error: "Não há tentativa pendente registrada neste navegador. Isso não comprova ausência de envio em outro dispositivo." };
    key = deps.uuid();
    try {
      deps.storage.setItem(input.journalKey, key);
      if (deps.storage.getItem(input.journalKey) !== key) throw new Error("journal unavailable");
    } catch { return { accepted: false, error: "Não foi possível proteger esta tentativa no navegador. Nenhum novo envio foi iniciado." }; }
    try {
      const response = await deps.fetch("/api/conversations/reply", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: input.conversationId, text: input.text, idempotencyKey: key }),
      });
      const payload = await response.json();
      if (response.ok && payload.ok === true && typeof payload.messageId === "string" && payload.messageId) {
        deps.storage.removeItem(input.journalKey);
        return { accepted: true, recovered: false, recorded: payload.recorded === true };
      }
      if (!response.ok && payload.retrySafe === true) {
        deps.storage.removeItem(input.journalKey);
        return { accepted: false, error: typeof payload.error === "string" ? payload.error : "Envio recusado antes de ser aceito. Revise a mensagem." };
      }
    } catch { /* An HTTP failure is not evidence of non-delivery. */ }
    return { accepted: false, error: UNCERTAIN_REPLY };
  });
}
