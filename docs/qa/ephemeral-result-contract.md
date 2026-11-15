# Ephemeral validation result contract

Base: PR #93 (`27fc788df41417e78e94f39b3cc13cad43e5a4d3`). A dependency-free simulation of the actual image harness exit assignment reproduced exit 0 when its outcome was `pass:false`, `resourceGate:unverified`. No Docker command, build or database was needed for reproduction.

The image harness now reserves exit 1 for execution/interruption/cleanup failure and exit 2 for blocked validation. Exit 0 is unavailable while the mandatory resource gate is unproved. A closed final verdict is recorded after cleanup and persisted with evidence. Evidence-write failure remains an uncaught failure, not success.

The separate cached-PG host-mounted harness can still pass its narrower runtime checks. Its result explicitly identifies `scope:host-mounted-runtime-only`, `status:functional-only` (or `baseline-reproduced`), and keeps image/resource/Free validation false or unverified. This does not revise previous real-PG results into image validation.

Regression command:

`node --test tests/ephemeral-result-contract.test.mjs`

These tests evaluate the actual harness result statements with injected state. They do not run Docker, prove kernel signal delivery, validate resources, or exercise browser TLS. Publishing this source does not unblock deployment.

## Supervisor reproduction

A separate simulation of the supervisor source at base `27fc788` reproduced an application ignoring SIGTERM without any escalation timer or cleanup entry. It also reproduced initialization continuing after an early stop request and unclosed clients on admin, identity-query and grant-owner failures. Baseline sanitized evidence is retained at `/workspace/evidence/supervisor-lifecycle-review/results.json`; source SHA256 `e15f23e993d51252013239575ba67020e70476faff03c9ca2fc6850cf5821243`.

These are injected filesystem/process/database simulations, not a second PostgreSQL or image execution. Actual OS scheduling, kernel termination and runtime memory erasure are outside their evidence.

The supervisor change is cooperative between initialization phases: an already-running initializer may finish before the next stop checkpoint. It does not cancel arbitrary SQL mid-transaction or change rollback semantics. The application stop timer requests SIGKILL after three seconds; it does not prove a hard kernel termination deadline. If PostgreSQL status cannot confirm shutdown, generation data is retained and failure is reported; removing operator material does not constitute erasure of all process memory or retained database contents.
