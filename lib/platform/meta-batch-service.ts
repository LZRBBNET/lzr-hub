/** A failed item must not abort unrelated messages or acknowledge a lost input.
 * Retry is at batch level; each handler retains its durable inbound idempotency.
 * Never return exception text, customer identifiers or message contents.
 */
export async function processMetaBatch<T>(messages: readonly T[], process: (message: T) => Promise<void>) {
  let failed = 0;
  for (const message of messages) {
    try { await process(message); } catch { failed++; }
  }
  return { failed };
}
