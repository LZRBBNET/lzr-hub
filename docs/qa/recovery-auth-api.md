# One-shot authenticated API gate — isolated synthetic Railway installation

This is a **test-only API runner**, not a browser automation workaround, product feature, production startup or authentication bypass. It exercises the real built application through its ordinary HTTP login, session cookies and authorization checks, backed by the approved disposable PostgreSQL database. All ERP responses and customer records are synthetic.

A passing API run does **not** establish a browser/UI pass, real IXC compatibility, actual payment, recovered revenue, prevented cancellation or customer contact. It does not replace the browser acceptance checklist in [recovery-browser-homologation.md](recovery-browser-homologation.md).

## Authority and prerequisites

This document grants no deployment, account, spending or publication permission. Before running, the operational owner must verify:

1. Existing approval covers the exact isolated test installation and two synthetic accounts. Keep the **original** approved cost ceiling and deadline; this runner neither renews them nor creates a new allowance. If the remaining window or budget is inadequate, stop rather than extending either in configuration.
2. Railway control-plane project/environment/app/DB/volume identities match the reviewed manifest and none is a production identity. Use only the previously approved test DB service, its private hostname and test-only DB credential. Do not clone production, inherit production variables or create an ongoing API connection.
3. The target is a **new empty nonce-named database with a separately provisioned and read-back marker**, following [railway-recovery-gate.md](railway-recovery-gate.md). A database already migrated by an earlier gate is not eligible. Never erase, reset, rename or restore that database to make this run pass.
4. The dedicated app service has **no public domain, public TCP endpoint, cron or automatic restart/redeploy retry**. Keep the approved resource caps. The runner's HTTP client is loopback-only; the unchanged child entrypoint starts the application on its service interface, so absence of public exposure must also be verified in the platform.
5. The exact reviewed source commit is built with its lockfile and required runtime dependencies. The manifest and genuine Railway Git metadata agree with that commit; do not spoof platform identity or source variables. The artifact contains no actual dotenv files. Use the existing verified build, never a pre-deploy migration or `npm start`.

Do not run the standalone DB gate first on this database. The unchanged browser entrypoint executes that gate in the same invocation, then seeds only after the real assertions pass. A previous standalone PostgreSQL PASS is useful evidence, but not an override of the fresh-database guard.

## One-shot startup and input contract

Dedicated test-service startup:

```sh
node --experimental-strip-types scripts/test-recovery-auth-api-railway.mjs
```

Retain all unchanged Railway target, private test DB URL, migration acknowledgment and real runtime identity requirements from `railway-recovery-gate.md`. Retain the synthetic seed acknowledgment and explicit unprivileged `PORT` required by the existing browser entrypoint. The API runner adds one explicit acknowledgment:

```text
RECOVERY_API_ALLOW_SYNTHETIC_CHECKS=<environmentId>:<databaseServiceId>:<nonce>
```

All three acknowledgment values must refer to the **same** verified target:

- `RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION`
- `RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED`
- `RECOVERY_API_ALLOW_SYNTHETIC_CHECKS`

Do not supply any other `RECOVERY_API_*` variable. Do not supply the four browser operator/reader password-hash/salt variables: this mode generates its own two credentials and passes only their compatible hash/salt values to the unchanged entrypoint. It is separate from the private Console password handoff; do not run both credential paths together.

Do not configure passwords in environment variables or command arguments. Do not configure `DATABASE_URL`, `PG*`, operational tokens, real IXC credentials, enabled outer feature flags or a proxy destination. The existing target/environment refusal checks remain in force. The only DB URL belongs in the approved private test-URL variable, never in source, screenshots, chat or evidence logs.

## Credentials, transport and lifecycle

- Two independent cryptographically generated synthetic passwords remain in the runner's memory. They are used only for ordinary HTTP login as `operator@lzr-qa.invalid` and `reader@lzr-qa.invalid`; no session or bearer token is pre-seeded and no product authentication path is changed.
- Compatible hashes/salts are supplied privately to the child entrypoint for its existing seed. The application necessarily stores password verifiers and sessions in the disposable database. **Process exit does not mean those DB records were deleted.** There is no claim of guaranteed Node/platform memory zeroization or per-user expiry.
- Requests go only to literal `127.0.0.1` at the validated app port using the runner's constrained HTTP client. No proxy, redirects, absolute external URL or alternative host is used. Cookies remain in memory and are never printed. Synthetic IXC is the existing local, read-only, non-proxy fixture; no real IXC or message transport is used.
- Child output is not forwarded verbatim. Only reviewed stage markers and sanitized outcomes may appear in evidence; raw exceptions, request/response bodies, cookies, passwords, hashes, salts and connection settings do not belong in logs.
- Authentication failures identify a fixed assertion stage and, when available, only a validated numeric HTTP status (for example `AUTH_WRONG_PASSWORD HTTP503`). No body, header, credential or cookie value is included. A stage/status is diagnostic evidence, not a successful login.
- The app's database URL preserves the exact private IP verified by the existing gate/seed. For IPv6, the same address is also supplied as the driver's `host` query parameter because the installed pg URL parser retains authority brackets. No new DNS target or fallback is introduced. A local socket reproduction proves this transport correction, not the cause of any past remote failure or a PostgreSQL/authentication pass.
- The active check phase is limited to at most **five minutes**, followed by bounded cleanup; this is not a claim that total wall time is exactly five minutes. The active deadline also reserves 20 seconds for cleanup inside the original approval expiry. On success, failure, signal or approval expiry, the runner must stop its detached child process group, including the app and fixture. Verify the actual terminal deployment/process state. An attempted stop is not evidence that every child stopped.
- Runtime termination is **not** a Railway billing cap or infrastructure deletion. The operational owner must monitor actual usage and stop/remove only the approved temporary resources before the original budget/deadline, preserving evidence and never touching production.

