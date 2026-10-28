# Private Console handoff for the two synthetic test accounts

This is an optional **test-only credential provisioner**, not a product signup, password reset, login bypass or new public endpoint. It solves one specific handoff: the real browser must use the ordinary login form, while the browser assistant must never see or type either reusable password.

The application, its authentication/RBAC and `start-recovery-browser-railway.mjs` are unchanged. The existing PostgreSQL gate remains the only route to migration/seed. It must run on a **second fresh, separately marked test database** when a previous standalone gate has already migrated the first one. Never rerun, erase or reset that previous database to obtain a green result.

## Before starting any billable waiting runtime

1. Confirm the user's explicit authorization for these two temporary synthetic accounts and the existing isolated environment, cost ceiling and deadline. Neither a manifest nor this document grants permission.
2. Confirm the user is available for a short **manual takeover of the authenticated Railway Console**, followed by secure credential requests on the actual app login. Do not start a waiting deployment overnight. This is not autonomous sign-in.
3. Use only the approved QA app/DB/service/volume identities and a new empty nonce-named database in that same QA DB service. No production credentials, data, account or network endpoint may be used. Provision/read back its marker separately as documented in `railway-recovery-gate.md`.
4. Build the exact reviewed commit including this script. Update the target manifest to that real commit; do not spoof Railway Git metadata. Keep dev dependencies, the verified build, restart **Never**, no pre-deploy migration/cron and no automatic repeated deployment. A failed run must be inspected, not blindly restarted.
5. Configure the unchanged manifest, private test DB reference, migration ACK, synthetic seed ACK and explicit unprivileged `PORT`. **Do not configure the four hash/salt variables for this mode**, plaintext password variables, `DATABASE_URL`, `PG*`, real integration tokens or enabled outer feature flags. The bridge refuses unexpected `RECOVERY_BROWSER_*` inputs.

## Startup and one private user step

Dedicated QA start command:

```sh
node --experimental-strip-types scripts/recovery-browser-console.mjs wait
```

After full identity/time/feature preflight, it logs `WAITING` and waits at most **15 minutes**, also bounded by the original approval deadline. Before handoff it opens no HTTP listener or DB connection and creates no account. The source still needs a real running Railway container so the Console can connect; successful local testing does not prove Railway Console availability.

On the **same QA app container**, the provisioner opens Railway Console, confirms the correct environment/service/deployment and prepares this non-secret command:

```sh
node --experimental-strip-types scripts/recovery-browser-console.mjs provision
```

Then use the browser's documented manual takeover. The user, not the assistant, enters:

1. A new temporary password for `operator@lzr-qa.invalid`, then repeats it.
2. A **different** temporary password for `reader@lzr-qa.invalid`, then repeats it.

Use 16–128 printable ASCII characters for each; do not reuse a real password. Enter each prompt separately, not a multiline paste. Input is hidden for the **entire four-field session**, including transitions, hashing and file writes. Do not type a password at the shell prompt or supply it as a command argument/environment variable. Ctrl-C, mismatched confirmation, invalid input, timeout or a second provisioner refuses the attempt. Do not retry automatically.

The assistant must not inspect the Console during this private handoff. After the user finishes and returns control, inspect only the non-secret completion status. No password, hash, salt, cookie or connection setting belongs in chat, screenshots, logs, source or evidence artifacts. If the Console is not a genuine TTY or manual takeover is unavailable, **stop**: there is no echoing/direct-entry fallback.

The prompt hashes both passwords using the product's existing scrypt parameters and hexadecimal-string salt. It writes only four hash/salt fields to a fresh owner-only directory (`0700`) and exclusive verifier file (`0600`) in the container's `/tmp`. The waiter validates owner, mode, regular-file/link count, exact schema, current identity and time; consumes once; and deletes the verifier/commit files **before** calling the unchanged browser gate. Only non-secret one-use state markers remain. No verifier is written to a persistent volume.

## Actual login and acceptance

Only after the real PostgreSQL assertions and synthetic seed succeed, verify the QA app's HTTPS login page. The user supplies the corresponding password through the browser's **secure `browserAuth` credential request**, not chat or ordinary browser automation. No session is precreated; an HTTP launch, secure-form submission or generic health response is not successful login. Verify a signed-in UI for the selected role.

Run the real UI checklist in `recovery-browser-homologation.md`, including wrong-customer references, duplicate/repeated actions, persistence, exact Attendance target outside the newest 40, interruption/navigation, stale version conflict and read-only denial. Report each result as passed, failed or not run. No IXC/message transport is enabled and manual notes/promises are not financial receipts.

## Failure, expiry and limits

- A stopped/expired/consumed container handoff is not reusable. The bridge does not reset the database, regenerate passwords, repair a failed seed or retry deployments. Preserve the failure and verify whether any DB write happened before planning a new attempt.
- Private file checks reduce accidental reuse/link exposure; they are **not isolation from Railway account administrators, root or another trusted same-UID container process**. The existing authenticated Railway control plane is the access boundary. There is no anonymous setup route or additional setup-access credential.
- Mutable prompt/input buffers are cleared, but Node/runtime/platform memory and terminal transport do not provide a claim of guaranteed end-to-end secret zeroization. The helper never prints or persists plaintext. After a hard process/container crash, a hash-only temporary file can remain until that container is disposed of; do not copy it into evidence.
- The original browser entrypoint stops its child app at the approved deadline. Account unreachability then depends on app shutdown and removal of the QA resources; **there is no new per-user database expiry field**. The operational owner must confirm cleanup of only the approved test resources by the budget/deadline. Stopping the process alone is not a billing cap or volume deletion.
- Tests of fake TTYs/files and actual local PTY masking are separate from an authenticated Railway Console or real browser pass. Keep these evidence categories distinct.

## Local verification

```sh
node --experimental-strip-types --test tests/recovery-browser-console.test.mjs tests/recovery-browser-fixture.test.mjs tests/railway-recovery-gate.test.mjs tests/recovery-cases-db-gate.test.mjs tests/railway-marker-bootstrap.test.mjs
npm run typecheck
npm run lint
npm test
npm run test:staging
```

Use only explicit non-credential sentinel text for local PTY checks. Never run this provisioner against real users or use the existing general-purpose `create-user.mjs` recovery script for this test: that script prints a password and has different targeting semantics.
