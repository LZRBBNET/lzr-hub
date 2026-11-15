# Cached PostgreSQL runtime grant validation

This harness tests a local disposable PostgreSQL 17 cluster using the cached official digest already present. It performs no Docker build, image pull, registry access, remote database operation or deployment. `--pull=never` and the expected cached digest are checked. The tested source is based on `43f3664` / tree `7556397`; each run records exact source/harness hashes.

Run `node tests/manual/runtime-grants-pg17.mjs --run` after preparing a synthetic artifact with installed dependencies (the pg package version is checked against package-lock). No package installation is part of this test. The readonly host-mounted source, artifact, Node binary and copied dependency directory make this a runtime prototype, not validation of the blocked image package. Copies are made world-readable only within owned nonsecret temporary code directories so the application UID 10001 can read them; shared source/dependency permissions are not changed.

The unchanged bootstrap creates only a new empty synthetic database and role credentials. Application connections use the restricted role. The baseline mode reproduces permission failures through actual repository methods rather than inferring them from grant strings. Final mode exercises repository behavior, negative permissions, real internal HTTP APIs and restart/session invalidation. All records are sanitized; passwords, cookies and returned client data are excluded.

The role is scoped to the prepared demo flows, not the complete LZR feature set. These tests do not claim server-wide connection isolation: default CONNECT permissions on other new-cluster databases are outside this task. Image build, browser TLS, hosting behavior and attributable resource-budget verification remain unproved.

## Reproduced failures and minimal correction

The original grants produced SQLSTATE 42501 through actual `DbConversationsRepository.getAudit` and `DbConversationStateRepository.audit` calls. After those two fixes, the actual `hasDelivery` helper reproduced a third SQLSTATE 42501. Baseline evidence is saved separately as `runtime-grants-baseline.json` and `runtime-grants-delivery-baseline.json` in the local evidence directory; each records source hashes and successful cleanup. Baseline modes are for their corresponding historical grant sets, not expected to pass against the corrected grants.

Only these reads were added:

- `audit_events.id`, required by INSERT RETURNING confirmation. Other audit content stays unreadable.
- Twelve `conversation_outcomes` columns used by context/list predicates, projections and ordering; `id` stays unreadable.
- `channel_idempotency_keys.idempotency_key`, required to check the delivery lock. Other columns and INSERT/UPDATE/DELETE remain forbidden.

No application query, identity pin, authorization rule or delivery capability changed. The first mounted fixture attempt lacked Dockerfile WORKDIR `/app`; matching that working directory allowed the unchanged supervisor to start. No supervisor guard was relaxed.

These results do not verify all installed dependency bytes against integrity hashes. They test the recorded source/artifact with installed dependencies and an explicit pg-version match.

## Observed final local result

The final precommit run passed two generations using actual PostgreSQL and internal application APIs: login/password change, Customer360, handoff context/owner claim, promise pause, paid-customer exclusion with zero enqueue. Repository checks and all negative DDL/admin/column/mutation checks passed in both generations. The OS application user could not read the root-only operator material or PostgreSQL data file. Restart invalidated the old session and the flows passed again. Final cleanup confirmed owned containers and private temporary copies removed, while the pre-existing official cached image was retained.

Evidence: `/workspace/evidence/runtime-grants-final.json`. Its recorded grant SHA256 is `bbc3c62122447e276092d463dec6c1462ceda35df36a9b9f287107a5f38d4f66`. The coordinator must run the final committed SHA before publication; a later formatting-only transfer callback edit removes a lint warning and does not retrospectively change the recorded precommit source hashes.

Docker archive copying could not retrieve a fixed canary file that was independently confirmed visible inside a tmpfs container. The restart test therefore retains only its synthetic cookie in a private bounded Buffer, checks the exact fixed prefix plus 64 hexadecimal characters format, and restores it via stdin to a new root-owned 0600 file. The cookie never appears in argv, logs, evidence or host file exports. Owned buffers are cleared on completion/error; this is not a claim of cryptographic erasure of all OS/runtime copies.

The final resource observation remains unattributed/unverified. Successful local functional and privilege checks do not prove image build reproducibility, TLS/browser behavior, remote hosting, or 512 MiB/0.1 CPU viability.
