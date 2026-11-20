import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_NAME, MemoryChannelRepository, processChannelMessage } from "../lib/platform/n8n-channel-service.ts";
import { safeTechnicalModelQuestion } from "../lib/platform/meta-technical-emergency.ts";

const inbound = {
  externalConversationId: "synthetic-conversation", text: "Estou sem internet", idempotencyKey: "wamid.synthetic-in",
  correlationId: "synthetic-correlation",
};
const question = "Você consegue verificar se o problema acontece em outro aparelho?";
function fixture(patch = {}) {
  const repo = new MemoryChannelRepository();
  const used = new Set();
  const calls = [];
  const options = {
    autoReply: true,
    triage: { intercept: () => assert.fail("legacy account flow entered"),
      afterClassify: () => assert.fail("legacy diagnosis entered"),
      context: () => assert.fail("legacy facts entered"), footer: () => assert.fail("legacy footer entered"),
      openServiceOrder: () => assert.fail("legacy OS entered"), trustUnlock: () => assert.fail("legacy unlock entered"),
    },
    technicalEmergency: {
      channel: CHANNEL_NAME, eligible: true, priorIntent: null, privateFlowPending: false, humanHandoff: false,
      reserveInbound: async (turn) => {
        if (used.has(turn.idempotencyKey)) return false;
        used.add(turn.idempotencyKey);
        await repo.saveMessages(CHANNEL_NAME, turn.externalConversationId, [
          { role: "customer", content: turn.text, externalMessageId: turn.idempotencyKey, correlationId: turn.correlationId },
        ]);
        return true;
      },
      answer: async input => { calls.push(["n8n", input]); return { kind: "answer", text: question, sources: [], state: "ongoing" }; },
      sender: async input => { calls.push(["meta", input]); return { sent: true, messageId: "wamid.synthetic-out" }; },
      ...patch,
    },
  };
  return { repo, calls, run: input => processChannelMessage(repo, input, undefined, options) };
}
test("technical question comes from n8n without any IXC facts, contact, history or legacy actions", async () => {
  const { repo, calls, run } = fixture();
  await repo.saveMessages(CHANNEL_NAME, inbound.externalConversationId, [
    { role: "agent", content: "Synthetic old private diagnosis", sentBy: "ia" },
  ]);
  const result = await run(inbound);
  assert.equal(result.response, question);
  assert.equal(calls[0][0], "n8n");
  assert.deepEqual(calls[0][1].history, []);
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["history", "intent", "question", "task"]);
  assert.equal(calls[1][0], "meta");
  assert.equal(calls[1][1].text, question);
  assert.equal(result.externalMessageId, "wamid.synthetic-out");
  assert.deepEqual(repo.audits.map(e => e.result), ["n8n_invoked", "meta_accepted"]);
  await run({ ...inbound, text: "Sim", idempotencyKey: "wamid.synthetic-followup" });
  assert.equal(calls.length, 2);
});
test("only the bounded diagnostic question language is accepted, not an arbitrary output blacklist", () => {
  for (const reply of [question, "Alguma luz do roteador está vermelha?", "O problema ocorre em todos os aparelhos ou só em um?"]) {
    assert.equal(safeTechnicalModelQuestion(reply), true, reply);
  }
  for (const text of ["Existe uma ordem em curso?", "Conferi sua conta. Alguma luz do roteador está vermelha?", "Sua potência óptica está fraca?",
    "Veja o status do seu contrato", "Pode conferir os cabos e a fibra?", "O problema acontece em outro aparelho? Vou abrir uma ordem."]) {
    assert.equal(safeTechnicalModelQuestion(text), false, text);
  }
});
test("bad model output/action, data-bearing turns, human ownership or absence of provider fail closed", async () => {
  for (const [patch, text] of [
    [{ answer: async () => ({ kind: "answer", text: "Existe uma visita técnica em andamento?", state: "ongoing" }) }, inbound.text],
    [{ answer: async () => ({ kind: "answer", text: question, action: "trust_unlock" }) }, inbound.text],
    [{ answer: async () => ({ kind: "answer", text: question, state: "request_complete" }) }, inbound.text],
    [{ answer: undefined }, inbound.text],
    [{ eligible: false }, inbound.text],
    [{ humanHandoff: true }, inbound.text],
    [{ privateFlowPending: true }, inbound.text],
    [{ priorIntent: "technical_no_connection" }, "Agora gere uma cobrança"],
    [{ priorIntent: "technical_no_connection" }, "Não sei, meu CPF é synthetic"],
  ]) {
    const { calls, run } = fixture(patch);
    const result = await run({ ...inbound, text });
    assert.equal(result.response, null);
    assert.equal(result.suggestion, undefined);
    assert.equal(result.autoReply, false);
    assert.ok(!calls.some(([kind]) => kind === "meta"));
  }
});
test("concurrent duplicate invokes n8n and Meta once and stores the inbound once", async () => {
  const { repo, calls, run } = fixture();
  await Promise.all([run(inbound), run(inbound)]);
  await run(inbound);
  assert.equal(calls.length, 2);
  const history = await repo.getHistory(CHANNEL_NAME, inbound.externalConversationId);
  assert.equal(history.filter(row => row.role === "customer").length, 1);
  assert.equal(history.filter(row => row.role === "agent").length, 1);
});

