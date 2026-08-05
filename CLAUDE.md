# LZR HUB — guia para quem (ou o que) vai mexer neste repositório

Este documento existe para que qualquer pessoa **e qualquer assistente de IA** trabalhando neste projeto tenha o mesmo entendimento da infraestrutura e das convenções. Leia antes de propor mudanças.

## O que é o produto

Plataforma de atendimento com IA para a **BBNET**, um provedor de internet (ISP). A IA atende o cliente final (N1: fatura, segunda via, sem conexão, lentidão), consulta o ERP do provedor e passa para um humano quando não deve decidir sozinha.

## Onde roda

| Coisa | Onde |
|---|---|
| Aplicação | **Railway** — https://lzr-hub-production.up.railway.app |
| Repositório | **github.com/LZRBBNET/lzr-hub** (organização, não conta pessoal) |
| Banco de dados | **Postgres** gerenciado pelo Railway, no mesmo projeto |
| Ponte com o ERP | VM própria (Proxmox) em `https://ixc-bridge.bbnetup.com.br` |

Deploy é **automático**: push na `main` dispara build e deploy no Railway. Não existe passo manual.

### Histórico que evita retrabalho

- **Não usamos mais Cloudflare Workers nem D1.** O projeto nasceu de um template `vinext` voltado a Workers; isso foi migrado para Node + Postgres. Se encontrar referência a D1, binding `DB` ou `cloudflare:workers`, é resíduo.
- **Não usamos mais "ChatGPT Sites".** Foi a hospedagem inicial, abandonada por ficar presa a uma conta pessoal com acesso restrito.
- O `wrangler.jsonc` ainda existe, mas serve apenas ao ambiente de demonstração mock; **não é o caminho de produção**.

## Stack

- **Next.js 16 / React 19** rodando via **`vinext`** (Next sobre Vite). O comando de produção é `vinext start`, não `next start`.
- **Drizzle ORM** com **`drizzle-orm/pg-core`** e driver `pg`. Dialeto é **postgresql**.
- Testes com o runner nativo do Node (`node --test`), sem framework externo.
- TypeScript com `--experimental-strip-types` nos testes (por isso **sintaxe de parameter property no construtor não funciona** — declare o campo e atribua no corpo).

## Comandos

```bash
npm run dev         # desenvolvimento local
npm run build       # build de produção
npm start           # roda migrações e sobe o servidor (é o que o Railway executa)
npm test            # build + suíte completa
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run db:generate # gera migração a partir do schema
npm run db:migrate  # aplica migrações no Postgres
```

`npm start` roda `scripts/migrate-postgres.mjs` **antes** de subir o servidor. Sem `DATABASE_URL` ele avisa e segue sem migrar, em vez de derrubar o boot.

## Banco de dados

Schema único em [`db/schema.ts`](db/schema.ts). Para mudar:

1. Edite o schema
2. `npm run db:generate` (gera SQL em `drizzle/`)
3. **Commite o SQL e o snapshot gerados** — o Railway aplica no deploy

Nunca edite um arquivo de migração já commitado.

`DATABASE_URL` é injetada pelo Railway via referência `${{Postgres.DATABASE_URL}}`. Esse endereço é da **rede privada** e não funciona fora do Railway — para rodar scripts da sua máquina, use o `DATABASE_PUBLIC_URL`.

## Feature flags e a regra do fail-closed

O sistema tem várias flags (`FEATURE_*`) e **todas nascem desligadas**. Isso é deliberado, não descuido: o ambiente publicado é acessível e ainda não tem login em uso, então nada que produza efeito real no mundo pode estar ligado por padrão.

Flags relevantes:

| Flag | O que libera | Estado hoje |
|---|---|---|
| `FEATURE_AUTH` | Exige login e aplica RBAC nas rotas | **desligada** |
| `FEATURE_N8N_CHANNEL` | Canal WhatsApp via n8n recebe e registra mensagem | desligada |
| `FEATURE_N8N_AUTOREPLY` | A IA **responde ao cliente** pelo canal | desligada |
| `FEATURE_QUEUES` | Filas reais (Redis/BullMQ) | desligada |
| `FEATURE_IXC_WRITE` | Escrita no ERP | desligada |
| `FEATURE_IXC_FULL_BASE` | Leitura da **base inteira** do IXC, não só da allowlist | desligada |
| `IXC_MODE` | `disabled` / `staging-readonly` | `disabled` |

