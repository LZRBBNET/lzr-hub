import { evaluatePromiseHold } from "./promise-hold.mjs";
// Pure reusable guard, not registered with the default worker by this port.
// No transport, credentials or evidence adapter lives here. Calls without
// trusted evidence and an explicit continuation fail closed.
const BILLING_QUEUE = "billing-reminders";
const MAX_EVIDENCE_AGE_MS = 5_000;
const CHANNELS = ["WhatsApp", "SMS", "E-mail", "Ligação"];
const BRASILIA = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23", weekday: "short",
});

export class BillingReminderBlockedError extends Error {
  constructor(code) { super(code); this.name = "BillingReminderBlockedError"; this.code = code; }
}

const TERMINAL_BILLING_BLOCKS = new Set([
  "BILLING_PROMISE_ACTIVE", "BILLING_JOB_OBSOLETE", "BILLING_JOB_CANCELLED", "BILLING_INVOICE_NOT_OPEN",
  "BILLING_INTENT_INACTIVE", "BILLING_CONTINUATION_FAILED", "BILLING_CONTINUATION_RESULT_INVALID",
]);

/** Only trusted guard errors, never a matching string supplied in job data. */
export function terminalBillingReason(error) {
  const source = error instanceof BillingReminderBlockedError ? error : error?.cause;
  return source instanceof BillingReminderBlockedError && TERMINAL_BILLING_BLOCKS.has(source.code) ? source.code : null;
}