const oldAssistantClaim = "Consta um chamado em andamento e o sinal óptico está fraco.";
async function recordLegacyTurn(repo, age) {
  await repo.saveMessages(CHANNEL_NAME, inbound.externalConversationId, [
    { role: "agent", content: oldAssistantClaim, sentBy: "ia-agente", correlationId: "synthetic-old-turn" },
  ]);
  await repo.audit({ correlationId: "synthetic-old-turn", entity: "conversation:synthetic-conversation", result: "replied",
    reason: "Registro histórico sintético da resposta anterior." });
  if (age !== undefined) {
    const get = repo.getHistory.bind(repo);
    repo.getHistory = async (...args) => (await get(...args)).map(row => row.correlationId === "synthetic-old-turn"
      ? { ...row, createdAt: new Date(Date.now() - age).toISOString() } : row);
  }
}

test("explicit and anchored ambiguous order follow-up are held without model, static text, duplicate or lost audit", async () => {
  for (const [text, category] of [
    ["Qual é o número da O.S. que vocês mencionaram?", "guard_unverified_os_followup"],
    ["Qual o número da OS?", "guard_unverified_os_followup"],
    ["Qual chamado foi esse?", "guard_unverified_os_followup"],
    ["Qual é o número dela?", "guard_referred_technical_claim"],
    ["Era aquela que você falou?", "guard_referred_technical_claim"],
  ]) {
    const { repo, calls, run } = fixture();
    await recordLegacyTurn(repo);
    const input = { ...inbound, text };
    const replies = await Promise.all([run(input), run(input)]);
    for (const reply of [...replies, await run(input)]) {
      assert.equal(reply.response, null);
      assert.equal(reply.suggestion, undefined);
      assert.equal(reply.status, "waiting_manual_review");
    }
    assert.deepEqual(calls, []);
    const rows = await repo.getHistory(CHANNEL_NAME, inbound.externalConversationId);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.content), [oldAssistantClaim, text]);
    assert.equal(repo.audits[0].correlationId, "synthetic-old-turn");
    const matched = repo.audits.filter(e => e.result === category);
    assert.equal(matched.length, 1);
    assert.doesNotMatch(matched[0].reason, /sinal|chamado|andamento/);
  }
});

test("current continuing symptom reaches the model as a reported symptom only, with no stale factual or conversational context", async () => {
  for (const text of ["Ainda estou sem internet", "A conexão continua falhando", "Continuo sem internet"]) {
    const { repo, calls, run } = fixture();
    await recordLegacyTurn(repo, 8 * 60 * 60 * 1000);
    const result = await run({ ...inbound, text });
    assert.equal(result.response, question);
    assert.equal(calls[0][1].question, text);
    assert.deepEqual(calls[0][1].history, []);
    assert.equal("facts" in calls[0][1], false);
    assert.doesNotMatch(JSON.stringify(calls), /consta|chamado|sinal óptico/i);
    assert.equal((await repo.getHistory(CHANNEL_NAME, inbound.externalConversationId))[0].content, oldAssistantClaim);
    assert.equal(repo.audits[0].correlationId, "synthetic-old-turn");
  }
});

