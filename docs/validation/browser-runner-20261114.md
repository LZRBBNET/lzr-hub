# Browser sandbox feasibility — 2026-11-14

Base: PR #79, `1ee16070a55498395c1e8c1c8962201b9f480d8f`.
The selected Cloud's failed Chromium launch is not repeated. No host ownership,
permissions, namespaces, AppArmor or kernel configuration is changed.

The [standard Ubuntu 24.04 runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
already includes Chrome and ChromeDriver. The
[official installation script](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/install-google-chrome.sh)
installs Google's package. We use the installed binaries through WebDriver HTTP
with Node built-ins: no new repository dependency, browser download or paid runner.

First gate: launch a fresh headless Chrome profile, inspect `chrome://sandbox`,
require PID/network namespaces and Seccomp-BPF enabled, quit the session and
remove its profile. No fallback flags disabling sandboxing. An unavailable
browser or inactive sandbox fails the job before dependency installation.

This gate is added to the existing single PR job, with a two-minute step limit
and existing 25-minute job/concurrency limits. No second workflow, manual trigger,
push trigger, artifact upload, cache, deployment or operational action is added.
The standard runner is free for this confirmed public repository.

Cloud checks: Node syntax, diff check and repository lint passed. Browser launch
is intentionally NOT attempted locally. Probe execution must be established on
the remote runner; static checks do not prove sandbox, UI acceptance or E2E.
Only after that gate succeeds should UI scenarios L01/L02/C03/C04/S01/S04 be
implemented against real application components with explicitly fictitious API
responses. No database, real account or external integration is part of the probe.

## Probe result and UI scope

The [remote probe run](https://github.com/LZRBBNET/lzr-hub/actions/runs/43540498322)
passed on `a3e8c1f1e1a3646326a66c50bbb818f0ded84370`. The browser gate asserts
active PID/network namespaces and Seccomp-BPF rather than inferring safety from
successful launch. It is repeated as a prerequisite for every UI run.

The UI harness bundles the real `LoginForm` and full `LzrHubApp` client using
the existing esbuild dependency. It serves the synthetic Node build's compiled
production CSS. It does not replace application components with lookalikes.
The test HTML mounts these components directly: this is NOT the production SSR
server, route handlers, authentication cookies, PostgreSQL or an E2E deployment.
Login and session are API doubles; a clearly fictitious localStorage marker is
not an authentication mechanism. No account or database is provisioned.

Server and WebDriver bind loopback. CSP denies real fetch connections; the
fixture intercepts only enumerated API requests and rejects unexpected ones.
Delayed fixtures intentionally ignore abort, testing stale-result rejection.
The initial test route after login is customers, excluding unrelated dashboard APIs.

Automated browser assertions cover:
- L01: valid/invalid fictitious login through the actual form and navigation.
- L02: width/overflow, field width, columns and keyboard Tab at 320/390/768/1440.
- C03: B remains after A completes late (desktop; narrow closes modal to select B).
- C04: close discards late detail; reopening starts a new read.
- S01: invalid initial admission while detail is pending redirects to login;
  the persisted marker proves response release before navigation, NOT completion
  of the old document's handler/render. This case does not prove that stronger claim.
- S04: logout 503 removes UI, retry succeeds; late detail cannot restore UI.

C03/C04/S01/S04 run at 1440 and 390 CSS pixels. This is a priority subset of
the matrix, not all its variants: no late JSON-body error matrix, payment-page
race, mid-session polling, cookie revocation or manual screenshot review.
No visual approval is claimed from geometry/DOM assertions. No screenshots or
artifacts are uploaded and no additional storage/cost mechanism is introduced.

Cloud `node --experimental-strip-types scripts/qa-ui.mjs --build-only` validates
fixture construction, JS bundle, compiled CSS and local HTTP serving without
launching Chromium. Two preparation failures were corrected before publication:
the fixture builder requires a readonly-shaped snapshot before setting the UI
demo label; esbuild's Unicode escaping made a literal accented string check
inappropriate. No production code was changed to satisfy the harness.

## Independent harness review

Read-only independent review of `8811450` identified three P2 test-reliability
issues despite its green CI: per-document error arrays lost evidence across
navigation; fixed waits/immediate checks could precede stale-response processing;
and shutdown could miss Chrome descendants or skip cleanup on SIGTERM.

The correction is limited to the harness:
- Error/rejection/CSP and unexpected-API evidence persists in sessionStorage
  across same-origin navigation and is checked cumulatively in every case.
- C03/C04/S04 explicitly await fixture delivery, two animation frames and a
  subsequent task before inspecting the DOM. This is a finite settling barrier,
  not a claim about arbitrarily delayed future work. S01 retains the narrower
  release-before-navigation claim above.
- Driver runs in its own process group. Graceful DELETE is bounded to 3 seconds;
  failure still terminates the owned group and removes its profile. Cleanup is
  idempotent, registered for SIGTERM/SIGINT, and server cleanup remains independent.
  Errors preserve the original failure; logs do not assert browser cleanup success
  if it failed. SIGKILL/host termination cannot run JavaScript cleanup and still
  relies on the ephemeral runner's teardown.

Four focused Node regression tests exercise persisted errors across documents,
the awaited release barrier, failed graceful shutdown/idempotence, and SIGTERM
cleanup with exit 143. These run without a browser in Cloud and before UI tests
in the existing CI step. No product, dependency, sandbox or extra scenario change.
