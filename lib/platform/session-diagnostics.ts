/** Coarse server-only diagnostics. Never accepts request, token, user or error data. */
export type SessionFailureReason = "missing_cookie" | "unreadable_cookie" | "unresolved_session" | "lookup_failed";
const reasons: readonly SessionFailureReason[] = ["missing_cookie", "unreadable_cookie", "unresolved_session", "lookup_failed"];

/** Bounded per-process throttling. Diagnostic failures never alter authorization. */
export function createSessionFailureReporter(
  write: (message: string) => void,
  now: () => number = () => performance.now(),
) {
  const last = new Map<SessionFailureReason, number>();
  return (reason: SessionFailureReason): void => {
    if (!reasons.includes(reason)) return;
    try {
      const at = now();
      if (!Number.isFinite(at)) return;
      const previous = last.get(reason);
      if (previous !== undefined && at - previous < 60_000) return;
      last.set(reason, at);
      write(JSON.stringify({ event: "auth.session_unavailable", reason }));
    } catch { /* Logging must never grant access or break authentication. */ }
  };
}

export async function resolveObservedSession<T>(
  readToken: () => string | undefined,
  lookup: (token: string) => Promise<T | undefined>,
  report: (reason: SessionFailureReason) => void,
): Promise<T | undefined> {
  const note = (reason: SessionFailureReason) => { try { report(reason); } catch { /* fail closed */ } };
  let token: string | undefined;
  try { token = readToken(); } catch { note("unreadable_cookie"); return undefined; }
  if (!token) { note("missing_cookie"); return undefined; }
  try {
    const user = await lookup(token);
    if (!user) note("unresolved_session");
    return user;
  } catch { note("lookup_failed"); return undefined; }
}