## What to verify and record

Record the exact source commit, verified environment/deployment identities, Node/PostgreSQL versions, UTC start/end times and sanitized stage outcomes. Never treat a launch, generic health response, inferred log message or partially completed run as a PASS.

The current runner separately checks:

1. **Database stage:** the unchanged gate actually completed migration and its real transaction/concurrency assertions in this invocation, followed by the existing synthetic seed. Mocked tests or a historical PASS log do not substitute.
2. **Authentication:** unauthenticated protected requests fail; ordinary login produces a real session; wrong credentials fail generically; logout revokes the tested session.
3. **Case lifecycle and persistence:** creation and manual-note history survive subsequent authenticated reads; ownership claim and future next-return scheduling are checked through the ordinary mutation responses; same-key retries replay without duplicate history; a different-key duplicate active case and stale-version mutation conflict without persisted changes; manual close/reopen respects active-case uniqueness. A manual case event is not a payment receipt. Ownership and next-return UI behavior are not asserted by this runner.
4. **Safe references and promises:** exact invoice outside the first 20 can be used where permitted; wrong-client, missing, received, cancelled or unknown references are rejected as applicable, without unintended version/history changes. A promise is not money received. Reconciliation may recognize only the fixture's deliberately received invoice, not a real payment; a subsequent read must retain exactly the expected pending synthetic promise.
5. **Attendance reference:** the accepted protocol stores the expected synthetic conversation ID, while the other customer's protocol is rejected without case version/history change. This checks a backend reference, not actual navigation to that conversation.
6. **Read-only role:** the second user can read the case list with the expected role metadata, but direct authenticated note mutation, promise creation and promise review return 403; the runner checks unchanged case history/version and pending-promise count. This is not an exhaustive test of every mutation endpoint or a read-only UI test.

Each assertion must be recorded as **passed, failed or not run**, according to what the script actually checked. If a particular step is absent from the reviewed runner, do not infer it from a neighboring success. Only the runner's final success marker after every implemented assertion and cleanup represents this API gate's PASS.

## Failure and rerun policy

Run once against the verified empty target. If anything fails after migration starts or the outcome is uncertain:

1. Preserve sanitized logs, source/deployment identity and the current database for inspection.
2. Stop remaining test processes and verify their terminal state without dumping process environments or secrets.
3. Determine which stages actually executed. Do not call a controlled refusal a successful test or assume an empty DB because the final marker was absent.
4. Do **not** rerun, reseed, delete tables, reset passwords, restore a snapshot or restart automatically. Inspect the cause first. Any later attempt requires another explicitly verified fresh marked test database within the existing approved resources, remaining budget and deadline, or renewed authority if those limits no longer permit it.

There is no automatic repair, retry, database reset or infrastructure cleanup path. No human password setup, browser takeover or public login domain is needed for this API-only run.

## Evidence boundaries and remaining browser gate

Local unit tests verify input refusal, credential separation, strict transport behavior, stage parsing and child cleanup with controlled doubles. A composed flow uses real auth/password/session functions, real case handlers and RBAC, real promise helpers, and the real readonly adapter with synthetic HTTP responses plus in-memory repositories. It validates compatibility of the API assertions, not a real HTTP server or PostgreSQL transaction.

```sh
node --experimental-strip-types --test tests/recovery-auth-api.test.mjs
```

These local tests cannot prove a real Railway deployment, real PostgreSQL transaction result or successful application HTTP session.

A real run on Railway can establish the specific DB and authenticated HTTP behaviors actually asserted. It still cannot establish screen rendering, visible labels, browser cookies under HTTPS, login-form interaction, double-click behavior, modal cancellation, Back/Forward history, late asynchronous UI responses, correct Attendance navigation outside the newest 40, or visual read-only controls. Those remain the separately authorized **real-browser gate** with its own passed/failed/not-run record. Customer360 coverage/labels, financial-overview rendering, ownership and next-return controls are also outside this API runner's assertions.

Before actual execution, label this artifact **prepared, not run**. After execution, append a sanitized evidence reference and exact tested commit; do not rewrite unrun browser checks as completed or equate synthetic receipts with financial impact.
