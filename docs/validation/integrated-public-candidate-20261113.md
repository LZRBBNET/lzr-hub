# Candidata local integrada — 2026-11-13

## Escopo e estado

Candidata LOCAL de Cliente 360, handoff IA→humano e régua fictícia com pausa por promessa/pagamento. Sem publicação, implantação, alteração de configuração, migração, contato ou acesso IXC. Checkout original preservado. Não é aprovação de produção: quatro arquivos de testes de renderização não carregam por dependência ausente.

Registro histórico da composição local. Evidências completas preservadas fora do repositório, sem link público. A atualização posterior está em [synthetic-minimal-candidate-20261113.md](synthetic-minimal-candidate-20261113.md).

## Composição rastreável

Base de produção pública: `57ad19b52cc99fb248005050f0b9d653aae2ec71`. União PR73+PR74 sobre o ancestral público `d93e58fda0c1935436e0a25f009b74eb75657df3`. Merge local `5e76aae` tem parents `b55185a` e `b124890`.

PR68 incorporado por cherry-pick com referência de origem dos commits públicos `0780d49`, `2607984`, `4532c74`. Dependências estritas de resumo/motivo/responsável e isolamento canal/conversa: `719252fdd8035cfbd797826119307566a6f33ddf` e `aabf4f4c0381be3be4e55c9fa4e1d354a6f56eec`, ambos ancestrais públicos do PR68. Esses deltas foram aplicados individualmente; a árvore inteira da base antiga não foi copiada.

O escopo limita-se às referências públicas listadas; PR71 e PR72 não foram incorporados. As mudanças de canal são exatamente as públicas do PR68: protocolo cooperativo/reserva/revalidação e sugestões; nenhuma ativação.

## Conflitos e revisão

Zero conflitos textuais no merge e nos cinco cherry-picks. Zero alterações locais de produto para resolver composição. Todos os 79 arquivos alterados frente à produção antes desta documentação e do teste novo têm blob idêntico a uma fonte pública abaixo.

Revisão de exposição: guardas de sessão PR70 preservadas, shell/readmissão exatamente PR74, fonte fresca/reautorização de cobrança exatamente PR73, locks/reserva/estado incerto/reconciliação/RBAC exatamente PR68. Rotas de canal, respostas e atendimento comparadas diretamente com PR68, sem delta. Histórico público de docs/harnesses mantido como proveniência, não como alegação de execução nesta tarefa.

Prova nova específica da composição: `tests/integrated-public-auth-boundary.test.mjs` liga handlers reais de clientes, dispatch e reconciliação ao guard real de sessão e RBAC final. Apenas persistência/autenticação armazenada é fictícia. Anônimo/expirado→401, indisponível→503, perfil sem permissão→403; zero fetch externo, sem vazamento do erro/token sintético. Quatro casos passaram.

## Validação executada aqui

| Prova | Resultado novo | Limite |
|---|---|---|
| Build verificado | PASS; artefato ESM/default.fetch validado | Não iniciou servidor/aplicativo |
| Typecheck | PASS | Dependências disponíveis do executor |
| Lint | PASS | Inclui teste novo na rodada final |
| Dirigidos — 31 arquivos | 412/412 PASS | Fontes, sessão, transportes e persistência fictícios |
| Agregado final | 1119 PASS; 4 arquivos FAIL no carregamento; 1123 entradas | Não é suíte totalmente verde |
| Auth da composição | 4/4 PASS, incluídos no agregado/dirigidos | Handlers in-process, memória |
| Render estático de Cliente 360 | PASS nos testes source-status | Não é QA visual/DOM interativo |
| Diff/check e proveniência | PASS; 79/79 arquivos públicos iguais | Igualdade de código não reproduz ambiente histórico |

Falhas reproduzidas exclusivamente por `ERR_MODULE_NOT_FOUND: react-test-renderer`, versão declarada no lock `19.2.6`:

- `tests/customer360-invoice-payments.test.mjs`
- `tests/customer360-selection.test.mjs`
- `tests/customer360-session-boundary.test.mjs`
- `tests/customer401-readmission.test.mjs`

Não houve instalação, download, substituição de renderer, remoção de asserts ou supressão desses arquivos na execução agregada. A rodada dirigida exclui explicitamente esses quatro bloqueados; sua lista foi preservada na evidência local não publicada. Pré-requisito concreto: disponibilizar a dependência já declarada `react-test-renderer@19.2.6` e suas dependências compatíveis por procedimento autorizado, então rodar esses testes e o agregado.

