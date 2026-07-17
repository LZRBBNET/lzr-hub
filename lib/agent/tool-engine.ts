import type {
  AgentContext,
  Intent,
  ToolEvidence,
  ToolOutcome,
  ToolReceipt,
} from "./types.ts";

const now = () => new Date().toISOString();

function evidence(
  tool: string,
  kind: ToolEvidence["kind"],
  summary: string,
  simulated: boolean,
): ToolEvidence {
  return {
    id: `ev-${tool.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`,
    kind,
    source: simulated ? "homologation-fixture" : "lzr-internal",
    summary,
    valid: true,
    simulated,
    confirmedAt: now(),
  };
}

function receipt(
  tool: string,
  summary: string,
  options: {
    outcome?: ToolOutcome;
    kind?: ToolEvidence["kind"];
    artifact?: ToolReceipt["artifact"];
    errorCode?: string;
    simulated?: boolean;
    realAction?: boolean;
  } = {},
): ToolReceipt {
  const outcome = options.outcome ?? "simulated";
  const failed = !["success", "simulated"].includes(outcome);
  const simulated = options.simulated ?? outcome === "simulated";
  return {
    tool,
    status: failed ? "failed" : "completed",
    outcome,
    summary,
    artifact: options.artifact
      ? { ...options.artifact, simulated }
      : undefined,
    evidence: failed
      ? undefined
      : evidence(tool, options.kind ?? "lookup", summary, simulated),
    realAction: options.realAction ?? false,
    simulated,
    errorCode: options.errorCode,
  };
}

function failureFromProfile(profile: AgentContext["simulationProfile"]): ToolReceipt | null {
  switch (profile) {
    case "tool_unavailable":
      return receipt("network.diagnostics", "Ferramenta de diagnóstico indisponível", {
        outcome: "unavailable",
        errorCode: "TOOL_UNAVAILABLE",
      });
    case "tool_timeout":
      return receipt("network.diagnostics", "Tempo limite seguro excedido", {
        outcome: "timeout",
        errorCode: "TOOL_TIMEOUT",
      });
    case "tool_empty":
      return receipt("network.diagnostics", "Ferramenta retornou resposta vazia", {
        outcome: "invalid",
        errorCode: "TOOL_EMPTY_RESPONSE",
      });
    case "tool_error":
      return receipt("network.diagnostics", "Ferramenta retornou erro interno sanitizado", {
        outcome: "error",
        errorCode: "TOOL_INTERNAL_ERROR",
      });
    case "tool_contradictory":
      return receipt("network.diagnostics", "Fontes de diagnóstico retornaram dados contraditórios", {
        outcome: "partial",
        errorCode: "TOOL_CONTRADICTORY_DATA",
      });
    default:
      return null;
  }
}

function lookup(summary = "Cadastro e contrato fictícios localizados"): ToolReceipt {
  return receipt("customer.lookup", summary, { kind: "lookup" });
}

