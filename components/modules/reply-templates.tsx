"use client";
import { useEffect, useState } from "react";
import { MAX_REPLY_LENGTH } from "@/lib/platform/reply-templates-shared";
import { Icon } from "@/components/ui/icons";
import { Badge, Card, Empty, Loading, Notice, useToast } from "@/components/ui/kit";

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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState("");
  const toast = useToast();

  useEffect(() => {
    let active = true;
    fetch("/api/agent/replies").then((r) => r.ok ? r.json() : Promise.reject(new Error("falhou")))
      .then((payload: { available: boolean; items: Item[] }) => { if (active) { setAvailable(payload.available); setItems(payload.items ?? []); setDrafts({}); setState("ready"); } })
      .catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [nonce]);

  async function call(body: Record<string, string>, success: string) {
    setBusy(body.intent); setError(null);
    try {
      const response = await fetch("/api/agent/replies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (response.ok) { toast(success); setNonce((n) => n + 1); }
      else setError(payload.error ?? "Não foi possível salvar.");
    } catch { setError("Não foi possível salvar."); }
    finally { setBusy(null); }
  }

  if (state === "loading") return <Loading rows={5} />;
  if (state === "error") return <Notice tone="bad">Não foi possível carregar as respostas.</Notice>;
  if (!available) return <Notice tone="bad">Respostas indisponíveis: o banco não respondeu, então não dá para saber o que foi editado.</Notice>;
  const shown = items.filter((item) => item.label.toLowerCase().includes(filter.toLowerCase()));
  const edited = items.filter((item) => item.edited).length;
  return <>
    <Notice tone="info" title="Escreva o que vai acontecer, nunca algo já feito"
      more="O texto vale para todos os clientes daquele assunto: não use e-mail, CPF nem telefone, e não mencione homologação ou dado fictício — a validação recusa.">(“vou encaminhar”, “um atendente retorna”).</Notice>
    {error && <Notice tone="bad">{error}</Notice>}
    <Card title="Respostas por assunto" badge={<Badge>{edited} editada(s) de {items.length}</Badge>}
      actions={<label className="search-field" style={{ height: 32 }}><Icon name="search" size={14} /><input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar assunto" aria-label="Filtrar assunto" /></label>} flush>
      {shown.length === 0 && <Empty icon="search" title="Nenhum assunto com esse nome" />}
      {shown.map((item) => {
        const value = drafts[item.intent] ?? item.content;
        const changed = value.trim() !== item.content.trim();
        return <div key={item.intent} className="template">
          <div className="template-head">
            <strong>{item.label}</strong>
            {item.edited ? <Badge tone="ok">Editada · v{item.version}</Badge> : <Badge>Padrão</Badge>}
          </div>
          <textarea rows={3} value={value} maxLength={MAX_REPLY_LENGTH} aria-label={`Resposta para ${item.label}`} onChange={(e) => { setDrafts({ ...drafts, [item.intent]: e.target.value }); setError(null); }} />
          <div className="template-foot">
            {changed && <>
              <button className="button small" disabled={busy !== null || !value.trim()} onClick={() => void call({ action: "save", intent: item.intent, content: value }, `Resposta de "${item.label}" salva.`)}>{busy === item.intent ? "Salvando…" : "Salvar"}</button>
              <button className="button ghost small" disabled={busy !== null} onClick={() => setDrafts((current) => { const next = { ...current }; delete next[item.intent]; return next; })}>Descartar</button>
            </>}
            {!changed && item.edited && <button className="button ghost small" disabled={busy !== null} onClick={() => void call({ action: "reset", intent: item.intent }, `Resposta de "${item.label}" voltou ao padrão.`)}>Voltar ao padrão</button>}
            {item.edited && item.updatedBy && item.updatedAt && !changed && <span className="muted small">por {item.updatedBy} em {new Date(item.updatedAt).toLocaleDateString("pt-BR")}</span>}
            <small>{value.length}/{MAX_REPLY_LENGTH}</small>
          </div>
        </div>;
      })}
    </Card>
  </>;
}
