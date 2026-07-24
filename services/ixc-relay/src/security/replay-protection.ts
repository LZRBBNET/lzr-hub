export class NonceStore {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    ttlMs: number,
    now = () => Date.now(),
  ) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  consume(nonce: string) {
    this.purge();
    if (this.entries.has(nonce)) return false;
    this.entries.set(nonce, this.now() + this.ttlMs);
    return true;
  }

  private purge() {
    const now = this.now();
    for (const [nonce, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(nonce);
    }
  }
}
