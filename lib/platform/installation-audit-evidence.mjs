// Pure audit of proof-of-completion. No IXC writes, messages or ticket changes.
export const installationEvidenceRule = "ixc.installation-evidence@2";
const idOk = (value) => typeof value === "string" && /^[1-9][0-9]{0,31}$/.test(value);
const timeOk = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value.slice(0,10)+"T00:00:00.000Z").toISOString().slice(0,10) === value.slice(0,10);
const sources = new Set(["ixc", "seenet"]);
const types = new Set(["diagnostico","equipe","anexos","comodato","materiais","assinatura","ativacao","medicao"]);

export function evaluateInstallationEvidence(input) {
  const { expected, order, closure, policy, consultedAt, evidence } = input ?? {};
  const audit = (status, reason, checks = []) => ({
    rule: installationEvidenceRule, status, reason,
    consultedAt: timeOk(consultedAt) ? consultedAt : null, checks
  });
  if (!timeOk(consultedAt) || !expected ||
      ![expected.orderId, expected.contractId, expected.customerId].every(idOk) ||
      !order || order.id !== expected.orderId || order.contractId !== expected.contractId ||
      order.customerId !== expected.customerId || !idOk(order.subjectId)) {
    return audit("unverified", "order_or_link_unconfirmed");
  }
  if (order.status !== "F") return audit("unverified", "order_not_confirmed_finalized");
  // The source adapter must establish the latest closing transition from a
  // complete timeline or equivalent immutable history, not the current status.
  if (!closure || closure.latestTransitionVerified !== true || !idOk(closure.eventId) ||
      closure.orderId !== order.id || closure.contractId !== order.contractId ||
      closure.customerId !== order.customerId || closure.subjectId !== order.subjectId ||
      closure.method !== order.closureMethod || !timeOk(closure.closedAt) ||
      Date.parse(closure.closedAt) > Date.parse(consultedAt)) {
    return audit("unverified", "closure_episode_unconfirmed");
  }
  const closedAt = Date.parse(closure.closedAt);
  if (!policy || policy.effectivePeriodVerified !== true || !timeOk(policy.validFrom) ||
      !timeOk(policy.verifiedThrough) || Date.parse(policy.validFrom) > closedAt ||
      Date.parse(policy.verifiedThrough) < closedAt ||
      Date.parse(policy.verifiedThrough) > Date.parse(consultedAt) || policy.subjectId !== order.subjectId || policy.kind !== "installation" ||
      policy.method !== order.closureMethod || !["ixc_wizard","ixc_other","seenet"].includes(policy.method) ||
      !Array.isArray(policy.requirements) || policy.requirements.length === 0) {
    return audit("unverified", "applicable_requirements_unconfirmed");
  }
  const seen = new Set();
  if (policy.requirements.some((item) => {
    const invalid = !item || !types.has(item.type) || seen.has(item.type) ||
      !Array.isArray(item.sources) || !item.sources.length ||
      !item.sources.every((source) => sources.has(source)) ||
      new Set(item.sources).size !== item.sources.length ||
      !Number.isSafeInteger(item.minimum) || item.minimum < 1;
    if (!invalid) seen.add(item.type);
    return invalid;
  })) return audit("unverified", "applicable_requirements_unconfirmed");

  const checks = policy.requirements.map(({ type, sources: expectedSources, minimum }) => {
    const rows = Array.isArray(evidence) ? evidence.filter((item) => item && item.type === type &&
      item.orderId === order.id && item.contractId === order.contractId && item.customerId === order.customerId &&
      item.closureEventId === closure.eventId) : [];
    const complete = expectedSources.map((source) => {
      const candidates = rows.filter((row) => row.source === source);
      if (candidates.length !== 1) return null;
      const row = candidates[0];
      if (row.coverage !== "complete" || !timeOk(row.readAt) ||
          Date.parse(row.readAt) < closedAt || Date.parse(row.readAt) > Date.parse(consultedAt) || !Array.isArray(row.recordIds) ||
          !row.recordIds.every(idOk)) return null;
      const recordIds = [...new Set(row.recordIds)].sort();
      return { source, readAt: row.readAt, count: recordIds.length, recordIds };
    });
    const enough = complete.some((item) => item !== null && item.count >= minimum);
    const confirmedBelowMinimum = complete.every(Boolean) &&
      complete.reduce((max, item) => max + item.count, 0) < minimum;
    // Copied evidence may occur in both systems. Never add counts across sources
    // without a cross-system identity map.
    return { type, minimum, sources: complete.filter(Boolean), status: enough ? "clear" :
      confirmedBelowMinimum ? "confirmed" :
      complete.some(Boolean) ? "review" : "unverified" };
  });
  const status = ["confirmed","review","unverified","clear"].find((candidate) =>
    checks.some((check) => check.status === candidate));
  return { ...audit(status, status === "confirmed" ? "documentary_gap_only" : "evidence_assessed", checks),
    orderId: order.id, contractId: order.contractId, customerId: order.customerId, subjectId: order.subjectId,
    closureEventId: closure.eventId, closedAt: closure.closedAt };
}
