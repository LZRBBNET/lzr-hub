# Recorte local mínimo de homologação sintética — 2026-11-13

## Estado

Candidata baseada em e4cd163ed6558c3ef89f9ce670aaed2bb4d4b94d (árvore de5a383a53e0b558b53bdcb45a353dc63d14ffd9). Base preservada sem alterações. Sem push, PR, merge remoto, deploy, configuração remota, conta, credencial real ou seed remoto.

É a aplicação real/rotas/serviços/React da candidata com fonte fictícia opt-in e explícita. Não é integração IXC nem envio operacional. Os modos existentes continuam desativados por padrão. Não se importou a árvore antiga inteira ou qualquer delta de cidade/piloto/regras comerciais paralelas.

## Recorte e composição manual

Fontes públicas: Render cc90642ae48f412811f719091f765ece7a35ca23 (árvore e838e3db5b8c3981d8f7880a86dd53731d34210d); PR62 718d4336947888f409b8e8b8ec36f86cd6115eb8 (árvore fd9fe4931fa7492cea349a085ae9757a4c2c4c96), só seus módulos/página/testes necessários. Matriz abaixo distingue igualdade exata de adaptação.

- Fonte sintética reutiliza provider atual, sem substituir readonly-provider, mappers ou ownership. Runtime escolhe-a somente por opt-in validado. Recusa adicional de IXC_DIRECT_AUTHORIZATION e endpoints conhecidos; não herda binding real nos testes.
- Fábrica/Customer360 expõem registros fictícios, cobertura e indisponibilidade sem dizer IXC real. `customer.tags`, fontes e pagamentos recebem origem explícita. UI aceita somente o modo esperado e remonta estado quando origem muda; seleção, abort/generation e readmissão PR74 permanecem.
- Proxy público + PR62 usa sessionState atual: indisponibilidade503, inválida401/redirect, Origin exata e sem acesso implícito. Projeção pública de mustChangePassword incorporada sem substituir auth/me/logout nem apagar indisponibilidade. Restrição provisória no authorize somente no modo web sintético.
- Launcher Node copia fontes explícitas, não dotenv/Git/hosting; acrescido somente `services/queue-runtime/src/promise-hold.mjs`, dependência pura da cobrança PR73. Primeiro build reproduziu ausência desse arquivo e foi corrigido sem importar serviço de filas inteiro.
- Guarda local de aplicação instalada no start antes do servidor: bloqueia fetch/http(s) e Socket.connect fora do hostname/porta do DB declarado. Não é firewall universal, não controla código nativo/UDP/processos maliciosos. Não muda proxy/política/sandbox. Ambiente remoto e alvo de DB continuam precisando de validação autorizada.
- Inicializador/controller/status/manifesto e browser setup reutilizados; uma admissão/escrita, cookie seguro, prazo, tentativa/alvo/processo e status RO sem replay. Nada é executado em startup/build. Nenhum novo fluxo de primeiro acesso ou terminal para o titular.
- `work` foi excluído de Git/lint/types por ser artefato gerado. Testes PR62 receberam flags fictícias explícitas que sua base antiga fornecia: não relaxamos o gate. Uma assertion de texto foi adaptada à linguagem mais estrita de cobertura PR74; assertions de origem/tag foram acrescentadas.

## Validação nova neste executor

- Agregado final: 1231/1231, zero falhas/skips; inclui os 1176 da candidata base, sem excluir arquivos.
- Dirigidos novos: 50/50 (inicialização/controller/status/286 cenários de falha no Simulator, browser VM, fonte/render/origem/egress) + 5/5 origem de pagamentos. Contagens sobrepostas ao agregado.
- Build legado verificado e artefato ESM/default.fetch: PASS.
- Build Node isolado: PASS. Nenhum npm start/migração; sem conexão DB no build.
- Pós-build: 3/3 — artefato Node, primeiro acesso do PR62 e launcher real em processo. Login e página de primeiro acesso200, negócio anônimo401, Origin incorreta403. Servidor loopback descartável, cliente HTTP local, sem browser/DB/conta. Guard egress ativo no processo real.
- Typecheck, lint e diff-check: PASS. Correção de lint somente variável local no teste.
- Nenhum PostgreSQL/binário ou imagem Docker local disponível. Não se baixou imagem nem iniciou DB/Redis. SQL/journal permanecem iguais aos20 arquivos do manifesto; Simulator não é PostgreSQL.
- Pacotes exatos já instalados reutilizados; nenhuma instalação adicional neste turno. Comandos de teste/build executados com env enumerado vazio de credenciais reais. Nenhuma chamada IXC, n8n, Meta ou envio real.

Logs completos preservados fora do repositório; não há link público para esses artefatos. Evidências de falhas iniciais preservadas: fixtures browser sem flags, agregado antes do build legado, build Node sem promise-hold e lint de variável do teste; todas corrigidas/reexecutadas sem remover testes/asserts. Renderizadores e VM não são QA visual.

