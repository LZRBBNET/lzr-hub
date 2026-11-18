import { NextResponse } from "next/server";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { metaSendConfigFromEnv, sendTemplateMessage } from "@/lib/integrations/meta/cloud-client";
import { DbOutboundRepository, runBillingReminders, runNetworkNotices } from "@/lib/platform/outbound-service";
import { DbIncidentsRepository } from "@/lib/platform/incidents-service";
import { logUnauthenticatedAction } from "@/lib/platform/audit-log";
import { authorize } from "@/lib/platform/session-guard";

/**
 * Rodada de cobrança (`job: "billing"`) ou de avisos de rede (`job: "network"`).
 *
 * Quem dispara é o agendamento (`.github/workflows/outbound.yml`) com `x-job-secret` igual ao
 * `OUTBOUND_JOB_SECRET` do Railway. Quem administra (`users.manage`) pode chamar só com
 * `dryRun: true`: conta quantas mensagens sairiam, sem reservar nem enviar — para conferir antes
 * de ligar. Envio de verdade exige a flag do aviso (`FEATURE_BILLING_REMINDERS`,
 * `FEATURE_NETWORK_NOTICES`). A resposta só tem contagens: fica no log de cada execução.
 */

function jobAuthorized(request: Request): boolean {
  const expected = process.env.OUTBOUND_JOB_SECRET?.trim();
  const offered = request.headers.get("x-job-secret")?.trim();
  if (!expected || !offered) return false;
  const a = Buffer.from(expected); const b = Buffer.from(offered);
  return a.length === b.length && timingSafeEqual(a, b);
}

const positive = (value: string | undefined, fallback: number) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { job?: unknown; dryRun?: unknown };
  const job = body.job === "network" ? "network" : body.job === "billing" ? "billing" : undefined;
  if (!job) return NextResponse.json({ error: "Informe job: billing ou network" }, { status: 400 });
  let dryRun = body.dryRun === true;
  if (!jobAuthorized(request)) {
    const guard = await authorize(request, "users.manage");
    if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
    // Pela tela, só a simulação: o envio de verdade é do agendamento, com limite e horário.
    dryRun = true;
  }
  const flag = job === "billing" ? process.env.FEATURE_BILLING_REMINDERS === "true" : process.env.FEATURE_NETWORK_NOTICES === "true";
  if (!dryRun && !flag) return NextResponse.json({ job, skipped: `${job === "billing" ? "FEATURE_BILLING_REMINDERS" : "FEATURE_NETWORK_NOTICES"} desligada` });

  const provider = getIxcRuntime().provider;
  if (!provider) return NextResponse.json({ error: "IXC indisponível" }, { status: 503 });
  const sendConfig = metaSendConfigFromEnv();
  if (!sendConfig && !dryRun) return NextResponse.json({ error: "Envio pela Meta não configurado" }, { status: 503 });

  const correlationId = randomUUID();
  const db = await getDb();
  const options = {
    provider, repository: new DbOutboundRepository(db), dryRun, correlationId,
    send: (input: { to: string; name: string; language: string; bodyParams: string[] }) => sendTemplateMessage(sendConfig!, input),
    // Teto por rodada e por dia: a Meta limita as conversas que a empresa começa e cobra por mensagem.
    maxSends: positive(process.env.OUTBOUND_MAX_PER_RUN, 150),
    dailyCap: positive(process.env.OUTBOUND_DAILY_CAP, 900),
  };
  try {
    const report = job === "billing"
      ? await runBillingReminders(options)
      : await runNetworkNotices({ ...options, incidents: await new DbIncidentsRepository(db).list(50) });
    if (!dryRun) {
      await logUnauthenticatedAction({
        action: `outbound.${job}`, entity: "whatsapp", result: report.stoppedBy ?? "ok", correlationId, actorNotApplicable: true,
        reason: `Rodada de ${job === "billing" ? "cobrança" : "avisos de rede"}: ${report.sent} enviada(s)${report.stoppedBy ? `, parou por ${report.stoppedBy}` : ""}.`,
      }).catch(() => undefined);
    }
    return NextResponse.json(report);
  } catch {
    return NextResponse.json({ error: "A rodada falhou ao ler o IXC; a próxima retoma de onde parou." }, { status: 503 });
  }
}
