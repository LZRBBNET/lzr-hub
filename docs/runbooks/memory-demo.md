# LZR — isolated memory demonstration

This is a four-panel demonstration, not the original full operational interface. It uses entirely invented customer 10, invoice 901 and conversation `synthetic-demo-customer-10`. No IXC, WhatsApp, LLM, external queue, payment, database or provisioning is performed. Handoff context is a labelled seeded example; claiming ownership uses the actual shared conversation state service.

## Composition

One process-global Symbol holds a single promise for the composition: existing MemoryAuthRepository, MemoryPaymentPromiseRepository, MemoryCollectionRulesRepository, MemoryCollectionDispatchRepository, MemoryConversationStateRepository and MemoryConversationsRepository. The original synthetic provider supplies the invoice and Customer360Service supplies the customer view. There is no generic SQL interpreter or database emulator. The exclusive bundler substitutes db/index getDb/getPool imports with explicit throwing stubs; selected memory handlers never call them. It does not emulate SQL or return a fake database connection. Existing launchers remain unchanged.

The #100 fresh/complete/scoped invoice evidence validator is extracted unchanged into `payment-promise-evidence.ts` and used by both the original route and memory adapter. Unknown, stale, incomplete or contradictory evidence never fulfills a promise. The shared promise hold and collection services retain dates, business hours, reservation semantics and disabled queue behavior. A ledger entry is not a delivery receipt. Responses label `synthetic:true` and `delivered:false` on simulated operational actions.

API requests are serialized through a bounded queue (32 pending); creation rejects a second pending promise. Sessions are hashed/expiring and capped at 20, with expired entries removed. User activation and roles are rechecked by resolveSession on each request. Password change invalidates other sessions. Handoff audits retain the last 100 entries. This intentionally supports only one process; multiple replicas would have divergent memory and are unsupported. Restart clears users' changed passwords, sessions, promises, payment simulation and assignments. Initial passwords must remain available in the runtime secret configuration for restart; the server removes its own environment copies after bootstrap, but does not claim cryptographic memory erasure.

## Build and launch (not deployed)

Use the installed locked dependencies and supported Node 24. No package fetch, database build hook or migration is needed. The exclusive build command is `sh scripts/memory-demo-entry.sh build`, with `MEMORY_DEMO_ENABLED=true` and `MEMORY_DEMO_ORIGIN=https://your-approved-origin`. Build must not receive either password. It writes only `work/memory-demo/`, containing server.mjs, index.html, ui.js and manifest.json. This folder is an artifact, not a source of secrets.

Launch with `sh scripts/memory-demo-entry.sh start`. Supply:

- `MEMORY_DEMO_ENABLED=true` and exact HTTPS `MEMORY_DEMO_ORIGIN` (no trailing slash).
- `MEMORY_DEMO_PASSWORD` for `supervisor@example.invalid` and a distinct `MEMORY_DEMO_READER_PASSWORD` for `reader@example.invalid`: newly generated 24–256 character runtime-only secrets. Never put values in Git, HTML, build definitions, CLI arguments or logs. Deliver initial secrets privately to authorized testers through the hosting secret workflow; this change does not configure a host or distribute passwords.
- `PORT` in 1024–65535 and `MEMORY_DEMO_BIND=127.0.0.1` for local checks; `0.0.0.0` is the explicit default for a separately approved hosting deployment.

Both accounts must change their provisional password before business APIs. The read-only account cannot claim a conversation, register a promise or simulate payment. Startup refuses database/PG, IXC, queue and external service credentials, as well as preload environment flags. The shell rejects NODE_OPTIONS/NODE_EXTRA_CA_CERTS before invoking Node, resolves an absolute Node path from the trusted operator-managed runtime PATH, and executes it directly. It is not a defense against an operator controlling that binary or arbitrary loader arguments; use the reviewed entrypoint and trusted Node runtime.

The server requires exact Host. Browser writes require exact Origin; forwarded headers do not override either. Session cookies are Secure, HttpOnly, SameSite=Strict. Requests have a 16 KiB body limit, bounded timeouts and a closed method/path allowlist. Static scripts are local and CSP rejects external scripts and framing. Unknown modules/routes are unavailable rather than successful placeholders. No arbitrary dynamic import or user-supplied code executes.

The process-local egress defense blocks TCP connections, HTTP(S), fetch, DNS resolution, UDP creation, HTTP2 outbound connections and subprocess creation before application import. The sole DNS callback exception returns the configured literal listener address without a resolver. This is defense for the audited composition, not an OS sandbox for hostile code/native modules/worker threads. External hosting TLS and trusted ingress still need validation; local tests use HTTP with a declared HTTPS Origin and manually handled cookies, and do not prove browser Secure-cookie behavior.

## Verification and rollback

Directed checks: `node --experimental-strip-types --test tests/memory-demo.test.mjs tests/payment-promise-review-route.test.mjs tests/payment-promise.test.mjs tests/unified-promise-pause.test.mjs`; types and lint through their installed binaries. After build, `node tests/manual/memory-demo-api.mjs --run` starts only a loopback listener with fresh generated credentials, tests real HTTP API flows including restart, then terminates it. It uses no Docker, DB or external service. Evidence is sanitized under `/workspace/evidence/memory-demo-api/`.

Do not claim browser visual QA, TLS hosting, paid hosting capacity, live customer delivery or production readiness from these checks. To stop the demonstration, terminate its process; there is no persistent state to migrate. Restore the previously recorded original deployment command/configuration only under its deployment authorization. No merge or deployment is included in this branch.

### Hosting build separation (preparation only)

Some hosts supply configured secrets to both build and runtime environments. Do not assume a runtime-only secret feature. Keep the rejecting build guard: the prepared build child command is `env -u MEMORY_DEMO_PASSWORD -u MEMORY_DEMO_READER_PASSWORD sh scripts/memory-demo-entry.sh build`. This strips the two passwords from that child without printing them; it does not remove them from the hosting parent environment. The separately configured runtime start receives them. A clean hosted installation may use the existing locked `npm ci --ignore-scripts` before this build; no package installation or network access was executed for this local change. Node 24 and the trusted managed runtime PATH must be explicitly configured. Hosting, TLS, resource suitability and secret delivery remain unverified until separately authorized deployment testing.

### Jornada visual e ciclo de sessão

A interface dedicada reutiliza os tokens claros de `app/globals.css` e a organização
lateral dos módulos existentes. Cliente 360, contexto/assunção do atendimento e
promessa/pagamento formam uma jornada demonstrativa; dados ausentes continuam
indisponíveis. Não representa a implementação completa nem a interface GK.

A UI invalida respostas de gerações anteriores, limpa resultados ao sair/ocultar a
página e revalida a sessão ao retornar (inclusive pageshow/BFCache). Isso evita
reexibir resultados antigos, mas não desfaz mutações já enviadas nem um Set-Cookie
que o navegador tenha recebido. O servidor continua a autoridade da sessão.
Testes VM de DOM são regressões de comportamento, não validação visual/mobile ou
prova de BFCache real. Fazer QA em 320/360/390px, teclado e logout/voltar em navegador
suportado antes de aceitar a apresentação final. Credenciais do usuário não entram
nesses testes. Nenhuma mudança de guard, cache, banco ou transporte acompanha a UI.