function block(code) { throw new BillingReminderBlockedError(code); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value) { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function instant(value) {
  if (typeof value !== "string") return NaN;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed.getTime() : NaN;
}
function clock(now) {
  try {
    const value = now();
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  } catch { /* Only fixed error codes may reach worker logs or the DLQ. */ }
  block("BILLING_CLOCK_INVALID");
}
function scheduleIsCurrent(scheduledFor, now) {
  const parts = Object.fromEntries(BRASILIA.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}` === scheduledFor
    && !["Sat", "Sun"].includes(parts.weekday) && Number(parts.hour) >= 8 && Number(parts.hour) < 20;
}
function jobContext(job) {
  if (!record(job) || job.queueName !== BILLING_QUEUE || !record(job.data)) block("BILLING_JOB_INVALID");
  if (job.data.cancelled !== undefined && job.data.cancelled !== false) block("BILLING_JOB_CANCELLED");
  const payload = job.data.payload;
  if (!record(payload) || payload.schemaVersion !== 1
    || ![payload.invoiceId, payload.customerId, payload.ruleId, payload.stepId].every(id)
    || !Number.isSafeInteger(payload.ruleVersion) || payload.ruleVersion < 1
    || !date(payload.scheduledFor) || !CHANNELS.includes(payload.channel)
    || typeof payload.templateId !== "string" || !payload.templateId.trim()
    || payload.templateId.length > 180 || payload.templateId !== payload.templateId.trim()
    || /[\u0000-\u001f\u007f]/.test(payload.templateId)) block("BILLING_JOB_INVALID");
  const idempotencyKey = `${payload.invoiceId}:${payload.stepId}:${payload.scheduledFor}`;
  if (job.data.idempotencyKey !== idempotencyKey || job.name !== `collection-step:${payload.stepId}`) block("BILLING_JOB_CONTEXT_MISMATCH");
  // Only identifiers/context are passed on. Claims of eligibility in a queued
  // payload (status, paid, timestamps or even an evidence object) are ignored.
  return Object.freeze({
    invoiceId: payload.invoiceId, customerId: payload.customerId,
    ruleId: payload.ruleId, ruleVersion: payload.ruleVersion, stepId: payload.stepId,
    scheduledFor: payload.scheduledFor, channel: payload.channel, templateId: payload.templateId,
    idempotencyKey,
  });
}

async function readFreshEvidence(readEvidence, context, requestedAt) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => readEvidence(context, { requestedAt, signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("EVIDENCE_TIMEOUT"));
        }, MAX_EVIDENCE_AGE_MS);
      }),
    ]);
  } catch { block("BILLING_EVIDENCE_UNAVAILABLE"); }
  finally { clearTimeout(timer); }
}

/**
 * readEvidence must be a trusted server-side dependency, never a job payload
 * callback. It must fetch the exact invoice and current dispatch/rule/cancel
 * state during THIS call, without cache or partial/list-only fallbacks. Invoice
 * value must be a confirmed positive open balance, never the face value.
 * promises must contain a complete, freshly read list for this exact customer
 * and invoice: { complete: true, customerId, invoiceId, items }. Missing
 * promise evidence blocks. Access/unlock claims in payloads are never authority.
 * A continuation is an explicit integration boundary, not an existing sender.
 */
/** @param {unknown} job
 * @param {{readEvidence?: Function, continueEligible?: Function, now?: () => Date}} [options]
 */
export async function processBillingReminder(job, { readEvidence, continueEligible, now = () => new Date() } = {}) {
  const context = jobContext(job);
  const requestedAt = clock(now);
  if (!scheduleIsCurrent(context.scheduledFor, requestedAt)) block("BILLING_JOB_OBSOLETE");
  if (typeof readEvidence !== "function") block("BILLING_EVIDENCE_SOURCE_UNAVAILABLE");
  const evidence = await readFreshEvidence(readEvidence, context, requestedAt.toISOString());
  const checkedAt = clock(now);
  const observedAt = instant(evidence?.observedAt);
  if (!record(evidence) || evidence.complete !== true || !record(evidence.invoice) || !record(evidence.intent)) block("BILLING_EVIDENCE_INCOMPLETE");
  if (!Number.isFinite(observedAt) || checkedAt.getTime() - requestedAt.getTime() > MAX_EVIDENCE_AGE_MS
    || observedAt < requestedAt.getTime()
    || observedAt > checkedAt.getTime() || checkedAt.getTime() - observedAt > MAX_EVIDENCE_AGE_MS) block("BILLING_EVIDENCE_STALE");
  if (!scheduleIsCurrent(context.scheduledFor, checkedAt)) block("BILLING_JOB_OBSOLETE");
  if (job.data.cancelled !== undefined && job.data.cancelled !== false) block("BILLING_JOB_CANCELLED");

  const { invoice, intent } = evidence;
  if (invoice.id !== context.invoiceId || invoice.customerId !== context.customerId) block("BILLING_INVOICE_IDENTITY_MISMATCH");
  if (typeof invoice.status !== "string" || !/^(?:a|abert[ao]|em aberto)$/i.test(invoice.status.trim())) block("BILLING_INVOICE_NOT_OPEN");
  const cents = typeof invoice.value === "number" ? Math.round(invoice.value * 100) : NaN;
  if (invoice.valueSource !== "open-balance" || typeof invoice.value !== "number" || !Number.isFinite(invoice.value)
    || invoice.value <= 0 || !Number.isSafeInteger(cents) || cents <= 0) block("BILLING_INVOICE_BALANCE_UNCONFIRMED");
  for (const key of Object.keys(context)) {
    if (intent[key] !== context[key]) block("BILLING_INTENT_MISMATCH");
  }
  if (intent.cancelled !== false || intent.active !== true || intent.current !== true) block("BILLING_INTENT_INACTIVE");
  if (!date(invoice.dueAt) || !Number.isInteger(intent.offsetDays) || intent.offsetDays < -30 || intent.offsetDays > 180) block("BILLING_EVIDENCE_INCOMPLETE");
  const scheduled = new Date(`${invoice.dueAt}T00:00:00.000Z`);
  scheduled.setUTCDate(scheduled.getUTCDate() + intent.offsetDays);
  if (scheduled.toISOString().slice(0, 10) !== context.scheduledFor) block("BILLING_JOB_OBSOLETE");
  const hold = evaluatePromiseHold(evidence.promises, context.customerId, context.invoiceId, checkedAt);
  if (hold.state === "unverified") block("BILLING_PROMISES_UNCONFIRMED");
  if (hold.state === "paused") block("BILLING_PROMISE_ACTIVE");
  if (typeof continueEligible !== "function") block("BILLING_CONTINUATION_UNAVAILABLE");
  let result;
  try { result = await continueEligible(context); }
  catch { block("BILLING_CONTINUATION_FAILED"); }
  if (!record(result)) block("BILLING_CONTINUATION_RESULT_INVALID");
  // Never fabricate a delivery receipt or processedAt on this path.
  return result;
}