Comandos executados com ambiente vazio e PATH confiável (sem herdar segredo/URLs): `npm run build`, `npm run typecheck`, `npm run lint`, `node --experimental-strip-types --test tests/*.test.mjs`; dirigido usa lista explícita preservada. Node 24.22.1. Dependências já instaladas reaproveitadas por links locais; nenhum pacote instalado.

## Evidência herdada versus prova nova

| Fonte | Igualdade exata conferida | Evidência histórica (não executada aqui) |
|---|---|---|
| PR73 | Arquivos de cobrança/consumidor iguais ao SHA público | 9 cenários PG17.11 e 3 handler→PG→BullMQ descritos na evidência anterior; não reexecutados nem alegados como prova deste snapshot |
| PR74 | UI/readmissão e testes iguais ao SHA público | Resultado histórico 1035; quatro arquivos de renderer continuam bloqueados aqui |
| PR68 | Handoff/reserva/reconciliação/canais iguais ao SHA público | Ensaios PostgreSQL/browser descritos nos documentos públicos; não executados aqui |
| PR70 | Guard/rotas de auth iguais; shell final PR74 | Disponibilidade/logout herdados e testes sintéticos executados novamente aqui |

Não foi necessário iniciar PG/Redis para compor código sem mudança de persistência. Não houve PostgreSQL/BullMQ reais, navegador, QA visual, banco/fila existente, envio ou IXC. O Chromium conhecido bloqueado não foi iniciado.

## Limites e próximo passo

Candidata integrada útil, mas homologação incompleta pela falta do renderer e de QA visual. Testes de cobrança provam filtros de promessa e pagamento confirmado com fontes fictícias, inclusive consumidor; não demonstram atomicidade entre filtro e envio nem envio operacional. Janela após filtro permanece. Handoff mantém protocolo cooperativo e estado incerto; não promete cancelamento de envio já autorizado. Readmissão não adiciona detecção ociosa/cross-tab, polling ou replay. Uma página financeira não prova quitação nem ausência global.

Próximo passo mínimo: resolver somente o pré-requisito de renderer e completar os quatro arquivos/agregado; QA visual exige navegador oficial com sandbox funcional. Não implantar esta candidata a partir destes resultados.

## Matriz arquivo → fonte pública (igualdade de blob Git)

Refs:
- PR70: `d93e58fda0c1935436e0a25f009b74eb75657df3`
- PR73: `b55185a4e6b5c9b7997bc1f1b272bc49f51ddac0`
- PR74: `b1248908f3db0375ba45ca58d7bc61b7e9bc67b8`
- PR68: `4532c742028e2439bef4ef9f4c7c09cb647552a8`