⚠️ **`FEATURE_AUTH=true` é obrigatório antes de qualquer dado real** (milestone M4: escrita no IXC, cobrança, venda). Enquanto desligada, nenhuma rota sabe quem está agindo.

### Modo observação do canal (`FEATURE_N8N_CHANNEL` ligada, `FEATURE_N8N_AUTOREPLY` desligada)

Esse é o estado atual em produção e é deliberado: o canal recebe a mensagem do cliente, classifica a intenção e a IA **produz** a resposta — mas ninguém a envia. Ela fica gravada em `channel_messages` com `role = "suggestion"`, aparece na tela marcada como não enviada, e o desfecho é registrado como `suggested`, que **não** entra na conta de "resolvido sem humano". A pergunta de CSAT também não é feita: não dá para avaliar um atendimento que o cliente não recebeu.

⚠️ O fluxo do n8n precisa checar o campo `autoReply` da resposta antes de enviar qualquer coisa. Com a flag desligada, `response` volta `null` justamente para que um fluxo que ignore `autoReply` falhe em vez de mandar mensagem vazia ao cliente.

### Antes de ligar qualquer flag

Pergunte: *isso passa a produzir efeito no mundo real?* Se sim (mensagem enviada, cobrança gerada, cadastro alterado), a ação precisa estar protegida por login, auditada e idempotente antes de ser ligada.

## A ponte com o IXC (ERP)