## Revisão independente

Revisão independente realizada somente por leitura, sem executar testes. Encontrou duas lacunas de rotulagem: pagamentos em demo ainda declaravam modo IXC e customer.tags do detalhe ainda dizia IXC. Ambas corrigidas com testes. Revisou preservação 503/logout/readmissão, RBAC/ownership e guardas billing/handoff, primeiro acesso single-write/no-replay e o smoke real do launcher. Não identificou bloqueio de código remanescente; Naquela etapa, DB/login autenticado/browser/isolamento remoto permaneciam pendentes; veja a atualização abaixo.

Revisão React: hooks/abort/generation preservados; chave inclui origem para descartar respostas antigas; componentes não importam módulos de servidor; estados/avisos permanecem acessíveis e sem requests automáticos adicionais. Sem refatoração visual ampla.

## Preservação/regressões e recursos

Autenticação/logout, shell/readmissão, cobrança fresca, consumidor, locks/reserva/reconciliação e RBAC não foram substituídos por versões antigas. Arquivos centrais não tocados conferidos contra e4cd163; mudanças manuais estão explícitas na matriz. A suíte inteira da base foi executada no recorte. Esse resultado não prova atomicidade do envio nem fecha janela após filtro.

Processo filho do smoke encerrado e aguardado; servidor/socket local do teste de egress fechado e guard restaurado. Nenhum container, banco, fila, conta ou perfil de browser criado. Mantidos somente worktree, dependências locais por links, artefatos de build próprios e evidências para reprodução. Nenhum processo de aplicação deixado rodando. Candidata base e checkout original preservados.

## Requisitos antes de publicar/validar acesso

1. Aprovar explicitamente o SHA exato deste recorte e a publicação/deploy no serviço sintético existente; autodeploy/autoSync permanecem desligados. Não usar deploy latest da branch antiga.
2. Revisar ambiente mínimo sintético e origem HTTPS canônica, flags de integrações/filas/LLM false e nenhum segredo/endpoint real. DB separado/descartável, conexão privada, schema/estado anterior e ausência de escrita incerta precisam de conferência autorizada. Não inferir conta existente de status available. O guard do inicializador conserva conexão privada ssl=false explícita; isso não prova TLS de DB nem autoriza trocar para alvo externo.
3. Build `node --experimental-strip-types scripts/synthetic-web.mjs build`; start exclusivamente `node --experimental-strip-types scripts/synthetic-web.mjs start`, mesma raiz de projeto/artefato, uma instância. Nunca npm start. PORT1024–65535; ambiente conforme contrato assertSyntheticWeb e banco validado; init e browser setup desativados inicialmente. Check/build não criam schema/contas.
4. Aprovação separada do primeiro acesso pelo fluxo PR62. Titular abre página HTTPS confiável, gera chave só na memória da aba e fornece apenas verificador público/expiração/tentativa pelo canal autenticado. Só então, numa janela autorizada, configurar verificador/prazo/host/flags, confirmar alvo/ausência e permitir que escolha senha na própria página. Nenhuma senha pelo chat/terminal.
5. Escrita única; erro/incerteza permite apenas status RO. Sem apagar reserva, reenviar POST, estender sessão ou inventar sucesso. Fechar/revogar janela antes do login e troca da senha provisória.
6. Validar HTTPS/Set-Cookie, Origin, login autenticado, revogação/readmissão, política sem logs de corpos/headers e os três percursos com banco sintético. Usar navegador com sandbox funcional. A prova PostgreSQL local posterior não substitui validação HTTPS/browser no serviço publicado.

Limites visíveis: pagamento fictício em memória reinicia com processo e pode divergir de promessas persistidas; não resetar silenciosamente. Há endpoint de simulação, não foi adicionado botão comercial novo. Filas e resposta externa permanecem desativadas; dispatch não deve ser apresentado como envio operacional. Uma página não prova quitação/ausência global, nem este laboratório é prontidão de produção.

## Proveniência arquivo a arquivo

`exato` compara bytes com a referência indicada; `adaptado/local` exige o delta manual acima. IDs abreviados nesta tabela resolvem aos SHAs completos no início.

