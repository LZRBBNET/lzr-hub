import assert from "node:assert/strict";
import test from "node:test";
import {
  ownerFinanceAnchor, ownerFinanceInbound, ownerFinancePilotScope, ownerFinancePilotTraffic, ownerFinanceScopeMaySpeak,
  OWNER_FINANCE_REPLY, planOwnerFinancePilot,
} from "../lib/platform/owner-finance-pilot.ts";

const now = Date.parse("2026-11-21T15:00:00Z");
const iso = n => new Date(n).toISOString();
const env = { FEATURE_META_OWNER_FINANCE_PILOT: "true", META_OWNER_FINANCE_PILOT_SENDER: "5500000000123",
  META_PHONE_NUMBER_ID:"999990000000",
  META_OWNER_FINANCE_PILOT_STARTED_AT:iso(now-1000), META_OWNER_FINANCE_PILOT_ENDS_AT:iso(now+1000) };
const base = { kind:"text", phone:env.META_OWNER_FINANCE_PILOT_SENDER, canonicalSender:true, phoneNumberId:env.META_PHONE_NUMBER_ID,
  messageId:"wamid.synthetic-input", sentAt:iso(now), text:"como eu faço para pagar?" };
const scope = (m = base, overrides = {}, t = now) => ownerFinancePilotScope({ ...env, ...overrides }, m, env.META_PHONE_NUMBER_ID, t);

test("new response lane has no effect outside the exact explicit pilot", () => {
  assert.ok(scope()); // official base transport ID is all that is required
  assert.ok(scope(base, { META_OWNER_FINANCE_PILOT_RECIPIENT: env.META_PHONE_NUMBER_ID }));
  assert.equal(scope(base, { META_OWNER_FINANCE_PILOT_RECIPIENT: "999990000099" }), undefined);
  for (const m of [{ canonicalSender:false }, { kind:"interactive" }, { phone:"5500000000124" }, { phoneNumberId:"999990000001" },
    { messageId:"fake" }, { sentAt:iso(now-1001) }, { sentAt:iso(now+1) }])
    assert.equal(scope({ ...base, ...m }), undefined);
  for (const overrides of [{ FEATURE_META_OWNER_FINANCE_PILOT:undefined }, { FEATURE_META_OWNER_FINANCE_PILOT_PAUSED:"true" },
    { META_OWNER_FINANCE_PILOT_ENDS_AT:iso(now+3*60*60*1000) }, { META_OWNER_FINANCE_PILOT_STARTED_AT:undefined },
    { META_PHONE_NUMBER_ID:"999990000099" }])
    assert.equal(scope(base, overrides), undefined);
  assert.equal(scope(base, {}, now+1000), undefined);
  assert.equal(ownerFinancePilotTraffic(env, { ...base, phone:"5500000000124" }), false);
  assert.equal(ownerFinancePilotTraffic(env, { ...base, text:"Boa tarde, estou sem conexão" }), false);
  assert.equal(ownerFinancePilotTraffic({ ...env, FEATURE_META_OWNER_FINANCE_PILOT:undefined }, base), false);
});

test("offer, choice, explicit request, and report return fixed safe directions without secrets or notices", () => {
  const cases = [
    ["como eu faço para pagar?", "choice", false],
    ["Pix", "pix", true], ["por boleto", "boleto", true],
    ["quero boleto", "boleto", false], ["prefiro Pix", "pix", false], ["já paguei", "paid", false],
  ];
  for (const [text, turn, requiresAnchor] of cases) {
    assert.equal(ownerFinancePilotTraffic(env, {...base,text}), true);
    assert.deepEqual(planOwnerFinancePilot(text), { turn, requiresAnchor });
    assert.doesNotMatch(OWNER_FINANCE_REPLY[turn], /https?:|[0-9]{6,}|CPF|CNPJ/i);
  }
  for (const text of ["manda pix com meu CPF: 12345678901", "não quero pix", "quero pagar o boleto do meu vizinho", "já paguei para minha mãe"]) {
    assert.equal(ownerFinancePilotTraffic(env, { ...base, text }), true);
    assert.equal(planOwnerFinancePilot(text), undefined);
  }
});

test("bare selection needs exact same-conversation confirmed or quoted prompt and request", () => {
  const request = { role:"customer", content:ownerFinanceInbound(base, "choice", "matching").text,
    correlationId:"matching", externalMessageId:"wamid.request" };
  const sent = { role:"agent", sentBy:"ia", content:OWNER_FINANCE_REPLY.choice, externalMessageId:"wamid.choice",
    createdAt:iso(now-700), correlationId:"matching" };
  assert.equal(ownerFinanceAnchor([request,sent], base, scope()), undefined);
  assert.equal(ownerFinanceAnchor([request,{ ...sent, deliveryStatus:"delivered" }], base, scope()), "wamid.choice");
  assert.equal(ownerFinanceAnchor([request,sent], { ...base, replyToMessageId:"wamid.choice" }, scope()), "wamid.choice");
  assert.equal(ownerFinanceAnchor([request,{ ...sent, deliveryStatus:"read" }], { ...base, replyToMessageId:"wamid.foreign" }, scope()), undefined);
  assert.equal(ownerFinanceAnchor([{ ...request, correlationId:"foreign" },{ ...sent, deliveryStatus:"read" }], base, scope()), undefined);
  assert.equal(ownerFinanceAnchor([request,{ ...sent, deliveryStatus:"delivered", createdAt:iso(now-1001) }], base, scope()), undefined);
});

test("cannot take over human or ongoing private flow", () => {
  assert.equal(ownerFinanceScopeMaySpeak(undefined), true);
  assert.equal(ownerFinanceScopeMaySpeak({ stage:"handoff", selfService:null }), false);
  assert.equal(ownerFinanceScopeMaySpeak({ stage:"routed", selfService:{ step:"awaiting_cpf" } }), false);
  assert.equal(ownerFinanceScopeMaySpeak({ stage:"routed", selfService:{ step:"payment_reported" } }), false);
  assert.equal(ownerFinanceScopeMaySpeak({ stage:"routed", selfService:{ step:"verified" } }), true);
});

test("expiry restores fresh incumbent routing but holds in-window re-delivery", () => {
  const at = now + 2000;
  assert.equal(ownerFinancePilotTraffic(env, base, at), true); // originated inside the pilot
  assert.equal(scope(base, {}, at), undefined); // held, no send or legacy fallback
  assert.equal(ownerFinancePilotTraffic(env, { ...base, sentAt: iso(now+1000) }, at), false);
  assert.equal(ownerFinancePilotTraffic(env, { ...base, sentAt: iso(now+1500) }, at), false);
  assert.equal(ownerFinancePilotTraffic(env, { ...base, sentAt: iso(now+2500) }, at), true);
  assert.equal(ownerFinancePilotTraffic(env, { ...base, sentAt: undefined }, at), true);
  assert.equal(ownerFinancePilotTraffic(env, { ...base, sentAt: iso(now+1500), phoneNumberId: "999999000000" }, at), true);
});
