// Persist only an opaque key; no customer, subject, message or credential.
export const OS_ATTEMPT_STORAGE_KEY = "lzr.os.pending.v1";
export function rememberServiceOrderAttempt(storage: Pick<Storage, "getItem" | "setItem">, createKey: () => string): string {
  const existing = storage.getItem(OS_ATTEMPT_STORAGE_KEY);
  if (existing) return existing;
  const key = `os-${createKey()}`;
  storage.setItem(OS_ATTEMPT_STORAGE_KEY, key); // A storage failure must prevent sending.
  return key;
}
export function releaseServiceOrderAttempt(storage: Pick<Storage, "removeItem">, status: string): boolean {
  if (status !== "success" && status !== "blocked") return false;
  storage.removeItem(OS_ATTEMPT_STORAGE_KEY);
  return true;
}