function diagnosticReceipts(profile: AgentContext["simulationProfile"]): ToolReceipt[] {
  const failure = failureFromProfile(profile);
  if (failure) return [lookup(), failure];

  if (profile === "regional_reports_unconfirmed") {
    return [
      lookup(),
      receipt("network.regional_reports", "Há relatos sanitizados na região, sem incidente confirmado", { outcome: "partial", errorCode: "REGIONAL_INCIDENT_UNCONFIRMED" }),
      receipt("network.regional_incident", "Nenhuma massiva confirmada", { kind: "diagnostic" }),
    ];
  }
  if (profile === "regional_incident") {
    return [
      lookup(),
      receipt("network.regional_incident", "Incidente regional simulado e ativo", { kind: "diagnostic" }),
    ];
  }
  if (profile === "onu_offline") {
    return [
      lookup(),
      receipt("network.onu_status", "ONU offline no diagnóstico simulado", { kind: "diagnostic" }),
      receipt("network.regional_incident", "Nenhuma massiva confirmada", { kind: "diagnostic" }),
    ];
  }
  if (profile === "optical_critical") {
    return [
      lookup(),
      receipt("network.onu_status", "ONU online no diagnóstico simulado", { kind: "diagnostic" }),
      receipt("network.optical_power", "Potência óptica crítica: -29,7 dBm", { kind: "diagnostic" }),
    ];
  }
  if (profile === "diagnostic_inconclusive") {
    return [
      lookup(),
      receipt("network.diagnostics", "Diagnóstico simulado inconclusivo", {
        outcome: "partial",
        errorCode: "DIAGNOSTIC_INCONCLUSIVE",
      }),
    ];
  }

  return [
    lookup(),
    receipt("network.onu_status", "ONU online no diagnóstico simulado", { kind: "diagnostic" }),
    receipt(
      "network.pppoe_status",
      profile === "pppoe_offline" || profile === "default"
        ? "PPPoE offline no diagnóstico simulado"
        : "PPPoE online no diagnóstico simulado",
      { kind: "diagnostic" },
    ),
    receipt("network.optical_power", "Potência óptica normal: -19,8 dBm", { kind: "diagnostic" }),
    receipt("network.regional_incident", "Nenhuma massiva confirmada", { kind: "diagnostic" }),
  ];
}

