import test from "node:test";
import assert from "node:assert/strict";
import { summarizeConversation } from "../lib/platform/copilot-service.ts";
import { HANDOFF_REASONS, reasonLabel } from "../lib/platform/teams-shared.ts";
import { handoffLabel } from "../components/modules/labels.ts";

const message = (role, content, sentBy) => ({ role, content, sentBy, createdAt: "2026-11-05T10:00:00.000Z" });
const state = { status: "open", reopened: false, assigneeId: null, assigneeName: null, assignedAt: null, resolvedAt: null, resolvedBy: null };
const input = {
  externalConversationId: "synthetic-case-1",
  messages: [message("customer", "A internet continua sem conexão após reiniciar. Quero atendente.")],
  outcome: { intent: "human_handoff", finalStatus: "handoff", handoff: true, handoffReason: "customer_requested_human" },
  state,
};

test("transferência mantém motivo, contexto e falta de responsável explícitos", () => {
  const text = summarizeConversation(input);
  assert.match(text, /Motivo.*Cliente pediu atendente/);
  assert.match(text, /continua sem conexão após reiniciar/);
  assert.match(text, /Responsável atual: ainda não atribuído/);
  assert.doesNotMatch(text, /transbordou para humano/);
});

test("transferência identifica apenas o responsável efetivamente registrado", () => {
  const text = summarizeConversation({ ...input, state: { ...state, assigneeId: "synthetic-agent", assigneeName: "Ana Teste" } });
  assert.match(text, /Responsável atual: Ana Teste/);
});

test("autoria humana e desconhecida não vira resposta da IA nem recibo de entrega", () => {
  const text = summarizeConversation({ ...input, messages: [...input.messages,
    message("agent", "Verifiquei seu caso.", "ana@example.test"),
    message("agent", "Recebemos sua mensagem.", "ia"),
    message("agent", "Texto legado sem autoria."),
    message("suggestion", "Texto não enviado.", "ia"),
  ] });
  assert.match(text, /1 da IA, 1 de atendentes, 1 com autoria não registrada/);
  assert.match(text, /Sugestões não enviadas: 1/);
  assert.match(text, /não comprova entrega/);
  assert.doesNotMatch(text, /A IA enviou 3/);
});

test("ausência de evidência e histórico limitado não viram fatos completos", () => {
  const text = summarizeConversation({ ...input, state: undefined, outcome: { ...input.outcome, handoffReason: null }, historyTruncated: true });
  assert.match(text, /Motivo.*não registrado/);
  assert.match(text, /Responsável atual: não consultado/);
  assert.match(text, /Histórico parcial/);
  assert.doesNotMatch(text, /Cliente abriu com/);
});

test("resolvida não mostra responsável antigo como fila ativa", () => {
  const text = summarizeConversation({ ...input, state: { ...state, status: "resolved", assigneeId: "old-agent", assigneeName: "Antigo Teste" } });
  assert.match(text, /Situação atual: resolvida/);
  assert.doesNotMatch(text, /Responsável atual: Antigo Teste/);
});

for (const reason of ["explicit_physical_threat", "message_requires_review", "conversation_requires_review", "conditional_cancellation_risk"]) {
  test(`motivo ${reason} pode ser assumido por equipe e é legível nas telas`, () => {
    assert.ok(HANDOFF_REASONS.includes(reason));
    assert.notEqual(reasonLabel(reason), reason);
    assert.equal(handoffLabel(reason), reasonLabel(reason));
  });
}
