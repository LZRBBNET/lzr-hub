# Revisão de RBAC e auditoria (2026-07-27)

## Resumo executivo

O LZR HUB tem as **peças** de RBAC e auditoria (`lib/platform/rbac.ts`, tabela `audit_events` no D1), mas **nenhuma delas está de fato conectada às ações do sistema**. Isso acontece porque **não existe um sistema de autenticação/sessão de usuário** no produto ainda — nenhuma rota sabe "quem" está chamando, então não há como aplicar RBAC de verdade (só simular numa tela de demonstração).

Esta revisão documenta o estado real, corrige o que dava para corrigir sem quebrar funcionalidade existente, e recomenda que a implementação de autenticação/sessão vire uma issue própria — pré-requisito antes do M4 (escrita real no IXC, funil comercial fechando venda), onde ações reais e irreversíveis passam a acontecer.

## O que existe hoje

- `lib/platform/rbac.ts`: define papéis (`Administrador`, `Supervisor`, `Atendente`, `Suporte`, `Cobrança`, `Comercial`, `Analista`, `Somente leitura`) e uma função `can(role, permission)`.
- **Único uso**: `components/modules/admin.tsx`, tela "Usuários e Permissões" — um seletor de papel que mostra a matriz de permissões. Não há usuário logado real por trás; é puramente ilustrativo.
- Tabela `audit_events` no D1: existe e tem schema completo (ator, papel, ação, entidade, resultado, origem humano/IA, correlationId). Até esta revisão, **só era escrita pelo canal n8n** (`lib/platform/n8n-channel-service.ts`, adicionado nesta mesma sprint).
- Tela "Auditoria" do painel admin: mostra 3 registros **fixos no código** (`lib/platform/demo-data.ts`), não vêm do banco.

## Tabela: rota × controle de acesso × auditoria (estado antes desta revisão)

| Rota | Ação | Quem pode executar (intenção) | Bloqueia sem permissão? | Audita? |
|---|---|---|---|---|
| `POST /api/agent` | Conversa com o pipeline de IA | Qualquer canal autorizado | ❌ não | ❌ não |
| `GET/POST /api/customers` | Ver/atualizar Customer 360 (dado sensível, mascarado) | Atendente, Supervisor, Suporte | ❌ não | ❌ não (corrigido nesta revisão, ver abaixo) |
| `GET/POST /api/knowledge` | Ver, ingerir e **publicar** conteúdo que a IA cita como evidência | Analista/Supervisor (curadoria) | ❌ não — qualquer um publica | ❌ não (corrigido nesta revisão, ver abaixo) |
| `GET /api/health` | Status dos serviços | Público (por design) | n/a | n/a |
| `POST /api/integrations/ixc/smoke` | Rodar teste de conexão IXC | Administrador/ops | ✅ segredo administrativo (`x-staging-job-secret`) | ✅ sim (`ixc_smoke_results`) |
| `POST /api/integrations/ixc/sync` | Forçar sincronização IXC | Administrador/ops | ✅ segredo administrativo | parcial (`sync_jobs`/`sync_checkpoints`) |
| `GET/POST /api/pilot` | Registrar feedback do piloto interno | Participantes autorizados (lista de até 3 IDs) | ✅ segredo + allowlist de usuário | ✅ sim (`pilot_events`) |
| `POST /api/channels/n8n` | Canal WhatsApp → pipeline de IA | Serviço n8n autorizado | ✅ segredo compartilhado (Bearer) | ✅ sim (`audit_events`) |

## Achado mais grave

**`POST /api/knowledge`** permitia que qualquer pessoa com a URL publicasse um documento novo que a IA passa a citar como "evidência confiável" nas respostas ao cliente — sem nenhuma checagem. Isso é uma porta de envenenamento da base de conhecimento.

## Por que não dava para simplesmente "adicionar uma trava"

As rotas `/api/customers` e `/api/knowledge` são chamadas **direto do navegador**, por telas reais do produto (`components/modules/customer360.tsx` e `intelligence.tsx`), sem nenhum cabeçalho de autenticação. O padrão de segredo administrativo (`x-staging-job-secret`) usado nas rotas de integração/piloto **não pode ser usado aqui** — um segredo de servidor não pode ser conhecido pelo navegador do usuário final sem virar público. Travar essas rotas com esse padrão quebraria as telas de verdade, sem adicionar segurança real (qualquer um poderia extrair o segredo do próprio código do navegador).

Conclusão: a correção de verdade exige um sistema de login/sessão que identifique quem está por trás de cada requisição — isso virou uma issue própria (ver abaixo), não cabia nesta revisão.

## O que foi corrigido nesta revisão

- `/api/customers` (GET com id, POST refresh) e `/api/knowledge` (POST ingest/publish) agora **registram auditoria real** no D1 (`audit_events`), via `lib/platform/audit-log.ts`. Como ainda não existe usuário autenticado, o registro marca `actorId: "anônimo"`, `role: "não identificado"`, `origin: "não verificado"` — não é o RBAC completo que a issue pedia, mas fecha a lacuna de "nenhuma ação real deixa rastro" para essas duas rotas.
- A auditoria é *best-effort*: se o banco falhar, a ação principal continua funcionando normalmente (não pode derrubar a experiência do usuário por causa de um log).

## O que fica pendente (issue nova)

- Implementar autenticação e sessão de usuário real (login, identidade por requisição).
- Só depois disso: aplicar `rbac.ts` de verdade em cada rota (hoje ele é só uma tabela decorativa).
- Ligar a tela "Auditoria" do admin aos dados reais do D1, em vez do array fixo em `demo-data.ts`.
- Reforçar `/api/agent` e `/api/knowledge` com limite de taxa (rate limit) até a autenticação existir, como mitigação adicional.

## Como saber que terminou (retomando os critérios da issue)

- [x] Tabela papel × ação documentada (acima)
- [ ] Toda ação testada com usuário sem permissão foi bloqueada — **não dá pra fechar ainda**: sem autenticação, não existe "usuário sem permissão" pra testar de verdade (é o próprio achado desta revisão)
- [x] Toda ação executada aparece na auditoria com origem — parcial: `/api/customers` e `/api/knowledge` agora auditam, mas sem autor real (marcado como "não identificado" até existir login); `/api/agent` ainda não audita (ver issue nova)
- [x] Furos encontrados registrados como issue (autenticação de usuário — pré-requisito do M4)
