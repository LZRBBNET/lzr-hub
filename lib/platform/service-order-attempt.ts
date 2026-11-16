// Persist only opaque keys and completion markers, never the OS description.
export const OS_ATTEMPT_STORAGE_KEY = "lzr.os.pending.v1";
type AttemptStorage = Pick<Storage, "getItem" | "setItem">;
export function readServiceOrderAttempt(storage: Pick<Storage, "getItem">): string | null {
  const key = storage.getItem(OS_ATTEMPT_STORAGE_KEY);
  return key && storage.getItem(`${OS_ATTEMPT_STORAGE_KEY}.done.${key}`) !== "1" ? key : null;
}
export function rememberServiceOrderAttempt(storage: AttemptStorage, createKey: () => string): string {
  const existing = readServiceOrderAttempt(storage);
  if (existing) return existing;
  const key = `os-${createKey()}`;
  storage.setItem(OS_ATTEMPT_STORAGE_KEY, key);
  return key;
}
export function releaseServiceOrderAttempt(storage: AttemptStorage, status: string, expectedKey: string): boolean {
  if (status !== "success" && status !== "blocked") return false;
  if (storage.getItem(OS_ATTEMPT_STORAGE_KEY) !== expectedKey) return false;
  // Never delete the shared pointer: another tab may replace it after getItem.
  // Mark only the exact attempt whose terminal response was observed.
  storage.setItem(`${OS_ATTEMPT_STORAGE_KEY}.done.${expectedKey}`, "1");
  return true;
}
