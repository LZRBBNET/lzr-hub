# Authenticated browser gate — synthetic Railway installation

This is a **test-only runner**, not a product feature or production startup. It uses the real built app, real login/RBAC/session cookies, and real PostgreSQL; the ERP HTTP responses are explicitly synthetic. It proves no real payment, recovery amount, cancellation prevention, customer contact, or real IXC compatibility.

## Exact order (one execution, no reset)

1. Verify the approved empty environment and DB through Railway control-plane IDs. Follow `railway-recovery-gate.md`: exact test service hostname, nonce DB name, private network, production denylist, <=24h approval and <=USD5 budget. Approval/metadata are not a cryptographic boundary or a spending cap.
2. Provision the DB comment marker separately. Provision two temporary test passwords through an approved private channel, and supply their **scrypt64 hashes and 16-byte hex salts**, compatible with `lib/platform/auth.ts`. Never reuse a real account password; never place passwords/hashes/DB URLs in source, CLI arguments, screenshots, or public logs. This runner does not generate credentials. Keep both passwords available privately to the browser operator.
3. Build the **exact reviewed commit**, clean of actual dotenv files, with the existing safe staging build. Configure Railway's dedicated test service startup to the command below, **not** `npm start`, and disable automatic restart/redeploy retries. The normal startup migrates automatically and is deliberately not used.
4. Start this runner on the **still-empty** DB. Do **not** run the standalone DB gate first: this runner calls it unchanged in the same invocation, then seeds only after its actual assertions pass. A restart against the migrated DB refuses rather than resetting it. Inspect a failure; do not delete or retry blindly.
5. Only after the real PostgreSQL PASS logs and synthetic seed PASS, verify app HTTP/login and perform the browser checklist below. An app process launch is not browser success.

If the approved provisioner has no SQL editor, the separate marker-only bootstrap is available **after** control-plane verification. On the same exact reviewed SHA, set the separate acknowledgement below through private runtime configuration, temporarily use its one-shot startup command, and confirm its marker-only PASS. It refuses any existing marker or nonempty DB; it does not migrate or seed:

```text
RECOVERY_CASE_RAILWAY_ALLOW_MARKER_BOOTSTRAP=verified-empty:<environmentId>:<databaseServiceId>:<databaseVolumeId>:<nonce>
```

```sh
node --experimental-strip-types scripts/bootstrap-recovery-railway-marker.mjs
```

Then remove `RECOVERY_CASE_RAILWAY_ALLOW_MARKER_BOOTSTRAP` and switch startup to the browser entrypoint below, retaining the same approved SHA. The DB is still empty but marked. Never run the standalone migration gate between these two commands.

```sh
node --experimental-strip-types scripts/start-recovery-browser-railway.mjs
```

Required inputs, in addition to **all unchanged** Railway gate manifest/runtime/test-URL/migration-ACK inputs:

| Variable | Required value |
| --- | --- |
| `PORT` | Dedicated test app port, integer1024–65535 |
| `RECOVERY_BROWSER_ALLOW_SYNTHETIC_SEED` | Exact `environmentId:databaseServiceId:nonce` |
| `RECOVERY_BROWSER_OPERATOR_PASSWORD_HASH` | Provisioner-supplied128 lowercase hex characters |
| `RECOVERY_BROWSER_OPERATOR_PASSWORD_SALT` | Provisioner-supplied32 lowercase hex characters |
| `RECOVERY_BROWSER_READER_PASSWORD_HASH` | Different test-only128 hex hash |
| `RECOVERY_BROWSER_READER_PASSWORD_SALT` | Different32 hex salt |

Do **not** set `FEATURE_AUTH=true`, `DATABASE_URL`, real IXC settings, operational tokens or `PG*` on the outer gate process. The gate retains its strict refusal. After PASS, the child app environment is constructed from scratch with auth on, a DB URL pinned to the verified private IP, and synthetic IXC at `http://127.0.0.1:<ephemeral port>` in the same service. All outbound sending, IXC writes, LLM and scheduled sync flags are false. `FEATURE_IXC_FULL_BASE=true` is confined to this non-proxy fixture's two customers so the ordinary overdue queue queries can run.

The fixture binds only127.0.0.1, accepts only known read/list resources and queries, and performs no network requests. Its fixed token is a non-secret discriminator, not an IXC credential. No application route or authentication bypass is added. The fixture and seed are not imported by product code. Product logging is not forwarded by the test runner to avoid accidentally exposing driver/request secrets; failures are reported generically.

The expiry timer stops the child app and fixture; **it does not stop Railway billing or delete infrastructure**. The owner must monitor cost and remove only the reviewed temporary app/DB/volume/environment by the approved deadline. Never include production resources in cleanup. No auto-reset or auto-cleanup exists in this runner.

## Known readiness distinction