export function executeAgentTools(
  intent: Intent,
  message: string,
  context: AgentContext = {},
): ToolReceipt[] {
  const profile = context.simulationProfile ?? "default";
  if (profile === "multiple_contracts" && !["human_handoff", "complaint", "cancellation_risk", "unauthorized_request"].includes(intent)) {
    return [lookup("Dois contratos fictícios localizados")];
  }
  switch (intent) {
    case "financial_pix":
      if (profile === "multiple_invoices") return [lookup(), receipt("billing.open_invoices", "Duas faturas fictícias em aberto", { kind: "document" })];
      if (profile === "tool_unavailable") return [lookup(), receipt("billing.open_invoice", "Sistema financeiro indisponível", { outcome: "unavailable", errorCode: "BILLING_UNAVAILABLE" })];
      return [
        lookup(),
        receipt("billing.open_invoice", "Fatura fictícia de julho localizada: R$ 89,90", { kind: "document" }),
        receipt("billing.generate_pix", "PIX de homologação preparado", {
          kind: "document",
          artifact: {
            type: "pix",
            label: "PIX de homologação — copia e cola",
            value: "000201-LZR-HUB-HOMOLOGACAO-SEM-VALOR-REAL",
          },
        }),
      ];
    case "financial_invoice":
      if (profile === "multiple_invoices") return [lookup(), receipt("billing.open_invoices", "Duas faturas fictícias em aberto", { kind: "document" })];
      if (profile === "tool_unavailable") return [lookup(), receipt("billing.open_invoice", "Sistema financeiro indisponível", { outcome: "unavailable", errorCode: "BILLING_UNAVAILABLE" })];
      return [
        lookup(),
        receipt("billing.open_invoice", "Fatura fictícia de julho localizada: R$ 89,90", { kind: "document" }),
        receipt("billing.issue_copy", "Segunda via de homologação preparada", {
          kind: "document",
          artifact: {
            type: "invoice",
            label: "Fatura fictícia — julho/2026",
            value: "https://demo.lzrhub.local/fatura/SEM-VALOR-REAL",
          },
        }),
      ];
    case "financial_payment":
      return [
        lookup(),
        receipt(
          "billing.payment_status",
          profile === "payment_recognized"
            ? "Pagamento reconhecido no cenário controlado"
            : "Pagamento ainda não reconhecido no cenário controlado",
          { kind: "document" },
        ),
      ];
    case "financial_unlock":
      return [
        lookup(profile === "contract_blocked" ? "Contrato fictício bloqueado" : "Contrato fictício localizado"),
        receipt("billing.unlock", "Desbloqueio exige operador autorizado", {
          outcome: "forbidden",
          errorCode: "SENSITIVE_ACTION_BLOCKED",
        }),
      ];
    case "technical_no_connection":
      return [
        ...diagnosticReceipts(profile),
        ...(/nao funcionou|não funcionou|ja reiniciei|já reiniciei/i.test(message)
          ? [receipt("support.open_ticket", "Chamado fictício preparado para revisão", {
              kind: "protocol",
              artifact: { type: "protocol", label: "Protocolo simulado", value: "LZR-HML-2041" },
            })]
          : []),
      ];
    case "technical_slow":
      if (failureFromProfile(profile)) return [lookup(), failureFromProfile(profile)!];
      return [
        lookup("Plano fictício de 600 Mega localizado"),
        receipt("network.onu_status", "ONU online no diagnóstico simulado", { kind: "diagnostic" }),
        receipt("network.optical_power", "Potência óptica normal: -20,1 dBm", { kind: "diagnostic" }),
        receipt(
          "network.speed_diagnostics",
          profile === "cable_slow"
            ? "Velocidade baixa também no teste cabeado simulado"
            : "Link normal; degradação concentrada no Wi-Fi simulado",
          { kind: "diagnostic" },
        ),
      ];
    case "technical_wifi":
      return [
        lookup("Equipamento Wi-Fi fictício localizado"),
        receipt("network.cpe_status", "Roteador online no diagnóstico simulado", { kind: "diagnostic" }),
        receipt("network.wifi_diagnostics", "Dispositivos concentrados em 2.4 GHz", { kind: "diagnostic" }),
      ];
    case "technical_restart":
      return [
        lookup(),
        receipt("network.restart_cpe", "Reinicialização real está desabilitada", {
          outcome: "forbidden",
          errorCode: "REAL_ACTION_DISABLED",
        }),
      ];
    case "technical_ticket":
      if (profile === "ticket_failure") return [lookup(), receipt("support.prepare_ticket", "Falha ao preparar chamado", { outcome: "error", errorCode: "TICKET_PREPARATION_FAILED" })];
      if (profile === "action_disabled") return [lookup(), receipt("support.prepare_ticket", "Ação real desabilitada; revisão humana necessária", { outcome: "requires_human", errorCode: "DEMO_ACTION_ONLY" })];
      return [
        lookup(),
        receipt("support.prepare_ticket", "Rascunho de chamado preparado para revisão", {
          kind: "protocol",
          artifact: { type: "protocol", label: "Protocolo simulado", value: "LZR-HML-2041" },
        }),
      ];
    case "technical_visit":
      if (profile === "schedule_unavailable") return [lookup(), receipt("support.available_slots", "Horário solicitado indisponível", { outcome: "not_found", errorCode: "SLOT_UNAVAILABLE" })];
      return [
        lookup(),
        receipt("support.available_slots", "Horários fictícios consultados", { kind: "lookup" }),
        receipt("support.prepare_visit", "Visita preparada para confirmação humana", {
          outcome: "requires_human",
          errorCode: "VISIT_REQUIRES_HUMAN",
        }),
      ];
    case "human_handoff":
    case "complaint":
    case "cancellation_risk":
      return [receipt("workflow.prepare_handoff", "Transbordo preparado com contexto sanitizado", {
        kind: "protocol",
        artifact: { type: "protocol", label: "Protocolo simulado", value: "LZR-HML-1901" },
      })];
    case "unauthorized_request":
      return [receipt("security.block_request", "Operação não autorizada bloqueada", {
        outcome: "forbidden",
        errorCode: "UNAUTHORIZED_OPERATION",
        simulated: false,
      })];
    case "out_of_scope":
    case "general_information":
      return [receipt("knowledge.search", "Base interna consultada; faltam dados para concluir", {
        outcome: "success",
        kind: "knowledge",
        simulated: false,
      })];
  }
}

export function isSuccessfulReceipt(receipt: ToolReceipt): boolean {
  return receipt.status === "completed" && ["success", "simulated"].includes(receipt.outcome);
}

export function isFailedReceipt(receipt: ToolReceipt): boolean {
  return !isSuccessfulReceipt(receipt);
}
