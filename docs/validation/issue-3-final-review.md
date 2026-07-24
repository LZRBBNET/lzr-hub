# Issue #3 — revisão técnica final do PR #24

## Identificação

- Data: 24/07/2026.
- Pull Request: #24 — `feat(agent): homologate AI pipeline with real ISP scenarios (#3)`.
- Branch base: `main`.
- Branch revisada: `feat/issue-3-agent-pipeline-homologation`.
- Commit inicialmente revisado: `ac29c99ec2bde3392e60d8ce05d4b7d61bb2c881`.
- Base confirmada no início da revisão: `f8adec597093a08184d14ccf7f6fe21276060445`.
- Estado inicial: 14 commits à frente, 0 atrás, mergeável, sem conflitos, comentários ou reviews.
- GitHub Actions: nenhum workflow run associado ao commit inicialmente revisado.

## Escopo

Foi revisado integralmente o contrato HTTP da rota pública, o pipeline determinístico,
os contratos de tipo, a execução controlada de ferramentas, a política de evidência,
o transbordo, a repetição, o executor interno de homologação, a matriz dos 60
cenários, os testes de segurança e a configuração de ambiente.

Arquivos analisados no diff:

- `.env.example`
- `app/api/agent/route.ts`
- `docs/issue-3-agent-pipeline-homologation-report.md`
- `docs/issue-3-agent-pipeline-inventory.md`
- `lib/agent/evidence.ts`
- `lib/agent/handoff.ts`
- `lib/agent/homologation-scenarios.ts`
- `lib/agent/homologation.ts`
- `lib/agent/pipeline.ts`
- `lib/agent/repetition.ts`
- `lib/agent/tool-engine.ts`
- `lib/agent/types.ts`
- `lib/runtime/environment.ts`
- `tests/agent-homologation.test.mjs`
- `tests/agent-route-security.test.mjs`

O diff não contém `services/ixc-relay/**`, `deploy/ixc-relay/**`,
`lib/integrations/ixc/**`, Collection Postman ou qualquer arquivo do PR #26.

## Contrato HTTP e fronteiras de segurança

- Mensagem vazia, acima do limite, JSON inválido e histórico malformado retornam
  erros controlados.
- O histórico é validado e limitado às 40 mensagens mais recentes.
- `simulationProfile`, `channel`, ambiente e contexto operacional são bloqueados
  por body, query string e headers conhecidos.
- A rota pública deriva `channel: "web"` no servidor.
- Os perfis de homologação só são usados por chamada interna direta.
- A feature flag é `false` por padrão, valores inválidos falham fechados e
  `production` bloqueia homologação mesmo com a flag configurada como `true`.
- Não existe endpoint adicional de homologação nem header tratado como segredo
  confiável.
- Os dois ataques exigidos, com `simulationProfile: "payment_recognized"` e com
  `channel: "test"`, retornam HTTP 403 e não selecionam fixture.

## Matriz de homologação

Foram confirmados exatamente 60 IDs únicos. A matriz cobre suporte e conexão,
ONU offline, PPPoE offline, potência crítica, massiva, lentidão, Wi-Fi,
financeiro, PIX, fatura, pagamento, bloqueio, chamado, visita, transbordo,
irritação, cancelamento, reclamação, troca de assunto, repetição, dados
insuficientes, dois contratos, entradas inválidas, prompt injection, outro
cliente, ação não autorizada, timeout, indisponibilidade, erro, resposta vazia
e dados contraditórios.

Os testes não se limitam a HTTP 200: validam intenção, ferramenta permitida,
ferramentas proibidas, resultado operacional, evidência, ausência de ação real,
ausência de confirmação falsa, pergunta única, transbordo, motivo e status final.

## Achados e correções