| Arquivo | Fonte | Estado |
|---|---|---|
| `.gitignore` | local: teste/guarda/artefato | adaptado/local |
| `app/api/customers/payments/route.ts` | e4cd163 + composição local | adaptado/local |
| `app/api/demo/browser-setup/route.ts` | PR62 718d433 | exato |
| `app/api/demo/initialize/route.ts` | cc90642 | exato |
| `app/api/demo/invoices/route.ts` | cc90642 | exato |
| `app/first-access/route.ts` | PR62 718d433 | exato |
| `components/invoice-payment-pages.tsx` | e4cd163 + composição local | adaptado/local |
| `components/modules/customer360.tsx` | e4cd163 + composição local | adaptado/local |
| `docs/runbooks/browser-first-access-private-20261106.md` | PR62 718d433 | exato |
| `eslint.config.mjs` | local: teste/guarda/artefato | adaptado/local |
| `lib/integrations/ixc/runtime.ts` | e4cd163 + cc90642 | adaptado/local |
| `lib/integrations/ixc/synthetic-demo.ts` | cc90642 | adaptado/local |
| `lib/platform/auth.ts` | e4cd163 + cc90642 | adaptado/local |
| `lib/platform/browser-initialization.ts` | PR62 718d433 | exato |
| `lib/platform/customer360-factory.ts` | cc90642 | adaptado/local |
| `lib/platform/session-guard.ts` | e4cd163 + composição local | adaptado/local |
| `lib/platform/synthetic-handoff-fixture.ts` | cc90642 | exato |
| `lib/platform/synthetic-initialization-access.ts` | cc90642 | exato |
| `lib/platform/synthetic-initialization-controller.ts` | cc90642 | exato |
| `lib/platform/synthetic-initialization-status.ts` | cc90642 | exato |
| `lib/platform/synthetic-initialization-target.ts` | cc90642 | exato |
| `lib/platform/synthetic-initialization.ts` | cc90642 | exato |
| `lib/platform/synthetic-schema-manifest.json` | cc90642 | exato |
| `lib/platform/types.ts` | e4cd163 + cc90642 | adaptado/local |
| `lib/runtime/synthetic-egress.mjs` | local: teste/guarda/artefato | adaptado/local |
| `lib/runtime/synthetic-web.ts` | cc90642 | exato |
| `proxy.ts` | PR62 718d433 | adaptado/local |
| `public/first-access/browser.js` | PR62 718d433 | exato |
| `scripts/prepare-synthetic-initialization.mjs` | cc90642 | exato |
| `scripts/synthetic-web.mjs` | cc90642 | adaptado/local |
| `tests/browser-first-access-artifact.mjs` | PR62 718d433 | adaptado/local |
| `tests/browser-first-access-client.test.mjs` | PR62 718d433 | exato |
| `tests/browser-initialization.test.mjs` | PR62 718d433 | adaptado/local |
| `tests/customer360-synthetic-records.test.mjs` | cc90642 | adaptado/local |
| `tests/helpers/synthetic-init-simulator.mjs` | cc90642 | exato |
| `tests/synthetic-composition-boundary.test.mjs` | local: teste/guarda/artefato | adaptado/local |
| `tests/synthetic-handoff-fixture.test.mjs` | cc90642 | exato |
| `tests/synthetic-initialization-controller.test.mjs` | cc90642 | exato |
| `tests/synthetic-initialization-status.test.mjs` | cc90642 | exato |
| `tests/synthetic-initialization.test.mjs` | cc90642 | exato |
| `tests/synthetic-payment-origin.test.mjs` | local: teste/guarda/artefato | adaptado/local |
| `tests/synthetic-web-artifact-check.mjs` | cc90642 | exato |
| `tests/synthetic-web-process.mjs` | local: teste/guarda/artefato | adaptado/local |
| `tsconfig.json` | local: teste/guarda/artefato | adaptado/local |

A matriz documenta a proveniência do código; logs e JSON detalhados não integram esta publicação.

## Atualização de evidência e limites de publicação

Na revisão 09ea62c072fd925eb62afdb2ecbd8d09d9b77b07: agregado 1231/1231, 35 verificações complementares e 18 verificações com PostgreSQL 17.11 real. Laboratório descartável sem rede externa: handlers compilados, inicialização única, concorrência/replay recusados, persistência, login/auth-me, senha provisória, acesso às três frentes e distinção 503/401. Não prova browser/TLS externo, falha durante COMMIT, durabilidade após reinício ou envio operacional. Nenhum defeito de produto encontrado. Relatório completo mantido fora do repositório; SHA-256 c74a2734577e5aaa7d42eeac4c05bbbf3f5ad73e6b3b1ab4febf4a1e2504fb1d identifica a evidência, mas não é link nem disponibiliza seu conteúdo.

A higiene posterior modifica somente documentos. Testes anteriores são reutilizados por igualdade exata dos demais blobs, não como nova execução. Documentos históricos acima descrevem a etapa em que foram escritos.

Automação versionada: `.github/workflows/contract-audit.yml` é herdado sem alterações; tem agenda e workflow_dispatch, não push/pull_request. Faz POST operacional em `/api/audit/contracts` com segredo de Actions; não executar manualmente para homologação. `package.json` conserva npm start com migração, inadequado para este laboratório; usar o launcher sintético. Não há configuração versionada nova de deploy. Integrações externas, regras de branch e webhooks não são demonstráveis só pelo Git; conferir por acesso autorizado antes de publicar. Branch separada e PR draft não são garantias universais contra automações externas.
