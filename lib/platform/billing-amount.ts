/** Observed nonnegative amount representable in cents; zero is a valid amount.
 * Unknown/negative/nominal-only amounts are not interpreted as credit or payment.
 * Missing source is supported for existing internally typed DTOs.
 */
export function billingAmount(value: unknown, source?: unknown): number | null {
  if (source !== undefined && source !== "open-balance") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = value * 100, rounded = Math.round(cents);
  if (!Number.isSafeInteger(rounded) || Math.abs(cents-rounded) > Number.EPSILON*Math.max(1,Math.abs(cents))*8) return null;
  return value;
}
/** Raw API parsing, deliberately excludes coercion of arrays/booleans/objects. */
export function parseBillingAmount(raw: unknown): number | null {
  if (typeof raw === "number") return billingAmount(raw);
  if (typeof raw !== "string" || !/^\d+(?:[.,]\d+)?$/.test(raw.trim())) return null;
  return billingAmount(Number(raw.trim().replace(",",".")));
}
export function addBillingAmount(sum: number | null, value: number | null): number | null {
  return sum === null || value === null ? null : billingAmount(sum+value);
}