`/api/health` describes the older disabled-IXC demo and reports `degraded` for this intentional synthetic `staging-readonly` configuration. Do not change product health to hide this, and do not count HTTP200 health as a successful browser gate. Verify login page, unauthorized APIs, session login, authenticated API responses, UI and PostgreSQL persistence. Every customer/account/seed message is labeled **SINTÉTICO**; source labels such as “IXC somente leitura” refer to the existing protocol path, not a real ERP in this test.

## Synthetic fixture map

- Login accounts: `operator@lzr-qa.invalid` (Cobrança) and `reader@lzr-qa.invalid` (Somente leitura). Passwords are provisioned privately, never fixed in source.
- Customers910001 and910002; invalid documents and DDD00 telephone identifiers cannot be used for real customer outreach.
- Customer910001 has two contracts with different statuses and21 invoices. `940021` is open but outside Customer360's first20. `940001` is received, `940002` cancelled, `940003` unknown, `940004` open but not yet due. Invoice950001 belongs to910002.
- Linked Attendance for910001: protocol20261027000001, conversation5500000910001. Other-customer protocol20261027000002 belongs to910002.
- Forty newer unrelated synthetic conversations put both legitimate targets outside the default newest40 inbox rows. A case handoff must fetch the exact target; silently selecting the first row fails this gate.
- `qa-promise-received` starts pending as synthetic historical data against invoice940001. No case or session is seeded: the browser must genuinely log in and create the case. DB gate records remain in a separate scope.

## Browser acceptance (record exact commit, URL, times and outcomes)

Use the approved **test URL only**. Capture screenshots without passwords, cookies, hashes or connection settings. Record browser-console/API errors and whether each step passed, failed, or was not run.

1. **Authentication:** fresh browser sees login; `GET /api/billing/recovery/cases` is401 without a session. Wrong login fails generically. Log in as operator through the actual login form; a real session enables recovery. Confirm no real customer records.
2. **Truthful customer read:** open910001. Registration is distinct from the two contract statuses; no arbitrary contract is presented as the only contract. Show20/21 invoice coverage and partial finance; future940004 is not overdue. No complete balance or real receipt claim.
3. **Persistence and repetitions:** in Cobrança → Recuperação → Casos acompanhados, open910001. Repeat/double-click must not create a second active case. Claim ownership, set a future return, add a synthetic manual note; reload page and reopen case, confirm values and actor/history persisted. Close/Cancel modals and Back/Forward must not silently submit/replay.
4. **Safe references:** link940021 (outside20) successfully. Reject950001 for910001 and nonexistent invoice999999 without event/version change. Create a new promise using the actual UI for940021; reject received940001, cancelled940002, unknown940003 and wrong-customer950001. Verify pending promise is not represented as money received.
5. **Reconciliation:** review promises explicitly. Only the synthetic seeded R-status promise becomes fulfilled; pending newly-created open invoice promise remains pending. This is test protocol behavior, not proof of a real payment or financial lift. Case history still says receipt not confirmed.
6. **Attendance safety:** link protocol20261027000001, reject20261027000002 and a nonexistent protocol. Navigate via case link while target is outside the first40. Confirm exact conversation5500000910001 and customer910001, never a newer unrelated row; Back/Forward and repeated links must preserve intended target. Sending UI must remain unavailable.
7. **Concurrency/version:** with the operator session in two tabs, load one version in both; mutate one, then submit stale change in the other. Expect409/reload guidance and no stale overwrite/phantom history. Verify same-key retry result through authenticated browser request if deliberately testing transport uncertainty; never label a pending response as success.
8. **Close/reopen:** close with a clearly manual reason, reopen, confirm unique active case. A second active case blocks reopening the first. Closure is not a verified payment or saved cancellation.
9. **Read-only role:** log out, confirm prior session no longer grants access. Log in as reader: list/detail/history readable, no write controls; direct authenticated POST is403, with no event/version change. Logout returns to the login boundary.

Cross-operator ownership transfer remains covered by existing offline service tests, not the real-DB gate or this two-role browser fixture (only one writable operator). Screen-size coverage, browser transport interruption and extra scenarios must be reported separately if not exercised.

## Local evidence vs unrun stages

`tests/recovery-browser-fixture.test.mjs` uses the real readonly provider with an in-process Response fixture; it tests wire-shape/filter/snapshot/point-lookup behavior without opening sockets. Pure seed and environment tests do not substitute for PostgreSQL integration or a browser.

```sh
node --experimental-strip-types --test tests/recovery-browser-fixture.test.mjs tests/railway-recovery-gate.test.mjs tests/recovery-cases-db-gate.test.mjs
```

At preparation time: local focused tests pass; actual Railway DB execution, credential provisioning and authenticated browser results are **not yet run**. Keep that distinction until recorded evidence exists.
