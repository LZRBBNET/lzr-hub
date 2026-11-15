# Local PostgreSQL 17 inspection reproduction

Run explicitly from this repository with the locked dependencies installed:

```sh
node --experimental-strip-types tests/manual/synthetic-inspection-pg17.mjs --run
```

This harness tests `inspectOperational` with the actual locked `pg` 8.22.0 driver and the unmodified inspection queries. It is not an end-to-end test of the worker, launcher, environment parsing, TLS, browser, or any remote service.

The only Docker endpoint is the local Unix socket. The official PostgreSQL 17 image is pinned to `sha256:99d1a998c76487d3abb48b141505bda5dcf8089c0c4cd7be40f75de314fa32f0`. It must already be present; the harness does not pull images. PostgreSQL has no network, no published ports, a read-only container filesystem, disposable tmpfs data, and a private host socket directory. Both the entrypoint's default socket and the host-facing private socket are enabled; SCRAM authentication remains enabled. Fixture setup is separate from read-only inspection connections. No production credentials or data are used.

Cases cover empty, reserved, and coherently completed initialization; extra schema, default privileges, bundled hstore extension, incomplete markers, and marker/journal mismatches. Assertions verify real driver types, read-only connection settings and rejected writes, identity pin rejection, expired deadline with zero queries, exact query-bundle hash, and four unchanged false capability fields. The configured statement/lock/idle timeouts are checked, but a slow-query timeout is not simulated.

Every run emits sanitized JSON only and saves `work/inspection-pg17-results.json`, including HEAD, tree and harness SHA256. Raw errors, passwords, database dumps and connection strings are never emitted. Cleanup checks the exact container name through a successful Docker listing, removes it and all private socket/credential files, and verifies absence separately. An interruption requests cleanup at the next bounded check; it is not immediate cancellation.

Initial local runs stopped during socket readiness, before any inspection cases. The official image entrypoint clears PGHOST for its setup psql commands; configuring only the custom socket prevented its setup connection. The corrected configuration preserves the default private socket as well as the custom private socket. See the run evidence for actual coverage and cleanup; configuration alone is not a passing test.
