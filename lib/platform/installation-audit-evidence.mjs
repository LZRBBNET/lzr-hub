// Pure audit of proof-of-completion. No IXC writes, messages or ticket changes.
export const installationEvidenceRule = "ixc.installation-evidence@1";
const idOk = (value) => typeof value === "string" && /^[1-9][0-9]{0,31}$/.test(value);
const timeOk = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const sources = new Set(["ixc", "seenet"]);
const types = new Set(["diagnostico","equipe","anexos","comodato","materiais","assinatura","ativacao","medicao"]);

export function evaluateInstallationEvidence(input) {
  const { expected, order, policy, consultedAt, evidence } = input ?? {};
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
  if (!policy || policy.subjectId !== order.subjectId || policy.kind !== "installation" ||
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
      item.orderId === order.id && item.contractId === order.contractId && item.customerId === order.customerId) : [];
    const complete = expectedSources.map((source) => {
      const candidates = rows.filter((row) => row.source === source);
      if (candidates.length !== 1) return null;
      const row = candidates[0];
      if (row.coverage !== "complete" || !timeOk(row.readAt) ||
          Date.parse(row.readAt) > Date.parse(consultedAt) || !Array.isArray(row.recordIds) ||
          !row.recordIds.every(idOk)) return null;
      const recordIds = [...new Set(row.recordIds)].sort();
      return { source, readAt: row.readAt, count: recordIds.length, recordIds };
    });
    const enough = complete.some((item) => item !== null && item.count >= minimum);
    const confirmedEmpty = complete.every((item) => item !== null && item.count === 0);
    // Copied evidence may occur in both systems. Never add counts across sources
    // without a cross-system identity map.
    return { type, minimum, sources: complete.filter(Boolean), status: enough ? "clear" :
      confirmedEmpty ? "confirmed" : complete.every(Boolean) && complete.length === 1 ? "confirmed" :
      complete.some(Boolean) ? "review" : "unverified" };
  });
  const status = ["confirmed","review","unverified","clear"].find((candidate) =>
    checks.some((check) => check.status === candidate));
  return { ...audit(status, status === "confirmed" ? "documentary_gap_only" : "evidence_assessed", checks),
    orderId: order.id, contractId: order.contractId, customerId: order.customerId, subjectId: order.subjectId };
}
