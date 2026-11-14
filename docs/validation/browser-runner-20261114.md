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
