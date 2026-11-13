/** Reminder policy only: never changes service access or infers payment. */
const calendar = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function evaluatePromiseHold(snapshot, customerId, invoiceId, now) {
  const unknown = { state: "unverified" };
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !customerId || !invoiceId
    || snapshot?.complete !== true || snapshot.customerId !== customerId || snapshot.invoiceId !== invoiceId
    || !Array.isArray(snapshot.items)) return unknown;
  const parts = Object.fromEntries(calendar.formatToParts(now).map(({ type, value }) => [type, value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  let until = null;
  const seen = new Set();
  for (const item of snapshot.items) {
    if (!item || typeof item.id !== "string" || !item.id || seen.has(item.id)
      || item.customerId !== customerId || item.invoiceId !== invoiceId
      || !["pending", "fulfilled", "broken"].includes(item.status) || !validDate(item.promisedFor)) return unknown;
    seen.add(item.id);
    if (item.status === "pending" && item.promisedFor >= today && (!until || item.promisedFor > until)) until = item.promisedFor;
  }
  if (!until) return { state: "eligible-for-evaluation" };
  const next = new Date(`${until}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate() + 1);
  return { state: "paused", through: until, resumeOn: next.toISOString().slice(0, 10) };
}
