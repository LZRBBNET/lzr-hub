import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { authorize, authEnforced } from "@/lib/platform/session-guard";
import { getQueueSnapshot } from "@/lib/platform/queue-service";
import { llmConfigFromEnv } from "@/lib/agent/llm-classifier";

/**
 * Estado real de cada integração, resolvido no servidor.
 *
 * A tela de Integrações trazia esta lista escrita à mão no JSX e ficou mentindo:
 * anunciava "IXC: disabled — nenhuma consulta real" enquanto o IXC lia a base
 * inteira, e listava um "Banco D1" que o projeto abandonou. Um painel de saúde
 * que erra o estado é pior que não ter painel: as pessoas param de checar.
 *
 * Nada de segredo sai daqui — só nome, situação e uma descrição.
 */
export async function GET(request: Request) {
  const guard = await authorize(request, "integrations.test");
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let ixc: { mode: string; scope: string; state: string; detail: string };
  try {
    const runtime = getIxcRuntime();
    if (!runtime.provider) ixc = { mode: runtime.config.ixcMode, scope: "—", state: "disabled", detail: "IXC desligado por configuração" };
    else {
      const health = runtime.provider.health();
      ixc = {
        mode: runtime.config.ixcMode,
        scope: runtime.config.ixcFullBase ? "base inteira" : `allowlist (${runtime.config.ixcAllowlist.length})`,
        state: health.state,
        detail: "Leitura pelo provider somente-leitura; escrita só pelas operações do catálogo (ver \"Escrita no ERP\").",
      };
    }
  } catch {
    ixc = { mode: "inválido", scope: "—", state: "error", detail: "Configuração do IXC recusada no carregamento" };
  }

  const metaEnabled = process.env.FEATURE_META_WHATSAPP === "true";
  const metaAutoReply = process.env.FEATURE_N8N_AUTOREPLY === "true";
  const metaReceives = !!process.env.META_APP_SECRET?.trim() && !!process.env.META_VERIFY_TOKEN?.trim();
  const metaSends = !!process.env.META_ACCESS_TOKEN?.trim() && !!process.env.META_PHONE_NUMBER_ID?.trim();
  const attendantReply = process.env.FEATURE_ATTENDANT_REPLY === "true";
  const ixcWrite = process.env.FEATURE_IXC_WRITE === "true";

  let database: { state: string; detail: string };
  try { await getDb(); database = { state: "ok", detail: "Postgres no Railway; migrações aplicadas no deploy" }; }
  catch { database = { state: "error", detail: "Sem DATABASE_URL utilizável" }; }

  const queues = await getQueueSnapshot().catch(() => null);
  // `llmConfigFromEnv` já aplica a regra completa: flag ligada **e** chave presente.
  const llm = llmConfigFromEnv();

  return NextResponse.json({
    environment: process.env.LZR_ENV ?? "local",
    auth: { enforced: authEnforced(), detail: authEnforced() ? "Login obrigatório e RBAC ativos" : "Rotas abertas: FEATURE_AUTH desligada" },
    services: [
      { name: "IXC (ERP)", state: ixc.state, mode: `${ixc.mode} • ${ixc.scope}`, detail: ixc.detail },
      { name: "Banco de dados", state: database.state, mode: "Postgres", detail: database.detail },
      {
        // O canal oficial é a Cloud API da Meta; o nome "n8n" da flag é histórico.
        // A tela anunciava "WhatsApp (n8n)" e só olhava o segredo do n8n — com a
        // Meta ligada e o n8n fora do caminho, o painel dizia "incompleto".
        name: "WhatsApp (Meta)",
        state: !metaEnabled ? "disabled" : !metaReceives ? "degraded" : metaAutoReply ? "ok" : "observação",
        mode: !metaEnabled ? "desligado" : metaAutoReply ? "a IA responde ao cliente" : attendantReply && metaSends ? "recebe; o atendente responde pela tela" : "recebe, não responde",
        detail: !metaEnabled ? "Canal desligado; nenhuma mensagem entra"
          : !metaReceives ? "Ligado sem META_APP_SECRET ou META_VERIFY_TOKEN — o webhook recusa as mensagens"
          : metaAutoReply ? "A IA responde o cliente sem humano no meio"
          : attendantReply && !metaSends ? "Resposta pela tela ligada, mas falta META_ACCESS_TOKEN ou META_PHONE_NUMBER_ID"
          : "Recebe e classifica; a resposta da IA fica como sugestão para o atendente",
      },
      {
        // A flag ligada sem chave não liga nada — e essa diferença precisa aparecer,
        // senão alguém marca "classificador ativo" e ele está caindo na regex.
        name: "Classificação de intenção (Groq)",
        state: llm ? "ok" : process.env.FEATURE_LLM_INTENT === "true" ? "degraded" : "disabled",
        mode: llm ? llm.model : "expressões regulares",
        detail: llm
          ? "Modelo escolhe uma intenção de lista fechada; a resposta ao cliente continua sendo texto fixo"
          : process.env.FEATURE_LLM_INTENT === "true"
            ? "FEATURE_LLM_INTENT ligada mas sem GROQ_API_KEY — está caindo na regex"
            : "Intenção detectada por regra; sem modelo de linguagem",
      },
      { name: "Filas (BullMQ/Redis)", state: queues?.enabled ? "ok" : "disabled", mode: queues?.runtime ?? "—", detail: queues?.enabled ? "Jobs reais em processamento" : (queues?.detail ?? "FEATURE_QUEUES desligada") },
      { name: "Observabilidade (Langfuse)", state: process.env.FEATURE_LANGFUSE === "true" ? "ok" : "disabled", mode: "OTLP", detail: process.env.FEATURE_LANGFUSE === "true" ? "Rastro do pipeline sendo enviado" : "Sem rastro externo; custo por atendimento não é medido" },
      {
        // Antes era uma linha fixa dizendo "ausência de código" — falsa desde que
        // segunda via, OS, renegociação e cadastro passaram a gravar no IXC.
        name: "Escrita no ERP",
        state: ixcWrite ? "ok" : "disabled",
        mode: ixcWrite ? "ligada · segunda via, OS, renegociação e cadastro" : "desligada",
        detail: ixcWrite
          ? "Só para quem tem a permissão ixc.write. Cada operação passa por idempotência e política, e fica no ledger — inclusive o que foi bloqueado"
          : "FEATURE_IXC_WRITE desligada: nenhuma operação grava no IXC",
      },
    ],
  });
}