| Arquivo | Fonte(s) pública(s) idêntica(s) | Blob |
|---|---|---|
| `CLAUDE.md` | PR68 | `4b45f38cf8dc5f228cbbb96bdc98777ee76ce094` |
| `app/api/auth/logout/route.ts` | PR70, PR73, PR74 | `3667b7dae00c0fc7bf61a874296a743740940f7c` |
| `app/api/auth/me/route.ts` | PR70, PR73, PR74 | `f8761abdc790043562a9d03433923949cb0c515e` |
| `app/api/billing/collections/dispatch/route.ts` | PR73 | `329da927d5eb365c571bee3ca98ac83c72bd20ac` |
| `app/api/channels/meta/route.ts` | PR68 | `83cdd58d5f3741a7606026bc24767e13acbd967d` |
| `app/api/channels/n8n/route.ts` | PR68 | `4ddccd36138368786ea081bbaebf98c3a967bdfb` |
| `app/api/conversations/reconcile/route.ts` | PR68 | `aaf3a23cd37620db7516518d8f8bb0da1ee4aa16` |
| `app/api/conversations/reply/route.ts` | PR68 | `915128fc818faebf0f58916425e06b18a7edfb68` |
| `app/api/conversations/route.ts` | PR68 | `7c75dddde4096e78b42d1b9450f7efa87a5d65ee` |
| `app/api/conversations/state/route.ts` | PR68 | `7cd5495591231f30d2b5a3eb303840c94badd4ec` |
| `app/api/copilot/route.ts` | PR68 | `7e4bcb9bb187b89c63a4e62de29bf6fd214525ca` |
| `app/globals.css` | PR70, PR73, PR74 | `fffb8136e59cde69fa4a5141dbd37881a87e8062` |
| `components/invoice-payment-pages.tsx` | PR74 | `29cf96523c4058ba508219c903ef43a93fc9a601` |
| `components/lzr-hub-app.tsx` | PR74 | `bad50c51eaf8a36ca420027e4e78c861142d81f5` |
| `components/modules/attendance.tsx` | PR68 | `a795173e2170513d405f963fd67a3696eae74218` |
| `components/modules/customer360.tsx` | PR74 | `fbaaef7480220dc41d49ec086c012ace4c7d3d6b` |
| `components/modules/delivery-reconciliation.tsx` | PR68 | `581792e984f08095fba5f9c7b7a9a2a7b80fbe5c` |
| `components/modules/labels.ts` | PR68 | `156be17f61f57990ae1749c7062cd4cc4958a1cf` |
| `db/index.ts` | PR70, PR73, PR74 | `401746b7fea8cdeae5b5cd9542aa41443f1f827f` |
| `docs/validation/conversation-channel-scope-20261105.md` | PR68 | `435b78408f2ffa349c17efcc1ff814c0da0eb14a` |
| `docs/validation/handoff-composer-permission-20261106.md` | PR68 | `6c76e478f129c7f988fcd81c74d4a4c39264e0d4` |
| `docs/validation/handoff-delivery-pr-20261106.json` | PR68 | `044c2415ce2395830cbe9e87962920fa88b1f7b7` |
| `docs/validation/handoff-delivery-pr-20261106.md` | PR68 | `e5823a354897ca99b71877958ec9394feaad9891` |
| `docs/validation/handoff-reconciliation-code-only-20261106.md` | PR68 | `0957542fc3a2ac8c2b3cd344aa2f37f290c79b0a` |
| `docs/validation/handoff-summary-20261105.md` | PR68 | `5339213c308f319d2bebffa27089a98328b4ecf5` |
| `lib/integrations/ixc/readonly-provider.ts` | PR73 | `def12bf555b0c5ed17c4d4df637b69aef716fc15` |
| `lib/platform/attendant-reply-service.ts` | PR68 | `8a64ca414eeb23c35f7369d4d1ee44da180ef671` |
| `lib/platform/billing-amount.ts` | PR73 | `1a03bcac9f1e9717761077b0ab5864b49f2dcfbe` |
| `lib/platform/billing-service.ts` | PR73 | `9b69d6353d9ecdca53f5fbe80555b1bdf1938792` |
| `lib/platform/collection-dispatch-service.ts` | PR73 | `d6b06920541a82c081eb89871b7584126fa93c8a` |
| `lib/platform/collection-dispatch-source.ts` | PR73 | `e8ca264d3662e3d2ffbf8d04b62749435d9bba39` |
| `lib/platform/conversation-delivery-lock.ts` | PR68 | `7c15f6db885c92bb2fa600f6b3098ed02ada0915` |
| `lib/platform/conversation-delivery-service.ts` | PR68 | `fa85ff1f4b03580896f8c90dc83e5f5f90dac19f` |
| `lib/platform/conversation-state-service.ts` | PR68 | `1ec56bc8f7260c8b4bcb2e13f70068a2ab24b2b2` |
| `lib/platform/conversations-service.ts` | PR68 | `cd8d8a9acc163bdb1933602ee3fc0155d5a27992` |
| `lib/platform/copilot-service.ts` | PR68 | `1e902f41a10eb35e5af2ed1534ca047d7d68e72a` |
| `lib/platform/copilot-summary-service.ts` | PR68 | `38d33703862b853624e6d79598ee08901a1d4262` |
| `lib/platform/customer-session-admission.ts` | PR74 | `3f402fd9671305b45fbbd82c76744c6a6c9bdd7a` |
| `lib/platform/delivery-reconciliation-service.ts` | PR68 | `1b67d6f3875f5b2d9eee15e76352d551b6832758` |
| `lib/platform/meta-auto-reply-service.ts` | PR68 | `666f2840b4f3c4c08c9ce768e3656d306725f4f4` |
| `lib/platform/rbac.ts` | PR68 | `fcc608e024a6ceb10037942b8fb34058ec693009` |
| `lib/platform/session-guard.ts` | PR70, PR73, PR74 | `65c70d26f8f6552d1320a95fc2084e2938a3f534` |
| `lib/platform/teams-shared.ts` | PR68 | `e18caea810a1391afe81da8f313d727d4fcb8558` |
| `services/queue-runtime/src/billing-reminders.mjs` | PR73 | `acf186382be19f97fd83376cca3b61b4d277fc1d` |
| `services/queue-runtime/src/processor.mjs` | PR73 | `c0b5e67eb95a0c0c92cd0547ece110b970208b24` |
| `services/queue-runtime/src/promise-hold.mjs` | PR73 | `c4d9d4175783bc6dd1e577733c26c921ddc9d33f` |
| `tests/attendant-reply.test.mjs` | PR68 | `6339dfd4bf883d62844208762e62b6be0f04975e` |
| `tests/auth-me-unavailable.test.mjs` | PR74 | `b43e8a500f5fb5319343843c3c8301d1c14c1903` |
| `tests/billing-aging-civil-date.test.mjs` | PR73 | `a5b94ca5bb275733e47e176148ec3a73e1726848` |
| `tests/billing-overdue-summary.test.mjs` | PR73 | `15fd30ebfaa8df576aabb9c336a2a1ba3b31c491` |
| `tests/collection-dispatch-route.test.mjs` | PR73 | `c95f077ade229712986011528d640219194c7c2f` |
| `tests/collection-dispatch-source.test.mjs` | PR73 | `13768cf64ee62c9c5ab66c66d548763cac30162a` |
| `tests/conversation-channel-scope.test.mjs` | PR68 | `3264b4ab6d81146c86423b714c410dbc7649ff7d` |
| `tests/conversation-composer-permission.test.mjs` | PR68 | `8d4aef6b817d54389bd1e662903f57e6e19511ba` |
| `tests/conversation-state.test.mjs` | PR68 | `9d0f239cfe4f86459fa1497a09178dd5473db178` |
| `tests/copilot-summary-service.test.mjs` | PR68 | `ea6340dd9e3b4a8d0c8d428768433ac4afa2d062` |
| `tests/copilot.test.mjs` | PR68 | `686b736f386f528ed7efccb956dc2b58e773cc9d` |
| `tests/customer-session-admission.test.mjs` | PR74 | `839b2954b1ccf56ca5b2ce1bca0cadc7f0b67e66` |
| `tests/customer360-selection.test.mjs` | PR74 | `748c3f5f58a46fb68dccfcb0bbc8dcbc481dad35` |
| `tests/customer360-session-boundary.test.mjs` | PR74 | `b9a62501bc79f98a5450f5a5fa251a653a6615a3` |
| `tests/customer360-source-status.test.mjs` | PR74 | `6d07c45eaf65475b30c387080c2e35d42bf7e481` |
| `tests/customer401-readmission.test.mjs` | PR74 | `d6d0d41e0f6349af786f99907efe1b39373807d8` |
| `tests/delivery-reconciliation.test.mjs` | PR68 | `065d6ec542311d9814d6d7bf28b9834b2f12d02a` |
| `tests/handoff-flow.test.mjs` | PR68 | `b4ab672ba406f1705f30a53df2eef899d46e8c6a` |
| `tests/handoff-summary.test.mjs` | PR68 | `d9bc388c5303fdea58afecb8acf17f037baa8c33` |
| `tests/logout-unavailable.test.mjs` | PR74 | `d4af52a45c4f82078d4a4042e2f63a5cb4885bce` |
| `tests/manual/auth-me-browser-postgres.mjs` | PR70, PR73, PR74 | `869d9c50085c4f46f0b60b3cac63e5abd9f06dac` |
| `tests/manual/auth-me-browser.mjs` | PR70, PR73, PR74 | `2480c5ef989a212078f7d63b5ad762dfd1c702b4` |
| `tests/manual/auth-only-pool-http.mjs` | PR70, PR73, PR74 | `295ed5eb9366836804683bd7e8ca5faedc7e1b91` |
| `tests/manual/handoff-browser.mjs` | PR68 | `c5711c05340c855f4e2c87b106f959fb1a0dfee1` |
| `tests/manual/handoff-postgres.mjs` | PR68 | `ed8451a26bffc28d47e4d98e546eb3ad1aece87b` |
| `tests/manual/human-delivery-postgres.mjs` | PR68 | `9e52ef60b40022c36f3e41fbcbeae9600f5fb762` |
| `tests/manual/logout-browser-postgres.mjs` | PR70, PR73, PR74 | `94dc64dac2bd87f3a5fa629e0ab6664b7aa997b3` |
| `tests/manual/logout-browser.mjs` | PR70, PR73, PR74 | `960f88e2f0fce39efa6aac54933cb22322a1bbcb` |
| `tests/manual/reconciliation-postgres.mjs` | PR68 | `3b877317f54dec3e74809aeb60073f2213d57251` |
| `tests/manual/reconciliation-revocation.mjs` | PR68 | `617608446ed30bfba1409217b9e8ed9261bd5e66` |
| `tests/meta-auto-reply.test.mjs` | PR68 | `c0bd79f4eef85aaa93ccf10a93b5c43f8084078e` |
| `tests/session-diagnostics.test.mjs` | PR70, PR73, PR74 | `dfba7c818e6772f678ec5f0b4e78a639e8ad738c` |
| `tests/unified-promise-pause.test.mjs` | PR73 | `6eec455cf4943d5377483c5554cda66a71d51a96` |

Adições locais de validação, sem código de produto: este relatório e `tests/integrated-public-auth-boundary.test.mjs`. A matriz JSON completa está preservada junto às evidências locais.
