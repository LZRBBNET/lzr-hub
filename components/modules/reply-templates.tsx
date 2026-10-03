"use client";
import { useEffect, useState } from "react";
import { MAX_REPLY_LENGTH } from "@/lib/platform/reply-templates-shared";

type Item = {
  intent: string; label: string; defaultContent: string; content: string; edited: boolean;
  version: number | null; updatedBy: string | null; updatedAt: string | null;
};

/**
 * Respostas aprovadas da IA, uma por assunto. É o texto que o canal sugere ao
 * atendente (e que será enviado quando a resposta automática for ligada), no
 * lugar do texto de homologação do pipeline.
 */
export function ReplyTemplates() {
  const [items, setItems] = useState<Item[]>([]);
  const [available, setAvailable] = useState(true);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    fetch("/api/agent/replies").then((r) => r.ok ? r.json() : Promise.reject(new Error("falhou")))
      .then((payload: { available: boolean; items: Item[] }) => { if (active) { setAvailable(payload.available); setItems(payload.items ?? []); setDrafts({}); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [nonce]);

  async function call(body: Record<string, string>, success: string) {
    setBusy(body.intent); setMessage(null);
    try {
      const response = await fetch("/api/agent/replies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      setMessage(response.ok ? success : payload.error ?? "Não foi possível salvar.");
      if (response.ok) setNonce((n) => n + 1);
    } catch { setMessage("Não foi possível salvar."); }
    finally { setBusy(null); }
  }

  return <section className="data-card" style={{ marginTop: 14 }}>
    <div className="card-header"><strong>Respostas aprovadas da IA</strong><span className="badge blue">Uma por assunto</span></div>
    <p style={{ padding: "0 14px 10px", fontSize: 12, lineHeight: 1.6, color: "var(--muted)" }}>
      É o texto que o canal sugere ao atendente para cada assunto. Escreva o que <b>vai acontecer</b> (&quot;vou encaminhar&quot;, &quot;um atendente retorna&quot;), nunca algo já feito.
      O texto vale para todos os clientes daquele assunto: não use e-mail, CPF nem telefone, e não mencione homologação ou dado fictício.
    </p>
    {state === "loading" && <p style={{ padding: 14 }}>Carregando respostas…</p>}
    {state === "error" && <p className="form-error" style={{ padding: 14 }}>Não foi possível carregar as respostas.</p>}
    {state === "ready" && !available && <p className="form-error" style={{ padding: 14 }}>Respostas indisponíveis: o banco não respondeu, então não dá saber o que foi editado.</p>}
    {message && <div className="state-card" style={{ margin: "0 14px 10px" }}>{message}</div>}
    {state === "ready" && available && items.map((item) => {
      const value = drafts[item.intent] ?? item.content;
      const changed = value.trim() !== item.content.trim();
      return <div key={item.intent} style={{ padding: 14, borderTop: "1px solid var(--line-soft)", display: "grid", gap: 8 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
          <strong>{item.label}</strong>
          <i className={`badge ${item.edited ? "green" : ""}`}>{item.edited ? `Editada • v${item.version}` : "Padrão"}</i>
        </div>
        <textarea rows={3} value={value} maxLength={MAX_REPLY_LENGTH} onChange={(e) => { setDrafts({ ...drafts, [item.intent]: e.target.value }); setMessage(null); }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="button" disabled={busy !== null || !changed || !value.trim()} onClick={() => void call({ action: "save", intent: item.intent, content: value }, `Resposta de "${item.label}" salva.`)}>{busy === item.intent ? "Salvando…" : "Salvar"}</button>
          {item.edited && <button className="button secondary" disabled={busy !== null} onClick={() => void call({ action: "reset", intent: item.intent }, `Resposta de "${item.label}" voltou ao padrão.`)}>Voltar ao padrão</button>}
          <small style={{ marginLeft: "auto", color: "var(--text-3)" }}>{value.length}/{MAX_REPLY_LENGTH}</small>
        </div>
        {item.edited && item.updatedBy && item.updatedAt && <small style={{ color: "var(--text-3)" }}>Editada por {item.updatedBy} em {new Date(item.updatedAt).toLocaleString("pt-BR")}</small>}
      </div>;
    })}
  </section>;
}
