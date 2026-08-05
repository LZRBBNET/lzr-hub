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
        detail: `Somente leitura. Escrita bloqueada no guard, não por configuração.`,
      };
    }
  } catch {
    ixc = { mode: "inválido", scope: "—", state: "error", detail: "Configuração do IXC recusada no carregamento" };
  }

  const channelEnabled = process.env.FEATURE_N8N_CHANNEL === "true";
  const autoReply = channelEnabled && process.env.FEATURE_N8N_AUTOREPLY === "true";

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
        name: "WhatsApp (n8n)",
        state: channelEnabled ? (process.env.N8N_CHANNEL_SECRET ? (autoReply ? "ok" : "observação") : "degraded") : "disabled",
        mode: autoReply ? "responde ao cliente" : channelEnabled ? "recebe, não responde" : "desligado",
        detail: !channelEnabled ? "Canal desligado; nenhuma mensagem entra"
          : !process.env.N8N_CHANNEL_SECRET ? "Ligado sem N8N_CHANNEL_SECRET — o fluxo não consegue autenticar"
          : autoReply ? "A IA responde o cliente sem humano no meio"
          : "Recebe e classifica; a resposta fica como sugestão não enviada",
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
      { name: "Escrita no ERP", state: "disabled", mode: "bloqueada", detail: "Nenhuma operação de escrita existe no guard do IXC — não é flag, é ausência de código" },
    ],
  });
}