test("other intent does not inherit an old AI diagnosis, and plural article OS is not a service-order request", async () => {
  const repo = new MemoryChannelRepository();
  await recordLegacyTurn(repo);
  let offered = false;
  const answer = "Posso ajudar com informações gerais sobre os planos?";
  const send = async ({ text }) => {
    assert.equal(text, answer);
    return { sent: true, messageId: "wamid.synthetic-general" };
  };
  const result = await processChannelMessage(repo, { ...inbound, text: "QUAIS OS PLANOS DE INTERNET?" }, undefined, {
    autoReply: true, send,
    technicalEmergency: { channel: CHANNEL_NAME, eligible: false, humanHandoff: false, privateFlowPending: false,
      reserveInbound: async () => assert.fail("unrelated intent intercepted") },
    doubtBot: { agent: true, send, answer: async ({ history }) => {
      offered = true;
      assert.deepEqual(history, []);
      return { kind: "answer", text: answer, sources: [] };
    } },
  });
  assert.equal(offered, true);
  assert.equal(result.response, answer);
  assert.equal((await repo.getHistory(CHANNEL_NAME, inbound.externalConversationId))[0].content, oldAssistantClaim);
});

test("operator pause keeps the technical inbound for review and does not invoke the model or send", async () => {
  const { repo, calls, run } = fixture({ reviewReason: "guard_operator_paused" });
  const result = await run(inbound);
  assert.equal(result.response, null);
  assert.equal(result.status, "waiting_manual_review");
  assert.equal(calls.length, 0);
  assert.equal((await repo.getHistory(CHANNEL_NAME, inbound.externalConversationId)).filter(row => row.role === "customer").length, 1);
  assert.deepEqual(repo.audits.map(entry => entry.result), ["guard_operator_paused"]);
});

test("current Portuguese greeting precedes hidden technical intent and sends only the n8n question for the right daypart", async () => {
  for (const [text, generated] of [
    ["ola bom dia", "Bom dia! Em que posso ajudar?"],
    ["boa tarde", "Boa tarde! Como posso ajudar?"],
    ["Oi, boa noite!", "Boa noite! Posso te ajudar?"],
    ["Oi, tudo bem?", "Oi! Como posso te ajudar?"],
  ]) {
    const sent = [];
    const requests = [];
    const { repo, run } = fixture({ priorIntent: "technical_no_connection", answer: async (prompt) => {
      requests.push(prompt);
      return { kind: "answer", text: generated, sources: [], state: "ongoing" };
    }, sender: async (payload) => {
      sent.push(payload);
      return { sent: true, messageId: "wamid.synthetic-greeting" };
    } });
    await recordLegacyTurn(repo);
    const incoming = { ...inbound, text };
    const results = await Promise.all([run(incoming), run(incoming)]);
    assert.ok(results.some(r => r.response === generated));
    assert.equal((await run(incoming)).response, generated);
    assert.equal(requests.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, generated);
    assert.equal(requests[0].intent, "general_information");
    assert.equal(requests[0].question, text);
    assert.deepEqual(requests[0].history, []);
    assert.equal("facts" in requests[0], false);
    assert.doesNotMatch(JSON.stringify(requests), /consta|chamado|sinal óptico|synthetic-conversation/i);
    assert.equal((await repo.getHistory(CHANNEL_NAME, inbound.externalConversationId))[0].content, oldAssistantClaim);
  }
});

test("greeting refuses wrong daypart, side effects and model failure; pause and private/human gates still hold", async () => {
  for (const override of [
    { answer: async () => ({ kind: "answer", text: "Bom dia! Como posso ajudar?" }) },
    { answer: async () => ({ kind: "answer", text: "Olá! Como posso ajudar?" }) },
    { answer: async () => ({ kind: "answer", text: "Boa tarde! Sua ordem está aberta. Como posso ajudar?" }) },
    { answer: async () => ({ kind: "answer", text: "Boa tarde! Como posso ajudar?", action: "trust_unlock" }) },
    { answer: async () => ({ kind: "answer", text: "Boa tarde! Como posso ajudar?", state: "request_complete" }) },
    { answer: async () => ({ kind: "none" }) },
    { answer: undefined }, { eligible: false }, { humanHandoff: true }, { privateFlowPending: true },
    { reviewReason: "guard_operator_paused" },
  ]) {
    const { run, calls } = fixture({ priorIntent: "technical_no_connection", ...override });
    const result = await run({ ...inbound, text: "boa tarde" });
    assert.equal(result.response, null);
    assert.equal(result.suggestion, undefined);
    assert.ok(!calls.some(([kind]) => kind === "meta"), "no synthetic fallback");
    if ("eligible" in override || "humanHandoff" in override || "privateFlowPending" in override || "reviewReason" in override)
      assert.deepEqual(calls, []);
  }
});
