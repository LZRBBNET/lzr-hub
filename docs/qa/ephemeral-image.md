# Isolated ephemeral image candidate

This package is a local test candidate, not a deployment approval. Run `node tests/manual/ephemeral-image.mjs --run` explicitly. It builds only a temporary allowlisted context, uses the explicit local Docker socket and task-owned client configuration, publishes no ports, and removes its containers, image tag, credentials and context afterward. Docker build cache may retain nonsecret source/dependency layers.

The build pins official Node 24 amd64 and PostgreSQL 17 digests and installs the lockfile with npm lifecycle scripts disabled. Reproducible here means a pinned recipe; bit-identical artifacts/images are not claimed without a recorded independent comparison. No host source, Node or dependencies are mounted into the tested runtime image. All build input paths reject symlinks and exclude environment files, Git, node_modules and work directories.

The entrypoint rejects Node preloads before invoking Node and launches with an empty environment plus fixed PATH/LANG. It refuses externally supplied database/client configuration. Origin is fixed to the local HTTPS test origin. Existing auth, Origin and closed-integration checks remain unchanged. The HTTP application binds loopback; making it externally reachable or selecting another origin requires a separate reviewed change.

Each start requires an empty root-owned `/run/lzr` tmpfs and creates a unique generation directory. PostgreSQL uses OS user999 and a random bootstrap credential whose file is removed before application startup. The application uses OS user10001 and a separate non-superuser database role without role/database creation, replication, bypass-RLS, schema creation or temporary-table permission. Its table/column grants are explicitly listed in `grants.mjs` for the prepared flows; unsupported features fail closed. Root-only operator material in tmpfs is not a public credential endpoint.

Prepared runtime tests will exercise authentication, Customer360, handoff ownership, promise pause, payment exclusion, forbidden DDL/admin reads/role escalation and OS file separation. An actual restart is expected to reset all synthetic data and reject the previous session. No customer messages or operational integrations are enabled. The inherited PostgreSQL image volume path is unused and explicitly shadowed by tmpfs in the harness so no anonymous data volume remains.

The harness requests 512 MiB/no-swap/0.1CPU. Visible cgroup metrics may represent an ancestor/shared scope; they are observations, not app-attributed memory or proof of Free-plan fitness. Functional success and resource viability must be reported separately. Host/browser TLS, Secure-cookie behavior, trusted remote proxy configuration and real hosting behavior are not validated by manual internal HTTP requests.

Remote operator delivery of fresh credentials remains unresolved for hosting without an authorized private console. Credentials must never be published through an anonymous endpoint or logs. This package does not deploy, provision paid resources, modify production or initialize an existing remote database.

## Current validation status (2026-11-15)

Shell entrypoint refusal and context exclusion/symlink tests passed locally. Prior prototype evidence hashes were confirmed, but that host-mounted prototype is not proof this image works.

The image build is blocked before any Dockerfile RUN/npm step: BuildKit cannot resolve/reach Docker Hub's anonymous-token endpoint through its configured daemon DNS. A minimal scratch build succeeded, isolating the issue to official-base metadata retrieval. No alternate DNS, privileged builder, daemon change, remote builder or deployment was attempted. Owned build contexts, temporary client configuration, containers and local image tag were verified removed.

Consequently image startup, application API tests, least-privilege negative tests, restart behavior and repeat-build comparison remain unexecuted for this candidate. The prepared tests are not passing evidence. There is no bit-identical-image or Free-plan viability claim. Resume the normal local build only after the environment's supported registry access works; preserve these scope limits.

## Prior prototype provenance (not image validation)

Before this work, the five archived prototype sources were checked against their recorded SHA256 values, and its cleanup record was confirmed true. Its base was `dc17b32af99d950fedac43f69afc862bc949df87`, tree `4fd1bc88147a47bd80d7c675c171aa7f506a03e2`. These hashes identify the earlier host-mounted functional prototype only.

- `run.mjs`: `8445ec2e670261f2aa76ccce4f03f296c2de2413e86ca75241f594d9a213a186`
- `inside.mjs`: `37d0010371238f2be0f44ab4b41bc75e07d994d5ff4db0b71793c24b87a20a07`
- `server.mjs`: `07aefa893fde58d2d137a355b7f6e7ad84c8f8cb0e0a8c34352c2d09af33227c`
- `env.mjs`: `218fc6c8d5e18f5d07e4f85201b079e06b52d9896e6aa8d1406ba30b17dba301`
- `build.mjs`: `46a2657b07e1619bc625a0675b82dd431c01f56072c83789b93e157fdf18fbcb`
