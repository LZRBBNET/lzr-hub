import { NextResponse } from "next/server";
import { getD1 } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { telemetrySummary } from "@/lib/observability/telemetry";

export async function GET() {
  const started=Date.now();let database:{status:string;latencyMs?:number;detail:string};try{const db=await getD1();await db.prepare("SELECT 1 AS ok").first();database={status:"healthy",latencyMs:Date.now()-started,detail:"D1 conectado; migrations gerenciadas"};}catch{database={status:"degraded",detail:"Binding D1 indisponível neste ambiente"};}
  let ixc:{status:string;mode:string;detail:string;allowlist?:string[]};let pilot={status:"disabled",mode:"internal",detail:"Participantes ainda não configurados"};try{const runtime=getIxcRuntime();const state=runtime.provider?.health();ixc=state?{status:state.state,mode:state.mode,detail:state.detail,allowlist:state.allowlist}:{status:"disabled",mode:runtime.config.ixcMode,detail:"IXC sem credenciais ativas"};pilot=runtime.config.pilotMode==="internal"?{status:"healthy",mode:"internal",detail:`${runtime.config.pilotAllowedUserIds.length} participantes autorizados`}:pilot;}catch{ixc={status:"degraded",mode:"disabled",detail:"Configuração IXC inválida; integração bloqueada"};}
  return NextResponse.json({
    status: database.status==="healthy"?"healthy":"degraded",
    environment: process.env.LZR_ENV??"local",
    mode: "homologation-readonly",
    realActionsEnabled: false,
    services: [
      { service:"Banco D1",mode:"staging",...database },
      { service:"IXC",...ixc },
      { service:"Filas e DLQ",status:database.status,mode:"D1",detail:"Jobs persistidos; agendamento desligado por padrão" },
      { service:"Pipeline LZR",status:"healthy",mode:"local",detail:"Proteção conversacional ativa" },
      { service:"IA",status:"healthy",mode:"local",detail:"Métricas sem PII" },
      { service:"Conhecimento",status:"healthy",mode:"híbrido sem pgvector",detail:"Evidência obrigatória" },
      { service:"Meta WhatsApp",status:"disabled",mode:"mock",detail:"Nenhum envio real" },
      { service:"Chatwoot",status:"disabled",mode:"mock",detail:"Sem conexão externa" },
      { service:"Piloto interno",...pilot },
    ],
    telemetry:telemetrySummary(),
  });
}