| Severidade | Arquivo | Achado | Situação |
| --- | --- | --- | --- |
| Alto | `lib/agent/evidence.ts` | Alegações alternativas ou passivas, como “Seu chamado está aberto” e “O contrato foi desbloqueado”, podiam escapar do detector. Uma resposta mista também podia esconder falha usando uma alegação de sucesso e apenas “preparado” como indicação de simulação. | Corrigido |
| Baixo | `lib/agent/evidence.ts` | A negação legítima “Não enviei” era classificada como confirmação de sucesso quando não havia evidência. | Corrigido |
| Baixo | `tests/agent-route-security.test.mjs` | Não havia regressão específica para alegações passivas, resposta mista, indicação fraca de simulação e negações legítimas. | Corrigido com 4 testes |
| Sugestão | `app/api/agent/route.ts` | O histórico continua sendo fornecido pelo cliente. Hoje ele só influencia contexto textual, é validado/truncado e não seleciona cadastro real; antes de integrar dados reais, deve ser vinculado a uma sessão autenticada no servidor. | Risco residual documentado; fora do escopo deste PR |

Correções aplicadas:

- Ampliação das formas de alegação de sucesso cobertas.
- Tratamento explícito de negação próxima à alegação.
- Qualquer recibo com falha impede confirmação de sucesso na mesma resposta.
- “Preparado” isoladamente deixou de ser prova suficiente de simulação.
- Quatro testes de regressão cobrem o achado alto e o falso positivo.

## Segredos, PII e escrita IXC

A busca no diff por `token`, `secret`, `password`, `authorization`, `bearer`,
`basic`, `cpf`, `cnpj`, `telefone`, `email`, `cookie`, `api_key` e
`client_secret` encontrou apenas nomes de variáveis vazias, regras de
sanitização, documentação e dados sintéticos dos testes. Não foi encontrado
segredo real, token fixo, CPF válido de cliente, telefone real ou e-mail real.

Os valores de teste usam domínio `.invalid`, documento sintético e telefone
fictício. Resumos de transbordo removem documento, telefone e e-mail.

`IXC_WRITE_ENABLED=false` e `FEATURE_IXC_WRITE=false` permanecem exigidos. O
pipeline não executa ação externa real e nenhum arquivo da integração IXC foi
alterado.

## Comandos executados

| Comando | Resultado | Duração aproximada |
| --- | --- | ---: |
| `npm run install:ci` | Aprovado — 507 pacotes instalados pelo lockfile | 15,23 s |
| `npm run lint` | Aprovado — 0 erros | 3,51 s |
| `npm run typecheck` | Aprovado — 0 erros | 2,95 s |
| `npm test` | Aprovado — 122/122 | 3,69 s |
| `npm run build` | Aprovado | 2,86 s |
| `npm run validate:artifact` | Aprovado | 0,19 s |

Diferença para o texto anterior do PR: o total passou de 118 para 122 testes
devido aos quatro testes de regressão adicionados nesta revisão.

Warnings não bloqueadores:

- npm informa que a configuração `http-proxy` deixará de ser aceita em uma
  futura versão principal.
- Dois pacotes transitivos `@esbuild-kit/*` estão depreciados.
- Vinext informa que algumas rotas dinâmicas ainda não são classificadas
  estaticamente e que as variáveis de proxy serão usadas em requisições.

## Riscos residuais

- Não há workflow run do GitHub Actions para o commit inicialmente revisado; as
  seis validações obrigatórias foram executadas localmente.
- O pipeline público ainda opera com resultados simulados e os identifica como
  tal. Nenhuma integração real deve ser habilitada sem autenticação, vínculo de
  sessão e homologação própria.
- O histórico fornecido pelo cliente não pode ser usado futuramente como fonte
  de identidade ou autorização.

## Conclusão

Não restou bloqueador, alto ou médio aberto. Os 60/60 cenários e 122/122 testes
passam; lint, typecheck, build e validação do artefato estão aprovados; a
homologação pública permanece bloqueada; produção falha fechada; escrita IXC
continua desabilitada; não há segredo ou PII real versionado.

**APROVADO PARA MERGE HUMANO**

Passos humanos:

1. Confirmar que o commit final do PR corresponde às correções e a este relatório.
2. Confirmar os checks verdes disponíveis no GitHub.
3. Usar squash merge.
4. Confirmar que `Closes #3` encerrou a Issue #3.
5. Atualizar a `main` local.
6. Remover a branch somente após confirmar o merge.