O IXC exige **IP liberado** para aceitar chamadas. Como a aplicação roda em nuvem sem IP fixo, existe um relay Node em VM própria com IP dedicado, atrás de HTTPS (Caddy + Let's Encrypt) e firewall.

Detalhes que economizam horas de depuração:
- O IXC exige método **GET com corpo JSON** para listagens (sim, GET com body) e cabeçalho `ixcsoft: listar`
- O endpoint de contratos é `cliente_contrato`, não `contrato`
- Ordens de serviço filtram por `id_cliente`, não `id_assunto`

Ver [`docs/integrations/ixc-data-mapping.md`](docs/integrations/ixc-data-mapping.md).

## Convenções de código

**Padrão de repositório com injeção de dependência.** Toda lógica que toca o banco fica atrás de uma interface, com duas implementações: uma real (`Db*Repository`) e uma em memória (`Memory*Repository`) usada nos testes. Isso permite testar regra de negócio sem banco. Exemplos: `lib/platform/auth.ts`, `lib/platform/support-metrics.ts`, `lib/platform/n8n-channel-service.ts`.

**Rotas de API são finas.** Elas validam entrada, chamam o serviço e devolvem a resposta. Regra de negócio não mora em `app/api/`.

**Degradar, não mentir.** Quando uma fonte de dados não está disponível, a resposta diz que está indisponível — nunca devolve zero ou valor inventado como se fosse real. O painel de métricas e a tela de auditoria seguem isso.

**Nada de dado pessoal em log ou resumo.** Há sanitização obrigatória (e-mail, CPF/CNPJ, telefone) antes de gravar qualquer texto vindo de conversa. Ver `sanitizeHandoffText` em `lib/agent/handoff.ts`.

**Contexto operacional vem do servidor.** Rotas nunca aceitam do cliente campos como `channel`, `simulationProfile` ou `role` — isso é rejeitado com 403 (`hasUntrustedOperationalContext` em `app/api/agent/route.ts`).

**Estilo.** Parte do código usa formatação bem compacta (várias instruções por linha). Ao editar um arquivo, siga o estilo dele em vez de reformatar.

**Comentários explicam o porquê, não o quê.** Especialmente decisões de segurança e escolhas não óbvias.

## Antes de abrir PR ou dar push

```bash
npm run typecheck && npm run lint && npm test
```

Os três precisam passar. Hoje a suíte tem **221 testes**.

## Segurança — pontos já decididos

- Senha com **scrypt** (nativo do Node — evita dependência compilada que quebraria o build), salt por usuário, comparação de tempo constante
- Sessão em cookie `HttpOnly`/`SameSite=Lax`/`Secure`; **o banco guarda só o SHA-256 do token**
- Login que falha sempre responde a mesma mensagem, e gasta o mesmo tempo mesmo com e-mail inexistente
- Segredos **nunca** vão para o repositório. `.env*` é ignorado, exceto os `.example`

Ver [`docs/security/authentication.md`](docs/security/authentication.md).

## Limites conhecidos (não são bugs a "descobrir")

- Sem rate limit no login
- A tela de Usuários gerencia contas de verdade: criar, desativar/reativar, trocar perfil e resetar senha, tudo auditado. A senha é **sempre gerada pelo sistema** e mostrada uma única vez; ninguém escolhe senha de terceiro. Duas travas impedem auto-bloqueio: não dá para desativar ou rebaixar a própria conta, nem deixar o sistema sem nenhuma conta capaz de gerenciar usuários
- Não existe troca de senha pelo próprio usuário — só reset por quem administra
- Custo por atendimento não é medido (depende do Langfuse, issue #6)
- Tempo médio de atendimento também não é medido — a Visão geral escreve isso em vez de estimar
- Responder pela tela de Atendimentos ainda não existe: quem responde é o fluxo do n8n, então o campo fica desabilitado
- Conversa do canal não é associada ao cadastro do IXC (faltaria casar o telefone do WhatsApp com o cliente)
- A lista de Clientes é a allowlist do IXC enquanto `FEATURE_IXC_FULL_BASE` estiver desligada. A trava é **nossa**, de homologação, não do ERP: `scripts/ixc-probe-listing.mjs` pergunta ao IXC se a listagem paginada funciona. Ligar a flag exige `FEATURE_AUTH=true` (o código recusa a subir sem isso)
- Com `FEATURE_IXC_FULL_BASE` ligada, Chamados mostra a fila real do provedor (OS não fechadas, paginadas). A OS não traz o nome do cliente — só `id_cliente` e endereço — e buscar o nome seria uma consulta por linha da página
- Churn é **realizado**, não previsto: medimos quem saiu, não quem vai sair. Não há score de saúde nem elegibilidade de upgrade — nada disso é calculado, e a tela diz o que faltaria
- Não existe CRM: leads, funil e origem do contato não são registrados em lugar nenhum
- O motivo de cancelamento do IXC vem como código numérico e a API não expõe a tabela de tradução
- Não há integração de monitoramento de rede (alerta, potência em massa, correlação geográfica). Massivas são registradas por uma pessoa, na tela; o Mapa de Alertas agrupa só o que foi registrado
- O runtime de filas tem apenas um teste, e ele é pulado sem um Redis disponível

## Trabalhando em paralelo

Mais de uma pessoa (e mais de um assistente) mexe neste repositório ao mesmo tempo. Antes de começar:

```bash
git fetch origin && git log --oneline main..origin/main
```

Se houver commits novos, faça `git pull --rebase origin main` **antes** de trabalhar. Já houve caso de trabalho paralelo sobrescrever silenciosamente arquivo do outro durante rebase — depois de qualquer rebase, rode a suíte e confira se o que você esperava continua lá.

Existem duas frentes que convivem: a **funcionalidade real** (IXC, n8n, filas, autenticação) e o **ambiente de demonstração protegido**, que é mock-only e falha fechado. O `tests/staging-demo.test.mjs` valida a segunda e é sensível: ele exige que `/api/health` devolva exatamente 5 campos. Não adicione campos ali sem entender o que quebra.

## Onde achar o resto

- `docs/security/` — autenticação, revisão de RBAC e auditoria
- `docs/support/handoff-policy.md` — quando a IA passa para humano
- `docs/integrations/` — IXC (mapeamento de dados, segredos, ponte)
- `docs/queues-bullmq.md` — filas
- Issues no GitHub descrevem o roadmap por milestone (M1 a M5)
