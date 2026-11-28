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

### ⚠️ `npm run dev` só às vezes enxerga o Postgres

`npm run dev` sobe o Vite sobre o **runtime do Cloudflare Workers** (Miniflare). Ali o driver `pg` abre socket TCP e frequentemente trava: a rota devolve *"The Workers runtime canceled this request because it detected that your Worker's code had hung"*.

É **intermitente**, não determinístico — na mesma execução `/api/audit` e `/api/knowledge` responderam 200 enquanto `/api/support/metrics`, `/api/conversations` e `/api/sales/goals` travaram. Recarregar às vezes resolve, às vezes não. Não confie no resultado: uma tela vazia no `npm run dev` pode ser o runtime, não o seu código.

Produção não tem esse problema: o Railway roda `vinext start`, que é Node.

Consequência prática: **não dá para conferir tela de banco rodando só `npm run dev`.** Isso explica boa parte da ficção que sobreviveu tanto tempo nessas telas — ninguém conseguia ver o dado real localmente.

### Como conferir tela de banco na sua máquina

O caminho que funciona é rodar em **modo produção**, que usa Node de verdade — o mesmo runtime do Railway.

```bash
docker run -d --name lzr-dev-pg -e POSTGRES_PASSWORD=devlocal -e POSTGRES_DB=lzrhub -p 55432:5432 postgres:16-alpine
```

Aponte `DATABASE_URL` para `postgres://postgres:devlocal@localhost:55432/lzrhub` no `.env.local`, rode `npm run db:migrate` e `node scripts/seed-dev.mjs` (o seed **recusa** qualquer banco que não seja localhost). Depois:

```bash
npm run build
npm start                          # porta 3000, Node de verdade
node scripts/dev-static-bridge.mjs # porta 3100 — abra esta no navegador
```

A ponte existe por um motivo específico: o `vinext start` local devolve **404 para tudo em `/assets/*`**, então a página chega sem CSS nem JS e a tela fica ilegível. `scripts/dev-static-bridge.mjs` serve os estáticos de `dist/client` e repassa o resto para a porta 3000. No Railway isso não é preciso — lá o `vinext start` serve os estáticos corretamente.

⚠️ `npm start` roda `db:migrate` antes de subir, mas **esse script não lê o `.env.local`** — ele avisa que não há `DATABASE_URL` e segue. O servidor em si lê. Se precisar migrar, rode `npm run db:migrate` com a variável no ambiente.

O `npm run dev` continua ótimo para tudo que não toca banco: é mais rápido e tem recarga quente.

`scripts/seed-dev.mjs` cria 8 usuários, 46 conversas espalhadas em 30 dias, massivas, documentos e leads. É massa de desenvolvimento, não dado de demonstração embutido no produto.

## Banco de dados

Schema único em [`db/schema.ts`](db/schema.ts). Para mudar:

1. Edite o schema
2. `npm run db:generate` (gera SQL em `drizzle/`)
3. **Commite o SQL e o snapshot gerados** — o Railway aplica no deploy

Nunca edite um arquivo de migração já commitado.

`DATABASE_URL` é injetada pelo Railway via referência `${{Postgres.DATABASE_URL}}`. Esse endereço é da **rede privada** e não funciona fora do Railway — para rodar scripts da sua máquina, use o `DATABASE_PUBLIC_URL`.

## Feature flags e a regra do fail-closed

O sistema tem várias flags (`FEATURE_*`) e **nasceram todas desligadas**. Isso foi deliberado, não descuido: o ambiente publicado era acessível e ainda não tinha login em uso, então nada que produzisse efeito real no mundo podia estar ligado por padrão. Várias já foram ligadas em produção desde então — a tabela abaixo é o estado real, checado via `railway variables --service lzr-hub --environment production`, não o estado de nascença.

Flags relevantes:

| Flag | O que libera | Estado em produção |
|---|---|---|
| `FEATURE_AUTH` | Exige login e aplica RBAC nas rotas | **ligada** |
| `FEATURE_N8N_CHANNEL` | Canal WhatsApp recebe e registra mensagem (nome histórico: o n8n saiu do caminho, a Evolution chama a API direto) | **ligada** (modo observação — ver abaixo) |
| `FEATURE_N8N_AUTOREPLY` | A IA **responde ao cliente** pelo canal — pela Meta, como **primeira resposta**, uma por espera (ver *Auditoria do que a IA faz*) | desligada |
| `FEATURE_AI_INVOICE` | Com o titular confirmado pelo CPF, a IA **manda os dados da fatura** (vencimento, valor e o **PIX copia e cola**). Só vale com `FEATURE_N8N_AUTOREPLY` | desligada — PIX provado no IXC real em 16/11; pode ligar junto com a resposta automática |
| `FEATURE_OFF_HOURS_AUTOREPLY` | **Fora do horário comercial** (seg–sex, 8h–12h e 14h–18h, Brasília, exceto feriado) a IA responde sozinha: lista clicável de assuntos, respostas aprovadas, 2ª via com PIX e resposta pelo diagnóstico. Dentro do horário nada muda | desligada |
| `FEATURE_N8N_BOT` | **Robô de dúvidas** no horário comercial: o LZR pede ao n8n (Groq) a resposta de uma dúvida que a base de conhecimento sustenta e a envia. Exige `N8N_BOT_URL` (https) e `N8N_BOT_SECRET`. Ver `docs/integrations/n8n/robo-duvidas.md` | desligada |
| `FEATURE_AI_AGENT` | **Modo autônomo**: a IA atende sozinha, a qualquer hora, e **conduz o atendimento até o fim** — resolve o problema técnico (com o diagnóstico do IXC, inclusive o sinal da fibra) ou faz as perguntas do roteiro do assunto até o pedido ficar pronto, grava a ficha no atendimento e só então o deixa na fila da equipe. Usa `N8N_BOT_URL`/`N8N_BOT_SECRET`; sem eles não liga. Ver *Modo autônomo* abaixo | **ligada** em 17/11/2026 (pelo painel do Railway) |
| `FEATURE_AI_SERVICE_ORDER` | No modo autônomo, quando o pedido **técnico** fica pronto, a IA **abre a OS no IXC** sozinha (14 sem internet, 116 lenta, 118 quedas, 49 roteador; setor 1) e diz o número ao cliente. Exige `FEATURE_IXC_WRITE` e a ponte nova (ver *A ponte com o IXC*) | desligada |
| `FEATURE_AI_TRUST_UNLOCK` | No modo autônomo, a IA **libera a internet em confiança** no IXC pela regra da BBNET (ver *Desbloqueio de confiança pela IA*). Exige `FEATURE_IXC_WRITE` | desligada |
| `FEATURE_AUDIO_TRANSCRIPTION` | **Áudio do cliente vira texto**: o LZR baixa o áudio pela API da Meta, transcreve na OpenAI (`gpt-4o-mini-transcribe`, `OPENAI_TRANSCRIBE_MODEL` troca) e a fala segue como qualquer texto, gravada como "[Áudio transcrito] …". Exige `OPENAI_API_KEY`. É a primeira vez que o **áudio** (não só texto sanitizado) do cliente sai para um provedor externo — decisão de privacidade antes de ligar. O arquivo não é gravado. Falha ou desligada: a IA pede para escrever | desligada |
| `FEATURE_BILLING_REMINDERS` | **Cobrança pelo WhatsApp** (modelo aprovado): 3 dias antes, no vencimento, 1 dia de atraso e véspera do bloqueio (7 dias). Disparada por `.github/workflows/outbound.yml` | desligada |
| `FEATURE_NETWORK_NOTICES` | **Avisos de rede** aos clientes do bairro: massiva, normalização e manutenção programada | desligada |
| `FEATURE_QUEUES` | Filas reais (Redis/BullMQ) | desligada |
| `FEATURE_IXC_WRITE` | Escrita no ERP — as 4 operações do catálogo (segunda via, OS, renegociação, cadastro de cliente) | **ligada** |
| `FEATURE_IXC_FULL_BASE` | Leitura da **base inteira** do IXC, não só da allowlist | **ligada** |
| `FEATURE_LLM_INTENT` | Classificação de intenção por modelo de linguagem (Groq) | **ligada** |
| `FEATURE_COPILOT_LLM` | O copiloto do atendente **redige** a resposta a partir dos trechos citados | desligada — sem ela o copiloto mostra os trechos como estão |
| `FEATURE_META_WHATSAPP` | Canal **oficial** da Meta (Cloud API) — `/api/channels/meta` | **ligada** — número `+55 79 6000-4421`, conta "Bbnet Bot" (ver `docs/integrations/whatsapp-meta.md`) |
| `FEATURE_ATTENDANT_REPLY` | O **atendente responde ao cliente** pela tela de Atendimentos, via Cloud API. Também exige `FEATURE_AUTH`, `META_ACCESS_TOKEN` e `META_PHONE_NUMBER_ID` | **ligada** — em uso em produção (resposta de atendente "Aceita pela Meta" vista na tela em 10/10/2026; não conferido no painel do Railway) |
| `FEATURE_TELEGRAM_ALERTS` | Ingestão de alerta de rede real via webhook do Telegram | desligada — pendente criar o bot e chamar `setWebhook` (ver `app/api/integrations/telegram/webhook`) |
| `IXC_MODE` | `disabled` / `staging-readonly` | `staging-readonly` |

⚠️ Isto muda o que é verdade no resto deste documento: com `FEATURE_AUTH=true` já ligada, toda rota sabe quem está agindo — o pré-requisito do milestone M4 (escrita no IXC, cobrança, venda) está satisfeito nesse ponto específico. Com `FEATURE_IXC_FULL_BASE=true`, telas que diziam "exige leitura da base inteira" (Chamados, Churn, Relatórios comerciais) agora leem a base cheia de verdade em produção, não só a allowlist.

### Modo observação do canal (`FEATURE_N8N_CHANNEL` ligada, `FEATURE_N8N_AUTOREPLY` desligada)

Esse é o estado atual em produção e é deliberado: o canal recebe a mensagem do cliente, classifica a intenção e a IA **produz** a resposta — mas ninguém a envia. Ela fica gravada em `channel_messages` com `role = "suggestion"`, aparece na tela marcada como não enviada, e o desfecho é registrado como `suggested`, que **não** entra na conta de "resolvido sem humano". A pergunta de CSAT também não é feita: não dá para avaliar um atendimento que o cliente não recebeu.

⚠️ O fluxo do n8n precisa checar o campo `autoReply` da resposta antes de enviar qualquer coisa. Com a flag desligada, `response` volta `null` justamente para que um fluxo que ignore `autoReply` falhe em vez de mandar mensagem vazia ao cliente.

### Antes de ligar qualquer flag

Pergunte: *isso passa a produzir efeito no mundo real?* Se sim (mensagem enviada, cobrança gerada, cadastro alterado), a ação precisa estar protegida por login, auditada e idempotente antes de ser ligada.

## A "IA" e o classificador de intenção

⚠️ **Leia isto antes de mexer no agente.** O pipeline em `lib/agent/` **não usa modelo de linguagem** para responder: `analyzeIntent` é uma cadeia de expressões regulares e as respostas são textos fixos por intenção. Isso é deliberado no que toca à resposta — ela carrega garantias que o projeto não quer perder (nunca afirmar ação não executada, exigir evidência, transbordar quando não sabe).

O problema medido está na **classificação**: em 13 conversas reais, 11 transbordaram por `low_intent_confidence`. A cadeia é `analyzeIntent` não casa nenhuma regra → confiança 0,55 → `handoff.ts` corta em 0,6 → transborda. Cliente real não escreve como a regra espera.

`FEATURE_LLM_INTENT` liga um classificador com modelo de linguagem (Groq, camada gratuita) que escolhe **um item de uma lista fechada** de intenções. O modelo nunca escreve texto para o cliente — a saída é um enum validado contra `INTENTS`, e resposta fora da lista é descartada.

**Hoje o provedor é a OpenAI** (`OPENAI_API_KEY`; a API não usa o conteúdo para treinar por padrão). Historicamente: **Groq foi escolhido em vez do Gemini por privacidade**: na camada gratuita do Gemini o Google usa o conteúdo enviado para treinar modelos e revisor humano pode ver. A Groq não treina com dado de cliente em nenhuma camada. Ainda assim, a mensagem sai **sanitizada** (`sanitizeHandoffText` remove e-mail, CPF e telefone) — o provedor não precisa disso para entender a intenção.

Fail-closed em três camadas: sem `GROQ_API_KEY` não há chamada; erro ou demora acima de 4s cai na regex; resposta inválida é descartada. Em nenhum caso o atendimento para.

**Memória.** O classificador recebe, além da mensagem, as últimas falas da conversa (`LLM_CONTEXT_TURNS = 6`, só das últimas 6 horas — `contextForClassifier` em `n8n-channel-service.ts`). Sem isso "sim" e "continua igual" eram ilegíveis. Sugestão da IA fica fora (o cliente nunca a viu), cada fala é sanitizada, e o prompt diz ao modelo que o texto da conversa é dado, não instrução.

### Respostas aprovadas: o texto que sai pelo canal

O canal **não usa o texto do pipeline**. O pipeline continua decidindo intenção, transbordo e desfecho, mas o texto que vira sugestão (e, quando o envio automático for ligado, resposta) é a **resposta aprovada da intenção** — `resolveReply` em `lib/platform/reply-templates-shared.ts`. O texto do pipeline é de homologação e segue servindo ao simulador de `/api/agent`.

Os padrões moram no código e descrevem **o que vai acontecer** ("vou encaminhar", "um atendente retorna"), nunca algo já feito. A BBNET edita em **Base de conhecimento → Respostas aprovadas** (permissão `knowledge.publish`); a edição fica em `agent_reply_templates`, com versão, e o texto anterior vai para a auditoria. A validação recusa texto vazio, acima de 1000 caracteres, com e-mail/CPF/telefone (a resposta vale para todo cliente) ou com "fictício", "homologação" ou "simulado". Edição inválida que chegue ao canal cai no padrão; banco fora do ar também — os padrões são seguros.

### O copiloto do atendente é outra coisa

`lib/platform/copilot-service.ts` **não usa** `runAgentPipeline`, e isso é deliberado. O pipeline escreve texto de homologação ("preparei a segunda via *fictícia*"); oferecer isso ao atendente como "resposta pronta para enviar" entregaria a palavra *fictícia* a um cliente real.

O copiloto responde a partir da **base de conhecimento** e cita título e versão do documento. Sem trecho que sustente, ele diz que não sabe — e o modelo nem chega a ser chamado. Com `FEATURE_COPILOT_LLM` ligada o modelo reescreve os trechos, mas recebe **só** eles, devolve `NAO_SEI` quando não dão conta, e os trechos continuam na tela ao lado da resposta.

A busca é por palavra, não semântica (`FEATURE_PGVECTOR` desligada). Pontuação na ponta da palavra sai antes de buscar (até 26/11 o "capela?" de "onde é a loja de Capela?" nunca casava, e toda pergunta perdia a última palavra); hífen no meio fica ("wi-fi"). O cliente escreve "ta sem net" e o documento se chama "cliente sem conexão" — por isso a **intenção já classificada** entra como busca separada, fazendo a ponte entre os dois vocabulários. Somar os termos numa busca só não funcionaria: aumentaria o divisor da pontuação e afundaria o documento certo.

⚠️ `intentOverride` é **contexto operacional**: a rota do agente o recusa com 403 se vier do cliente, junto com `channel` e `simulationProfile`. Quem escolhe a própria intenção contorna a decisão de transbordo.

## A ponte com o IXC (ERP)

O IXC exige **IP liberado** para aceitar chamadas. Como a aplicação roda em nuvem sem IP fixo, existe um relay Node em VM própria com IP dedicado, atrás de HTTPS (Caddy + Let's Encrypt) e firewall.

⚠️ **Até 18/11/2026 a ponte transformava toda chamada em listagem** (GET + `ixcsoft: listar`), então **nenhuma escrita** — OS, cadastro, renegociação — criava nada no IXC; a OS "aberta" voltava como uma lista de OS de outros clientes e ficava como resultado incerto no ledger. A versão corrigida (listagem só com `ixcsoft: listar`; o resto com o método original) está em `infra/ixc-bridge/server.js`, foi provada numa porta de teste (OS 301041 no cadastro de teste) e **está no ar desde 18/11/2026** (backup `server.js.bak-2026-11-18` na VM). Mudar a ponte exige reiniciar o serviço na VM — ver `docs/integrations/ixc-ponte-e-conexao.md`.

Detalhes que economizam horas de depuração:
- O IXC exige método **GET com corpo JSON** para listagens (sim, GET com body) e cabeçalho `ixcsoft: listar`
- Abertura de OS: assunto com `login_obrigatorio = S` (14, 49) exige `id_login` e `origem_endereco = "L"`; sucesso é `{type:"success", message:"Registro inserido com sucesso!", id}` (piloto de 18/11)
- O endpoint de contratos é `cliente_contrato`, não `contrato`
- Ordens de serviço filtram por `id_cliente`, não `id_assunto`

Ver [`docs/integrations/ixc-data-mapping.md`](docs/integrations/ixc-data-mapping.md).

### Escrita no IXC: o que já existe e o que não

⚠️ **`FEATURE_IXC_WRITE` está ligada em produção** (conferido no painel do Railway em 13/08/2026). Não é ensaio: quem tem a permissão `ixc.write` — hoje **Administrador** e **Cobrança** — abre ordem de serviço, renegocia dívida e cadastra cliente **no ERP de verdade**, clicando na tela. `IXC_WRITE_ENABLED` (a trava de boot mais ampla, da "Fase 3A") continua desligada e não deve ser mexida.

As **quatro** operações do catálogo estão implementadas (`lib/platform/ixc-write-service.ts`): **segunda via de boleto** (`POST /webservice/v1/get_boleto`), **abertura de OS** (`POST /webservice/v1/su_oss_chamado`), **renegociação de dívida** (wizard de 5 passos) e **cadastro de cliente** (`POST /webservice/v1/cliente`).

O cadastro de cliente só nasce de um **lead ganho** do funil (issue #17) — era o gatilho que faltava, e sem ele um cadastro novo não teria origem. Antes de gravar, o documento é conferido pelos dígitos verificadores (`lib/platform/document-check.ts`) e o IXC é consultado pelo CPF/CNPJ: **duplicar cliente é dois fluxos de fatura e um contrato órfão**, e apagar cadastro com contrato pendurado não é opção. O documento fica gravado no IXC **com máscara**, igual ao telefone — a busca tenta os dois formatos, senão o "não existe" seria falso e autorizaria a duplicata.

⚠️ `cidade` e `uf` no cadastro são **códigos internos do IXC** (o cadastro 21857 tem `cidade: "1759"`, `uf: "28"`), não nomes nem IBGE. Por isso vêm de lista lida do ERP, nunca digitados.

⚠️ **A renegociação não é atômica, e isso muda como ela falha.** O primeiro passo (`renegociar_selecionados`) **já cria o registro no ERP** e devolve `id_renegociacao`; os passos seguintes calculam juro/multa e finalizam. Se algo falhar no meio, o cliente fica com uma renegociação pela metade grudada nas faturas reais, e a API do IXC não tem endpoint de desfazer. Por isso o ledger grava o `id_renegociacao` e o passo alcançado, com o detalhe começando em `PENDENTE DE CONFERÊNCIA MANUAL`. Um `failed` seco ali esconderia um rastro que ficou no ERP.

Nenhum valor é calculado por nós: o total é a soma das faturas lidas do IXC e o acréscimo é o que o próprio IXC devolve em `calcula_juros_multa`. `valor_descontos` é sempre `"0,00"` — conceder desconto é justamente o que o projeto se recusa a automatizar, e o pipeline do agente já transborda para humano nesse caso.

Quem dispara precisa reenviar o **total que viu na tela**; se não bater com o que o IXC devolve naquele instante, a operação é recusada. Tela com dado velho não renegocia.

Toda escrita passa pela mesma régua, nesta ordem: idempotência → política → `FEATURE_IXC_WRITE` → chamada. Bloqueio também entra no ledger `ixc_write_operations`: auditoria existe para provar decisão, não só sucesso.

⚠️ **Assunto, setor e filial não são constantes.** A base da BBNET tem **159 assuntos** (`su_oss_assunto`), **12 setores** (`empresa_setor`) e **21 filiais** (`filial`), com ids salteados. Assunto e setor são validados contra a lista lida do ERP no momento da chamada; a filial vem do `filial_id` do cadastro do cliente. Fixar qualquer um desses números abriria chamado real na fila errada — ou na empresa errada do grupo. `scripts/ixc-probe-os-catalog.mjs` foi o que levantou esses números antes de existir código.

⚠️ **O IXC recusa com HTTP 200 e `type: "error"` no corpo.** Sem checar isso, uma recusa viraria "sucesso" no ledger e ninguém iria atrás da OS que não existe.

O formato da **resposta de sucesso** das duas operações não está confirmado (a coleção Postman não tem exemplo salvo e nenhuma foi executada em produção). Por isso o ledger guarda a resposta crua em vez de campos inventados.

## Auditoria do que a IA faz

A auditoria cobria bem **ação de gente** (login, escrita no ERP, gestão de usuários) e quase nada de **ação da IA**. O teste que importa é: um cliente reclama *"a IA me disse X"* — dá para responder o quê?

Hoje, para cada atendimento do canal, ficam registrados:

| Campo | Onde | Por quê |
|---|---|---|
| `correlationId` na mensagem | `channel_messages` | Liga o rastro de auditoria à **frase exata**. Antes só dava para casar por conversa e horário, que é aproximação |
| `intentSource` (`llm`/`rules`) | `conversation_outcomes` | O fallback para a regex é **silencioso de propósito**; sem registrar quem decidiu, ninguém explica depois por que a IA entendeu o que entendeu |
| `intentConfidence` (0–100) | `conversation_outcomes` | Inteiro, não float — auditoria não precisa de casa decimal |
| `intentModel` | `conversation_outcomes` | Qual modelo, quando foi o modelo |
| `appVersion` | `conversation_outcomes` | Mudar o prompt não pode tornar o passado inexplicável |

⚠️ **Campo nulo significa "não registrado", e a tela diz isso.** Conversa anterior a estas colunas existirem não tem como ser preenchida; mostrar `rules` ou `0%` no lugar seria inventar um fato de auditoria — o oposto do que ela serve para fazer.

O registro do canal passou a dizer **"Resposta ENVIADA ao cliente: «...»"** quando de fato sai. Antes dizia "Mensagem recebida", que descrevia a metade inofensiva e calava a outra. O texto passa por `sanitizeHandoffText` mesmo sendo texto nosso: a auditoria é lida por quem não participou do atendimento, e a regra não abre exceção para "este caso não tem dado pessoal".

A ficha aparece **ao lado da conversa** em Atendimentos (`ConversationAuditPanel`), com o `correlationId` para procurar a linha exata em Administração → Auditoria.

⚠️ A ordem era: auditoria → reescrever os textos → ligar o envio. Os dois primeiros estão feitos — o canal usa as respostas aprovadas, não o texto de homologação. A fila de fato passou a existir (ver *Responsável e fila* abaixo): conversa com responsável humano não recebe resposta automática, e a promessa "um atendente retorna" tem onde cair.

**A rota da Meta (`/api/channels/meta`) envia de verdade.** Antes, com `FEATURE_N8N_AUTOREPLY` ligada, a resposta da IA era gravada como `role = agent` sem nenhuma chamada à Cloud API — o cliente não recebia e a tela afirmava que sim. Agora (`lib/platform/meta-auto-reply-service.ts`, reaproveitando `sendTextMessage`), com a flag ligada e ninguém com a conversa, a resposta sai pela Meta e só vira `agent` se a Meta aceitar, com o `wamid` do envio em `external_message_id` para o recibo de entrega casar e `sent_by = 'ia'` (a tela mostra "IA" e o recibo). A régua é a da resposta do atendente: política → idempotência → chamada.

- **Janela de 24 horas** conta da hora da mensagem que vem no webhook, não da chegada: a Meta reentrega por dias. Sem essa hora, não envia.
- **Idempotência pelo `wamid` do cliente**: a chave `autoreply:<wamid>` é reservada em `channel_idempotency_keys` **antes** de chamar a Meta. Reentrega não reenvia; se o envio saiu e a gravação caiu, a reentrega grava o que saiu em vez de mandar de novo.
- **Falha degrada, não mente**: recusa da Meta, bloqueio ou timeout viram **sugestão** (sem a pergunta de avaliação), com desfecho `suggested`, e ganham linha própria na auditoria (`whatsapp.autoreply.failed` / `whatsapp.autoreply.blocked`). Em timeout a reserva fica, porque a mensagem pode ter saído.

**A resposta automática é primeira resposta, não atendimento.** As respostas aprovadas são fixas e quase todas prometem um atendente ("Vou pedir para um atendente enviar a segunda via"). Sem as regras abaixo, ligar a flag faria a IA prometer um humano e, no mesmo gesto, tirar a conversa da fila — ninguém seria chamado. Por isso, só na rota da Meta:

- **A conversa continua na fila** até um humano responder: a resposta da IA não conta como resposta em `awaitingSinceFrom` (`conversation-state-shared.ts`), como a sugestão já não contava. A espera é medida desde a fala do cliente, não desde o recebido da IA.
- **Uma por espera** (`autoReplyUsed`): depois que a IA respondeu, as próximas falas do cliente viram sugestão até um atendente responder ou resolver a conversa. Sem isso o "ok, obrigado" do cliente ganhava "Pode me contar o que você precisa?". Histórico ilegível conta como "já respondeu".
- **Sem pergunta de avaliação**: "um atendente retorna… antes de encerrar, avalie" se contradiz.
- **Não conta como resolvido**: o pipeline diz `simulated` (segunda via, PIX, pagamento, chamado) ou `resolved`, e os dois entram em "resolvido sem humano". Resposta que saiu com esses desfechos é gravada como `replied` ("Primeira resposta da IA"). `handoff`, `waiting_customer` e `blocked` ficam como estão.

A rota da **Evolution** nunca responde sozinha, com ou sem a flag — ela não tem envio, e a Evolution não é mais usada. A rota do n8n segue o contrato antigo: devolve `response` para o fluxo enviar, grava sem autor e com as regras antigas (avaliação e desfecho do pipeline).

**Responsável e fila** (`lib/platform/conversation-state-shared.ts` e `conversation-state-service.ts`, tabela `conversation_states`). O modelo é o das caixas de entrada de suporte (Chatwoot, Intercom, Front): a conversa está **aberta** ou **resolvida**, e aberta pode ter um **responsável** humano. Sem linha gravada = aberta e sem responsável, ou seja, com a IA. As ações são assumir, devolver para a IA, resolver e reabrir (`POST /api/conversations/state`, permissão `support.write`), cada uma auditada com quem fez e de quem era a conversa. Tomar a conversa de um colega responde 409 e só acontece com confirmação (`takeOver`). Ação que não muda nada não grava linha.

- **Reabrir é derivado, não gravado**: resolvida que recebe fala do cliente depois de `resolved_at` está aberta e sem responsável (`effectiveState`). Gravar isso exigiria que o canal de entrada escrevesse no estado a cada mensagem — e um canal que falha no meio deixaria cliente esperando numa conversa "resolvida".
- **A IA não fala por cima de humano**: as rotas da Meta e do n8n só passam `autoReply` se ninguém estiver com a conversa (`botMayReply`; a da Evolution nunca passa). Estado ilegível conta como "tem humano": na dúvida, a IA só sugere. Hoje não muda nada visível, porque a resposta automática está desligada — é a trava que precisava existir antes de ligá-la.
- **Envio humano coordenado**: atribuição auditada e reserva durável confirmam antes do transporte. Bot e mutações respeitam a reserva. Resultado incerto mantém bloqueio para reconciliação explícita; replay não reassume a conversa. O caminho delegado n8n retorna apenas sugestões até dispor de protocolo coordenado de confirmação.
- **A fila conta só o que dá para responder** (`needsReply`): cliente falou por último, conversa aberta e **dentro da janela de 24 horas**. É a mesma régua no menu, no título da aba, no Início e na aba "Fila" de Atendimentos. Antes o menu mostrava "2 aguardando" por conversas de dez dias, que nem texto livre aceitavam mais.

**Triagem e atendimento com protocolo** (`lib/platform/triage-service.ts`, regras em `triage-shared.ts`, tabela `support_tickets`). É a fase 1 do plano de atendimento por IA (triagem → autoatendimento → dúvidas pela base), copiada do que os bots de provedor fazem — o Opa! Suite da própria IXC, SimplesDesk, Talqui: a IA entende o assunto, pergunta quando não tem certeza e entrega ao setor certo com a ficha pronta. Corresponde aos passos 1 e 2 do fluxo de manutenção da BBNET ("registro do chamado"). Só na rota da Meta.

- **Atendimento ≠ conversa.** A conversa com um número dura para sempre; o atendimento começa na primeira fala depois do último fechamento e termina quando alguém **resolve** a conversa ou o cliente fica **24 horas calado** (`closed_reason` `resolved` / `inactivity`). Um aberto por conversa, garantido por índice único parcial — duas mensagens juntas não abrem dois.
- **Protocolo** `AAAAMMDD` (Brasília) + sequencial de 6 dígitos (`seq`, serial do banco). Vai no fim da **primeira** resposta do atendimento; `protocol_sent_at` registra quando chegou de fato ao cliente. No modo observação ele vai no rascunho sugerido ao atendente. Se não gravar, o atendimento segue e a tela diz "não gerado". O IXC tem atendimentos com protocolo próprio (`su_ticket`), mas **o protocolo que vale é o do LZR HUB** (decisão do Vinícius, 14/10/2026).
- **Identificação uma vez por atendimento**: `findCustomerByPhone` (exatamente um cadastro ou nada) roda ao abrir e só repete se o IXC não respondeu. A captação de lead usa esse resultado (`knownCustomer`) em vez de consultar de novo — antes ela consultava o IXC **a cada mensagem** de quem já era cliente. Do IXC só fica o código do cliente.
- **Pergunta do assunto**: com resposta automática ligada, confiança abaixo de 0,6 ou "informação geral" → a IA manda o menu numerado (`TRIAGE_MENU`, texto puro como o da IXC, não lista interativa). A resposta "3" vira o assunto com `intentSource = menu`, sem passar pelo classificador. Pergunta **uma vez** por atendimento; resposta vaga a ela segue para o setor. A resposta à pergunta é a exceção da regra "uma por espera" (`afterClarification`) — senão a pergunta seria um beco. No modo observação nada é perguntado.
- **Setor** (`queueForIntent`): `tecnico`, `financeiro`, `comercial` (planos e cancelamento — retenção) ou `atendimento`. É o mesmo rótulo de fila (`queue`) que Equipes usa. Só classificação confiante ou escolha no menu troca o setor: o "ok, obrigado" do fim não muda nada.
- **Assunto novo `sales_inquiry`** (Planos e contratação): o fluxo de instalação começa num lead pelo WhatsApp e não havia assunto para isso. Vem depois de lentidão na regex — "meu plano de 100 mega está lento" continua sendo lentidão.
- **Na tela**: ficha "Atendimento" na aba Cliente (protocolo, setor, assunto, etapa, identificação), chip de setor na lista e filtro por setor.
- Tabela fora do ar não derruba o canal: `startTriage` devolve `undefined` e a mensagem segue sem protocolo nem menu.

**Autoatendimento (fase 2), começando pelo diagnóstico de conexão** (`connection-diagnosis-shared.ts`, leitura em `getServiceDiagnosis` do provider do IXC). Em atendimento técnico (sem internet, lenta, Wi-Fi, reinício) de cliente **identificado**, depois da resposta, o LZR lê do IXC o login (`radusuarios.online`, última conexão, motivo da queda), o contrato (`status_internet`, `desbloqueio_confianca_ativo`) e as OS não finalizadas — **três consultas**, contra as ~15 do `getSnapshot` — e cruza com as massivas registradas na tela pelo bairro do login. Sai um veredito (bloqueado / sem conexão / conexão ativa / inconclusivo) com o próximo passo: bloqueio por atraso → financeiro e desbloqueio de confiança possível; massiva no bairro → avisar, sem OS individual; OS já aberta → acompanhar, não abrir outra; offline → reinício guiado e depois OS; online → Wi-Fi e aparelhos. Grava em `support_tickets.diagnosis` **uma vez por atendimento** (limite por minuto do IXC) e aparece na ficha "Atendimento". Teto de 6 s (`DIAGNOSIS_BUDGET_MS`): IXC lento deixa sem diagnóstico, não prende o webhook. **Ainda é observação: a IA não diz nada disso ao cliente.** `status_internet` traduzido só para os códigos conhecidos (`A`, `D`, `CM`, `CA`, `FA`, `AA`); o resto aparece como "código X". Provado contra o IXC real em `scripts/ixc-probe-diagnosis.mjs` (695 ms, cadastro de teste offline → "reinício guiado e depois OS").

O que as sondagens (`scripts/ixc-probe-self-service.mjs`) e a coleção Postman oficial confirmaram para os próximos autoatendimentos:

- **Cadastro de teste para escrita**: Wendel Mendonça, código **21857**, login **`copadomundo2026`** (contrato 48882) — autorizado pelo Vinícius. Escrita de teste só nele; o script confere o nome antes de agir.
- **Desbloqueio de confiança**: `POST /webservice/v1/desbloqueio_confianca` com `{ "id": <contrato> }`. Com o contrato ativo o IXC recusa com HTTP 200, `type: "error"` e "Não é possível utilizar o botão 'Desbloqueio de confiança' quando o contrato estiver ativo." — e nada muda no contrato. A regra é do IXC; o formato de **sucesso** só se prova com o contrato de teste bloqueado.
- **PIX**: `POST /webservice/v1/get_pix` com `{ "id_areceber": <fatura> }`. **Provado** na fatura de teste 2098068 (16/11/2026): `type: "success"`, código em `pix.dadosPix.pixCopiaECola` (igual a `pix.qrCode.qrcode`), validade em `expiracaoPix`. A primeira chamada gera a cobrança no banco; as seguintes devolvem a mesma. ⚠️ A resposta traz `devedor.cpf` e `devedor.nome`: `fetchPixCode` (`write-client.ts`) devolve só código e validade. Fatura de gateway (o caso da BBNET) é **avulsa** (`id_contrato = 0`, ligada por `id_contrato_avulso`): filtrar fatura por contrato não a acha — por cliente, sim. O `gateway_link` da fatura é a página de 2ª via do banco e carrega o CPF no caminho: não gravar.
- **2ª via pede CPF** antes de mostrar qualquer dado financeiro (decisão do Vinícius): o telefone sozinho não basta.

**Segunda via com confirmação do titular** (`invoice-self-service-shared.ts`; passos em `invoiceSteps`, em `triage-service.ts`; coluna `support_tickets.self_service`, migração 0021). O segundo autoatendimento.

- **Quem é conferido**: o CPF (ou CNPJ) precisa ser o do cadastro que o **telefone da conversa** já identificou. Número sem cadastro único no IXC não entra no fluxo — vai para o financeiro como antes. CPF sozinho, vindo de qualquer número, não basta: CPF vaza com facilidade. Afrouxar isso é uma decisão a tomar com a BBNET, não um ajuste.
- **O passo a passo** (com resposta automática ligada): assunto de fatura ou PIX → a IA pede o CPF (`ASK_CPF_TEXT`) → o cliente manda → confere (dígitos verificadores, depois o documento do cadastro, que o IXC grava **com máscara**) → lê as faturas em aberto (`listOpenInvoicesOf`, mesmo filtro do "Financeiro do cliente" da IXC: liberada e status `A`). CPF já na primeira mensagem confere na hora. A resposta ao pedido do CPF é tratada **antes do classificador** (`intercept`, `intentSource = flow`) — o documento nem chega ao modelo — e é exceção à regra "uma por espera" (`awaitingAnswer`).
- **Erro de digitação**: pede de novo uma vez; na segunda, passa para o atendente. Número de 11 dígitos que não fecha como CPF só conta como "CPF errado" se a IA pediu o CPF — fora disso pode ser um telefone com DDD.
- **IXC lento ou fora do ar** responde "não consegui consultar", nunca "não confere": acusar o cliente de errar o próprio CPF por falha nossa seria mentir para ele. Teto de 6 s por consulta.
- **O CPF não é gravado** em lugar nenhum do atendimento: só a etapa (`awaiting_cpf`, `invalid_cpf`, `verified`, `mismatch`, `unavailable`), as tentativas, as faturas e o rascunho.
- **O que sai para o cliente**: com `FEATURE_AI_INVOICE` desligada (hoje), a IA confirma o titular e diz que um atendente envia a segunda via; a ficha "Atendimento" mostra as faturas, se o PIX foi gerado e o rascunho com botão **Usar como rascunho**. Ligada, a IA manda o rascunho: vencimento, valor, situação e o **PIX copia e cola** da fatura que vence primeiro (linha digitável só como reserva, quando não há PIX). O PIX é pedido **só depois** do titular confirmado e só dessa fatura; se o `get_pix` falhar, a conferência continua valendo e o rascunho sai sem o código. **O código PIX sai numa mensagem só dele** (`splitPixCode`, no envio pela Meta), depois da explicação "copie e cole no app do banco, na opção Pix Copia e Cola (não é link)": copiar uma mensagem do WhatsApp leva a mensagem inteira, e com o texto junto o banco recusa — no backup de Itabaiana a atendente manda o código sozinho ~3 mil vezes, e cliente achava que era link.
- **Modo observação**: nada é pedido ao cliente. Se ele mandar o CPF por conta própria (ou porque o atendente pediu), a conferência roda e a sugestão já vem com a fatura.
- Provado contra o IXC real em `scripts/ixc-probe-invoice.mjs` (cadastro de teste: documento com máscara, titular confirmado em ~0,5 s, fatura de R$ 4,99 achada, PIX copia e cola gerado; CPF de outra pessoa → não confere sem ler fatura).

**Fora do horário comercial** (`FEATURE_OFF_HOURS_AUTOREPLY`; horário em `triage-shared.ts`: `isBusinessHours`, `nextOpeningText`). Ideia da BBNET: no horário, gente (e, no futuro, o robô do n8n); fora dele, triagem pelo WhatsApp com respostas certas, sem esperar ninguém aceitar sugestão. A rota da Meta calcula `botSpeaks = FEATURE_N8N_AUTOREPLY || (FEATURE_OFF_HOURS_AUTOREPLY && fora do horário)`, e o modo fora do horário só muda algo quando a IA de fato fala.

- **Abertura em lista clicável** (`sendInteractiveList`, `TRIAGE_LIST`): "Sou a assistente virtual… atendimento com pessoas de segunda a sexta… volta amanhã às 8h" + botão "Ver assuntos". A Meta corta título de opção acima de 24 caracteres, por isso `TRIAGE_MENU` tem `title` curto além do `label`. A escolha chega pelo título (ou pelo número digitado). O histórico guarda o texto e as opções numeradas, para o atendente ver o que o cliente viu. Só aparece quando a IA não tem certeza do assunto: "estou sem internet" vai direto à resposta.
- **Toda resposta fora do horário** termina com quando o atendimento com pessoas volta (`offHoursNote`): a promessa "um atendente retorna" ganha data. O protocolo só conta como informado se esteve no rodapé daquela resposta.
- **Sem internet responde pelo diagnóstico** (`diagnosisReply`), feito antes da resposta quando a IA fala sozinha: bloqueio por atraso → diz o motivo e **já pede o CPF** (entra no fluxo da 2ª via e termina no PIX); bloqueio manual → um atendente confere; massiva no bairro → avisa a instabilidade; OS aberta → informa o nº do chamado; conexão chegando ao equipamento → Wi-Fi e aparelho. Offline sem causa conhecida segue a resposta aprovada (reinício). Nenhum texto afirma ação que não aconteceu.
- **Feriado é fora do horário** (`holidayName`): os nacionais fixos (inclusive 20/11), a Emancipação de Sergipe (8/7) e os móveis pela Páscoa — Sexta-feira Santa, e também Carnaval (seg e ter) e Corpus Christi, que são ponto facultativo: na dúvida é melhor a IA responder num dia com gente do que o cliente ficar sem resposta num dia sem. A abertura diz "Hoje é feriado (…)" e a data de volta pula o feriado. **Municipal varia com a cidade** e fica em `BUSINESS_HOLIDAYS` (`MM-DD` para todo ano, `AAAA-MM-DD` para um só, separados por vírgula) — sem isso, o feriado da cidade conta como dia de gente.
- **Dentro do horário, o robô de dúvidas** (`doubt-bot-service.ts`, `FEATURE_N8N_BOT`): só para `general_information` e `sales_inquiry` com trecho na base; fatura, bloqueio, sem internet, OS e cancelamento não passam por ele. O n8n recebe texto sanitizado e devolve texto — não tem a Meta nem o IXC; o LZR confere (`checkBotAnswer`: sem PII, link, "já abri…") e envia pelas mesmas travas da resposta automática. Uma por espera. Falha → sugestão + `whatsapp.doubtbot.failed`.
- Para a IA mandar a fatura sozinha também é preciso `FEATURE_AI_INVOICE`.

**Modo autônomo** (`FEATURE_AI_AGENT`, pedido do Vinícius em 17/11/2026: "quero que ela mesma responda a pessoa"; em 18/11: "deixa suspenso mandar para a atendente — a IA resolve, faz a triagem e deixa o mais lapidado possível o que a pessoa quiser"). Liga a IA a qualquer hora (`botSpeaks`) e troca a regra "uma por espera" por **conversa** (`conversational` em `metaAutoReplyOptions`):

- **A IA conduz cada assunto pelo roteiro** (`lib/platform/agent-playbook-shared.ts`, `agentTask`): técnico (luzes da ONU — LOS vermelha = técnico, PON piscando = esperar —, reinício certo, Wi-Fi 2,4/5 GHz, e visita técnica quando não resolve), visita/equipamento, cancelamento (motivo, alternativa **uma vez**, sem insistir, horário), comercial (cliente novo: nome, endereço com referência, uso; mudança de plano ou de endereço), "quero falar com atendente" (pergunta o assunto antes), reclamação, desconto (não concede, registra o motivo), pagamento e desbloqueio, fatura de número sem cadastro (pega o nome do titular). Fontes: o roteiro da BBNET e a prática de suporte N1 de provedor de fibra. O modelo devolve `state`: `ongoing`, `resolved` ou `request_complete` com a **ficha** (`summary`).
- **Pedido pronto** (`request_complete`): a ficha é gravada em `support_tickets.intake` (migração 0023, sanitizada — sem CPF, e-mail, telefone) **antes** de a confirmação sair; o rodapé diz "Seu pedido ficou registrado no protocolo X, e a equipe de <setor> dá continuidade ainda hoje / amanhã às 8h, por aqui" (`requestFooter`); o atendimento vai para `stage = handoff` e a conversa fica na fila, com a ficha no painel "Atendimento" ("Pedido registrado pela IA").
- **O assunto do atendimento guia a conversa**: resposta curta no meio da triagem ("de manhã", "sim") não troca o roteiro — só classificação confiante ou escolha no menu troca (`topic` no canal; `context()` na triagem). A IA lê até 12 falas.
- **Diagnóstico como dado**: no modo autônomo o diagnóstico roda antes da resposta e vai ao modelo como DADOS DO SISTEMA; resposta fixa pelo diagnóstico só para bloqueio, massiva e OS já aberta. O diagnóstico agora lê o **sinal óptico da ONU** (`radpop_radio_cliente_fibra`: `sinal_rx`, `data_sinal`; operação `getFiberSignal`, quarta consulta): acima de -25 dBm bom, -25 a -27 limite, abaixo de -27 crítico (técnico, não reinício), `0.00` = sem leitura. Medido em 18/11: 20.389 ONUs, leitura de minutos atrás, a maioria entre -17 e -25 (`scripts/ixc-probe-fiber-signal.mjs`).
- **A IA abre a OS** (`lib/platform/ai-service-order.ts`, `FEATURE_AI_SERVICE_ORDER`): pedido técnico pronto de cliente identificado → relê o IXC na hora (OS já aberta? informa o número e não abre outra; contrato ativo único; login; filial) → `requestServiceOrderOpen` com chave `ai-os:<atendimento>` (uma OS por atendimento, mesmo com o webhook reentregue), `requestedBy = ia@lzr-hub`, ficha sanitizada na mensagem da OS → auditoria `ixc.write.service_order_open`. O cliente só ouve "Abri a ordem de serviço nº X" com o número que o IXC devolveu; qualquer outro desfecho vira "Seu pedido ficou registrado". Assuntos do questionário do Vinícius (18/11): 14 SEM FUNCIONAR/EQUIPE CARRO, 116 SUPORTE INTERNET LENTA, 118 SUPORTE INTERNET COM QUEDA, 49 TROCAR ONU OU ROTEADOR; setor 1; mudança de endereço e cancelamento sem OS automática. **Todo pedido técnico pronto vira OS** (Vinícius, 27/11: "o que ela não conseguir resolver gera OS"): visita técnica e chamado técnico também, com o assunto tirado da ficha — roteador com defeito/troca 49, quedas 118, lentidão 116, o resto sem internet (14/9). Em 27/11 "sem internet, luz vermelha, fio no poste" fechou como visita e nenhuma OS saiu, sem rastro; agora pedido técnico sem OS (mudança de endereço) grava o motivo na ficha. **Telefone que não identifica não impede a OS** (27/11): o número da Estefany estava em 7 cadastros (o dela e órgãos municipais de que ela é contato) e a regra "exatamente um ou nada" a deixava sem OS. Agora a identificação distingue `not_found` de `ambiguous` (`matchCustomerByPhone`), e no pedido técnico pronto sem cadastro certo a IA pede o CPF (`SERVICE_ORDER_CPF_TEXT`, `selfService.purpose = service_order`): CPF cujo cadastro tem o telefone da conversa → `identified`; CPF de cadastro sem o telefone (número fora do IXC ou de outro cadastro) → `cpf_only`, que **só vale para a OS** — fatura e desbloqueio continuam exigindo telefone e CPF do mesmo cadastro (`customerByDocumentWithPhone`). O CPF não é gravado ("[documento omitido]"). Todo desfecho da OS (aberta, já existia, aguardando CPF, motivo de não abrir) aparece na ficha "Pedido registrado pela IA". **Cliente com mais de um contrato ativo** (casa e escritório, 27/11): antes bloqueava; agora, em sem internet, a OS vai para o contrato cuja conexão caiu (e, no contrato, para o login que caiu). Sem como saber (as duas caídas, nenhuma, ou lentidão/quedas/Wi-Fi, que não aparecem no login), a IA pergunta "em qual endereço está o problema?" com a lista numerada (`contractChoiceText`, `selfService.step = awaiting_choice`) e abre no escolhido. A lista só vai a titular provado pelo telefone (`allowChoice`): identificado só pelo CPF, o número não é do cadastro e não recebe endereços — vira ficha. Mais de 5 contratos: ficha. **OS igual à de atendente (24/11, medido no registro de inserção de 26 OS de 9 atendentes):** a API não grava o que a tela grava, então o LZR manda: endereço (`endereco`, `bairro`, `id_cidade`, `complemento`, `referencia`, lat/long) pela fonte que o login manda (`endereco_padrao_cliente` S cliente / C contrato / N login) e no molde do assunto (`formato_endereco`, lido do IXC); `liberado = 1`, `impresso = N`, `status_assinatura = A`, `gera_comissao = S` (comissão do assunto é R$ 0,00); `melhor_horario_agenda` M/T/Q pelo que o cliente disse; `protocolo` = protocolo do LZR. **Moto ou carro**: poste/telhado (fio caído ou rompido, LOS vermelha, fibra abaixo de -27 dBm) → carro; dentro de casa → moto; sem saber → carro. Sem internet vira **9 SEM FUNCIONAR/TÉC. MOTO** ou **14 SEM FUNCIONAR/EQUIPE CARRO**. **Técnico** pela tabela `technician_routes` (cidade → moto/carro, no banco porque tem nome de funcionário e o repositório é público; `GET/PUT /api/admin/technician-routes`, `users.manage`): cidade sem o tipo manda para o outro (menos poste para moto), sábado moto e carro fazem o que não precisa de poste, menos OS aberta primeiro e alterna no empate (`technician_route_state`); cidade sem linha (Itabaiana) → sem técnico, o setor distribui. Regras em `os-dispatch-shared.ts`. A mensagem ao cliente diz que o técnico liga antes de sair. ⚠️ **Reserva cliente+assunto** (`service_order.scope`, de 16/11) nunca era liberada: depois da primeira OS, o LZR não abria outra do mesmo assunto para o cliente. Agora ela guarda o nº da OS e só a IA a aposenta (renomeia, com rastro) quando o IXC confirma essa OS fechada; a tela segue como antes. ⚠️ No log do IXC as OS do LZR aparecem com operador **"Seenet"**: a ponte usa o usuário de webservice do SeeNet — falta um usuário próprio do LZR. **Lições do SeeNet aplicadas em 24/11** (o SeeNet executa OS; o LZR abre — o que vale aqui): (1) contrato e login lidos **com prova de lista completa** (`listActiveContracts`, `listContractLogins`) — o diagnóstico lê só 5 de cada, e no cadastro 24088 os 5 eram inativos com 7 ativos fora da página; mais de um ativo ou lista incompleta → `blocked`, ficha para a equipe; vários logins no contrato → só o único online, senão `blocked` nos assuntos que exigem login (14, 49); (2) "já existe OS" só conta OS aberta da **família técnica** (14, 116, 118, 49) — OS antiga de cobrança ou retirada não é o chamado do problema e bloquearia para sempre; (3) **releitura** (`reconcileServiceOrder`) antes de dizer "Abri a OS nº X": sem confirmar cliente e contrato no IXC, vira `unknown` e o cliente ouve "pedido registrado". Endereço: `origem_endereco = "L"` faz o IXC resolver o endereço pelo login (OS 301399 sai com os campos de endereço vazios e aponta para o login) — a armadilha do SeeNet (`endereco_padrao_cliente` S/C/N) era do app dele resolvendo sozinho.
- **Modelo da conversa**: o n8n chama a **OpenAI `gpt-5.4-mini`** (credencial "Chatgpt", chave do Breno, 18/11). Escolhido contra `gpt-4.1-mini` (fechava o pedido sem perguntar o período) e `gpt-5-mini` (lento): seguiu o roteiro em 5 atendimentos completos, 1,4–4,2 s por fala. A Groq gratuita não aguenta o modo autônomo: 8.000 tokens/min e 1.000 pedidos/dia **por modelo, na conta inteira**, e cada fala gasta ~1.500–2.500. **Classificador e copiloto também no ChatGPT** (decisão do Vinícius, 18/11: "quero apenas o ChatGPT"): com `OPENAI_API_KEY` no ambiente, `llmProviderFromEnv` usa a OpenAI com `gpt-5.4-mini` (12/12 mensagens reais certas, até 1,1 s; o único que entendeu "paguei ontem e continua cortado" como pagamento). A família gpt-5 recusa `temperature` (`completionLimits`). A Groq fica só como legado, se `OPENAI_API_KEY` faltar.

- **Como a IA fala** (`STYLE` em `agent-playbook-shared.ts`, vai antes de toda tarefa): se apresenta como "o suporte da BBNET" (só diz que é assistente virtual se o cliente perguntar), frases curtas, sem termo técnico (LOS/ONU/PON viram "caixinha da internet" e "luzinha vermelha"), uma pergunta por vez e nunca repete o que o cliente já respondeu. A abertura do menu também é "Aqui é o suporte da BBNET". **Áudio**: com `FEATURE_AUDIO_TRANSCRIPTION` o áudio vira texto (`lib/integrations/meta/media.ts` baixa, só de domínio da Meta e até 4 MB; `lib/integrations/openai/transcription.ts` transcreve); sem ela, ou se a transcrição falhar, a IA responde pedindo para escrever (`AUDIO_REPLY`, na rota da Meta). Falha de transcrição vai para a auditoria (`whatsapp.audio.transcription_failed`).
- **Quando termina**: assunto resolvido (`state = resolved` e mensagem entregue) **fecha o atendimento** (`closeTicket`) — a próxima fala abre outro, com protocolo novo. Pedido registrado (`request_complete`) deixa o atendimento aberto para a equipe; depois disso "ok"/"sim"/"obrigado" são despedida (cortesia, sem ir ao modelo, conversa continua na fila) e um segundo `request_complete` do modelo não registra nem confirma de novo ("Já está anotado").
- **Cada fala** passa pelos fluxos de sempre (CPF → fatura → PIX, diagnóstico, menu na primeira fala vaga) e, no lugar da resposta aprovada fixa, pelo **robô da base** (n8n, `doubt-bot-service.ts`) — qualquer assunto, menos os que exigem gente (`AGENT_HUMAN_INTENTS`: pedido de atendente, cancelamento, reclamação, desconto, pedido não autorizado) e fatura/PIX (`AGENT_FLOW_INTENTS`, que só saem pela conferência do titular). O robô recebe o **documento inteiro**, não um parágrafo: com um parágrafo ele repetia o primeiro passo a quem já tinha reiniciado.
- **Passar ao atendente** (`stage = handoff` no atendimento): quando a resposta promete gente (`promisesHuman`: "um atendente…") ou o assunto exige. Daí a conversa **fica na fila** até alguém assumir, clicar **Devolver à IA** (`resumeTicketForAi`) ou o atendimento fechar — mas a IA **continua ajudando** (base, autoatendimentos, cortesia), só sem tirar a conversa da fila e sem repetir a resposta aprovada, que vira sugestão (`doubtBot.handedOff`). Calar a IA de vez deixava o cliente falando sozinho até o dia seguinte. **Não** passam a conversa (`AGENT_KEEPS_TALKING`): "não entendi" (um "obrigado" calaria a IA) e recusa de pedido não autorizado — em 17/11 o "qual meu CPF?" calou a IA e o "quero ajuda na internet" seguinte ficou sem resposta.
- A busca pelo assunto classificado ignora `general_information`/`out_of_scope`: "informação geral" casava todo documento da categoria "Geral" (a padrão da tela).
- **Fila**: resposta que atendeu é gravada com `sent_by = 'ia-agente'` e **tira a conversa da fila** (`awaitingSinceFrom`); a que passou ao atendente continua `ia` e a conversa fica na fila, como a primeira resposta sempre ficou. A tela mostra "IA" nas duas.
- "obrigado"/"ok" ganham cortesia (`courtesyReply`), não o menu. Fora do horário, o aviso "o atendimento com pessoas volta…" sai só quando a IA passa ao atendente — a cada fala ele se repetiria.
- **Fora do horário a IA atende sozinha e não repassa** (Vinícius, 25/11/2026: "24/7; se houver necessidade, no horário de seg a sexta até as 18; após o horário ela atende só e não repassa pra ninguém"). O roteiro recebe `OFF_HOURS` (`agent-playbook-shared.ts`, via `context().offHours` da triagem): não há atendente, nunca prometer nem transferir, pedido de pessoa vira "agora o atendimento é por aqui, qual o assunto?". O que só a equipe executa continua como `request_complete`, e o rodapé diz quando ela dá continuidade. No horário, nada muda. Conversa já na fila: no horário, cumprimento e pedido de liberação ficam guardados sem resposta (decisão do Breno, 24/11, para não repetir ação antiga); **fora do horário a IA responde** com o protocolo e quando a equipe continua (pedido de liberação ganha também "escreva segunda via que eu mando o PIX").
- **Senha do Wi-Fi**: "traga o roteador e a fonte à loja ou agende uma visita" (migração `0027_kb_senha_wifi`, que só troca o texto se ele ainda for o original de 0022) — cada cidade e cada cliente têm exceções. Troca remota fica para quando o ACS for integrado.
- Humano com a conversa (assumiu ou respondeu pela tela) continua mandando: a IA não fala por cima, em nenhum modo.
- **Base inicial**: migração `0022_seed_knowledge_base` cria 19 documentos publicados (horário, sem conexão com luz LOS e reinício, lentidão, Wi-Fi, senha, segunda via, já paguei, bloqueio e desbloqueio de confiança, formas de pagamento, planos, mudança de endereço, titularidade, visita técnica, protocolo, quedas, velocidade contratada pela Resolução Anatel 765/2023, aplicativo específico, roteador novo). **Sem preço, endereço, telefone ou link**: o que é da BBNET e não estava confirmado fica com "um atendente informa". Editáveis na tela; `ON CONFLICT DO NOTHING` não ressuscita documento apagado. Testado contra o n8n de produção com 8 perguntas reais (17/11): responde, guia passo a passo, passa ao atendente quando o cliente já tentou, recusa instrução embutida. A migração `0026_seed_knowledge_backup` acrescenta o que o backup de Itabaiana mostrou faltando: o **aplicativo BBNET SAC** (login e senha = CPF do titular, só números) e **como pagar com o PIX copia e cola**. A `0028_kb_lojas_por_cidade` (Campo do Brito, 25/11) e a `0029_kb_lojas_onze_cidades` (as 11 lojas mandadas pelo Vinícius em 26/11) trazem **onde fica a loja** de cada cidade, **sem telefone** e em até 1.200 caracteres (`AGENT_SOURCE_LIMIT` — o modo autônomo corta o resto; `tests/knowledge-stores.test.mjs` confere): a IA resolve pelo número oficial e só manda à loja o que é presencial (senha do Wi-Fi, titularidade, contrato, devolver aparelho) — regra no `STYLE`. **Itabaiana não tem loja** (`0030`): a linha existe porque o endereço de Frei Paulo é "Rua Itabaiana", e sem ela quem dizia "sou de Itabaiana" podia ser mandado a Frei Paulo. A `0031_kb_planos_valores` (27/11) põe no documento de planos os **5 planos e valores** dos folhetos (300, 700, 1000, Fanáticos 1 Giga e o 1 Giga sem aplicativos a R$ 79,90) — o telefone do folheto fica de fora, e o texto **não diz que o de R$ 79,90 é promocional** (pedido da BBNET; o teste confere). A análise do backup mostrou que 91% do que a central de Itabaiana encaminhava ia para a loja da cidade.
- **Modelo do classificador**: `openai/gpt-oss-20b` na Groq (`DEFAULT_LLM_MODEL`) — o `llama-3.3-70b-versatile` saiu da Groq e, como a falha cai na regex em silêncio, o classificador era só regex. Medido: 12 de 12 mensagens reais certas, 0,3–2 s. Modelo de raciocínio leva `reasoning_effort: low` e teto maior (`completionLimits`).

**Desbloqueio de confiança pela IA** (`FEATURE_AI_TRUST_UNLOCK`; `lib/platform/ai-trust-unlock.ts`, regra em `trust-unlock-shared.ts`). Regra da BBNET (Vinícius, 18/11/2026): (1) a IA **sempre tenta o pagamento primeiro** — manda o PIX e diz que pagando libera na hora; (2) quem **não usou** o desbloqueio no mês passado (nem neste) é liberado; (3) quem usou só é liberado se **aquela vez foi paga em dia**; (4) **fim de semana e feriado** (sem equipe) libera mesmo quando a regra 3 impediria. O modelo só **pede** (`action: "trust_unlock"` + `promised_date`); quem decide é o código: titular confirmado pelo CPF **neste atendimento** (senão pede o CPF e a próxima fala vira a conferência), contrato bloqueado por atraso (`CA`/`FA`; `CM` nunca), regra, uma tentativa por atendimento (`ai-unlock:<atendimento>` no ledger `ixc_write_operations`, operação `contract.trust_unlock`, inclusive o negado) e `POST /webservice/v1/desbloqueio_confianca`. O IXC aplica as regras dele por cima. Dados do contrato: `dt_ult_des_bloq_conf` (último uso), `desbloqueio_confianca_ativo`, e as faturas pagas depois (`pagamento_data` × `data_vencimento`). O cliente só ouve "liberei" quando o IXC aceitou. **Pedido de liberação** (`currentTrustRequest`, trava do Breno de 24/11 contra o modelo agir num "sim" ou "boa noite"): reconhece os jeitos reais de pedir — no backup de Itabaiana a primeira versão pegava 11% das falas com "liberar/desbloquear" e respondia "o que você precisa agora?" a "Pode desbloquear, por favor"; agora pega 41%, e o resto é relato de pagamento ou dúvida ("paguei e não liberou", "pagando já libera?"). Frase que fala de liberação sem pedido claro ganha a pergunta direta `TRUST_CONFIRM_QUESTION`, e o "sim" a ela (até 10 min) vale como pedido.

**Cobrança e avisos de rede pelo WhatsApp** (`lib/platform/outbound-service.ts`, modelos em `outbound-shared.ts`). Fora da janela de 24 horas a Meta só aceita **modelo aprovado**: os 7 modelos (4 de cobrança, massiva, normalização, manutenção) moram no código, categoria UTILIDADE, com o rodapé "Para não receber estes avisos, responda SAIR", e o LZR os cadastra pela API (`GET/POST /api/admin/whatsapp-templates`, `users.manage`; precisa de `META_WABA_ID`).

- **Cobrança** (`FEATURE_BILLING_REMINDERS`): faturas abertas e liberadas que vencem em +3, hoje, −1 e −6 dias (a BBNET bloqueia com 7 de atraso), lidas **em lote** (`listOpenInvoicesDue`, uma consulta por página de 500) e o contato de até 200 clientes por consulta (`IN`) — a cota do IXC é 30 consultas/minuto para o processo inteiro. Medido em 18/11: ~970 mensagens/dia (278 vencendo hoje, 361 em 3 dias, 221 vencidas ontem, 106 na véspera do bloqueio). Ordem: véspera do bloqueio → atraso → vence hoje → lembrete. Uma mensagem por cliente e etapa (a maior fatura). O botão "Quero o PIX" chega como fala do cliente e cai no fluxo da 2ª via (CPF → PIX).
- **Avisos de rede** (`FEATURE_NETWORK_NOTICES`): pelas massivas registradas em Rede e massivas — começo (enquanto aberta), normalização (24 h depois de resolvida, só para quem recebeu o começo) e **manutenção programada** (novo tipo no registro, com início e fim; aviso nas 48 h antes). Público: clientes ativos do IXC com aquele bairro e cidade. O botão antigo "Avisar clientes da área" (`mass-notice-service.ts`) continua só registrando quem seria avisado; quem envia é este motor.
- **Travas**: `outbound_messages` com índice único (aviso + referência + cliente) reservado **antes** do envio — a rodada seguinte não repete; teto por rodada (`OUTBOUND_MAX_PER_RUN`, 150) e por dia (`OUTBOUND_DAILY_CAP`, 900 — o limite de conversas iniciadas da Meta); só das 8h às 20h de Brasília; limite da Meta (131048/131056/429) para a rodada inteira; só celular (fixo de 10 dígitos não recebe WhatsApp); cliente inativo fora.
- **Descadastro**: "SAIR"/"parar" → `whatsapp_opt_outs`, resposta de confirmação, a IA não entra; "VOLTAR" desfaz. O número é guardado com o nono dígito (`canonicalPhone`): o WhatsApp entrega alguns números brasileiros sem ele.
- **Quem dispara**: `.github/workflows/outbound.yml` (cobrança de hora em hora 9h–17h seg–sáb; rede a cada 15 min 8h–20h) chamando `POST /api/jobs/outbound` com `x-job-secret` = `OUTBOUND_JOB_SECRET` (mesmo valor no Railway e nos Secrets do GitHub). Quem tem `users.manage` pode chamar só com simulação (`dryRun`): contagens, nada reservado nem enviado. A resposta só tem contagens (fica no log do Actions).

**Resposta do atendente pela tela** (`FEATURE_ATTENDANT_REPLY`, `lib/platform/attendant-reply-service.ts`). Segue a régua da escrita no ERP: idempotência (chave por clique, reservada em `channel_idempotency_keys` **antes** de chamar a Meta) → política (login obrigatório, texto de homologação recusado, janela de 24 horas) → flag → chamada. Bloqueio e falha também entram na auditoria. Em **timeout a reserva não é solta**: a mensagem pode ter saído, e liberar convidaria um reenvio em dobro. A autoria fica em `channel_messages.sent_by`; nulo é "não registrado", nunca "a IA". Antes de responder, a mensagem do cliente é marcada como lida (melhor esforço, pelo `wamid` em `external_message_id`).

## Auditoria de contratos

**Gestão → Auditoria de contratos** confere, em cada contrato novo do IXC, o cadastro do cliente (`lib/platform/contract-audit-service.ts`, regras em `contract-audit-shared.ts`):

- **Celular ou WhatsApp** preenchido com DDD (10 ou 11 algarismos) — um dos dois basta
- **E-mail** preenchido e com formato de e-mail
- **Número do endereço** é o número da casa ou **SN**. Zero não vale — e na base real ele aparece como "00" e "000", não só "0", por isso a regra é "só zeros". Grafias como "S/N" ficam como *fora do padrão*

Antes de virar código, `scripts/ixc-probe-contract-audit.mjs` mediu a base (sem imprimir dado pessoal): o `id` do contrato cresce com a criação (37 mil contratos), a data de entrada é `data_cadastro_sistema`, e numa amostra de 60 cadastros recentes 4 tinham e-mail vazio ou inválido e 2 o Número zerado.

**Quem criou o contrato** vem do **log de alterações do IXC** (`ixc_logs`, ~59 milhões de linhas): a linha com `tabela = cliente_contrato`, `id_tabela = <contrato>` e `tipo = inseriu` traz o `operador` — já como nome do usuário — e a data. Uma consulta, ~150 ms (`scripts/ixc-probe-contract-creator.mjs`). ⚠️ **Não use `id_vendedor` para isso**: é o vendedor creditado, e medido nos 200 contratos mais recentes ele não é quem digitou — 16% estão com o "Vendedor padrão", e há contrato de um vendedor inserido por outra atendente. Também aparece usuário **compartilhado** como operador (ex.: "caixa férias"), que não identifica pessoa. Do log só se leem `tipo`, `operador` e `data`: `campos` e `executou` trazem os valores alterados, que podem ser dado de cliente. A operação do provider chama `getRecordHistory` — o guard de somente leitura recusa nome de operação com palavra de escrita, e "change" é uma delas.

**Como roda.** Por ponto de parada: o `id` do último contrato conferido fica em `sync_checkpoints` (`ixc` / `contract-audit`), e cada passada pede ao IXC os de `id` maior. O ponto avança contrato a contrato — se o IXC cair no meio, a próxima passada continua dali, e nada criado depois fica de fora, só atrasa. A primeira passada parte dos 8 contratos mais recentes. Cada passada é **pequena de propósito** — no máximo 8 novos, 5 reconferências e 10 preenchimentos de quem criou, e acima de tudo um **teto de 20 consultas ao IXC** (`MAX_IXC_CALLS_PER_RUN`): contrato novo custa duas (cadastro e log). E ela **para antes** se o limite por minuto do IXC estiver perto do fim, deixando uma folga de 10 consultas (`RATE_LIMIT_RESERVE`, lida do limitador do provider por `rateLimitRemaining`). O limite é do processo inteiro — medido localmente, o painel inicial gastou metade dele ao abrir o app, e a primeira passada esbarrou no limite com 15 consultas. A auditoria pode esperar a próxima passada; o atendente com o cliente na linha, não. Cadastro e log são lidos **antes** de gravar: se um falhar, o contrato não é gravado pela metade e o ponto não avança.

**Quem dispara.** Abrir a tela (o servidor só executa se a última passada tiver mais de 10 minutos — várias abas não viram várias passadas), o botão **Verificar agora**, e o agendamento em `.github/workflows/contract-audit.yml`: de hora em hora, das 07h às 20h de Brasília, um `POST /api/audit/contracts` com o cabeçalho `x-job-secret`. O segredo `CONTRACT_AUDIT_JOB_SECRET` precisa ter **o mesmo valor** no Railway e em *Settings → Secrets and variables → Actions* do GitHub; sem ele no Railway, a rota recusa o agendamento. ⚠️ **Não há agendador dentro do app**: o Railway roda um processo web, sem temporizador garantido — por isso o relógio é o GitHub. A resposta do agendamento só tem contagens, nenhum dado de cliente, porque fica gravada no log de cada execução do Actions.

**Reconferência.** Pendente e "não verificado" são reconferidos sozinhos por 30 dias. Quando o cadastro é corrigido no IXC, o contrato vai para *Corrigidos* com a data da correção, e `first_issues` guarda o que estava errado na primeira conferência — corrigir depois não apaga o fato de o contrato ter nascido incompleto.

**Dado pessoal.** Nenhum telefone ou e-mail é copiado para o LZR HUB: só se o campo serve. O nome do cliente fica, para a tela; o valor do Número só quando está fora do padrão. Exige `FEATURE_IXC_FULL_BASE` (com a allowlist a listagem de contratos é recusada) e a permissão `audit.read`.

## Convenções de código

**Padrão de repositório com injeção de dependência.** Toda lógica que toca o banco fica atrás de uma interface, com duas implementações: uma real (`Db*Repository`) e uma em memória (`Memory*Repository`) usada nos testes. Isso permite testar regra de negócio sem banco. Exemplos: `lib/platform/auth.ts`, `lib/platform/support-metrics.ts`, `lib/platform/n8n-channel-service.ts`.

**Rotas de API são finas.** Elas validam entrada, chamam o serviço e devolvem a resposta. Regra de negócio não mora em `app/api/`.

**Degradar, não mentir.** Quando uma fonte de dados não está disponível, a resposta diz que está indisponível — nunca devolve zero ou valor inventado como se fosse real. O painel de métricas e a tela de auditoria seguem isso.

**Nada de dado pessoal em log ou resumo.** Há sanitização obrigatória (e-mail, CPF/CNPJ, telefone) antes de gravar qualquer texto vindo de conversa. Ver `sanitizeHandoffText` em `lib/agent/handoff.ts`.

**Contexto operacional vem do servidor.** Rotas nunca aceitam do cliente campos como `channel`, `simulationProfile` ou `role` — isso é rejeitado com 403 (`hasUntrustedOperationalContext` em `app/api/agent/route.ts`).

**Nada de cor fixa.** `app/globals.css` tem tema claro e escuro, e cada cor é declarada **uma vez** com `light-dark(claro, escuro)`. Escrever `#64748b` numa regra — ou num `style={{}}` de componente — produz algo que funciona no claro e some no escuro. Se a cor não existe como token, crie o token. Dois azuis existem de propósito: `--blue` é azul **como texto** (claro no tema escuro) e `--blue-solid` é azul **como fundo de botão** (escuro o bastante para texto branco em cima).

**Cliente não importa de servidor.** Componente com `"use client"` que importa um serviço de `lib/platform/` arrasta as dependências dele para o pacote do navegador. Já aconteceu: `billing.tsx` importava uma constante de `collection-rules-service.ts` e levou junto `node:crypto` e o schema do Drizzle — quebrava o `npm run dev` inteiro e mandava 40 KB de ORM para o navegador em produção. Quando a tela precisa de um tipo ou constante, ele mora num arquivo `*-shared.ts` sem dependência de servidor.

**Telas: menu, abas e peças compartilhadas.** O mapa de telas mora em `lib/platform/navigation.ts`: **seções** no menu (14) e **abas** dentro delas. O menu tinha 26 itens, e vários eram a mesma tela com outro nome — "Cobrança › Relatórios" e "Comercial › Relatórios" repetiam a visão geral, "Configurações" relia o estado de "Integrações", e Monitoramento, Mapa de Alertas e Massivas eram três portas para o mesmo registro. Endereços antigos continuam abrindo algo (`viewAliases`). A tela aberta vai no endereço (`#/funil`), então recarregar, voltar e mandar link funcionam; `Ctrl+K` abre a busca de telas. Aba com `permission` some do menu para quem daria 403 ao abrir; sem sessão (demonstração), tudo aparece.

As peças de tela estão em `components/ui/kit.tsx` (`Stat`, `Card`, `Notice`, `Limits`, `InfoTip`, `Modal`, `Segmented`, `Loading`, toasts) e os ícones em `components/ui/icons.tsx` (SVG de traço, nada de glifo Unicode). **Não crie `Heading` nem `Metric` dentro do módulo** — cada módulo tinha a sua cópia. A regra de leitura: **o dado vem primeiro, a ressalva fica a um clique.** "Não medido" continua escrito como "—" com o motivo, mas a explicação longa vai em `InfoTip` (ao lado do número) ou em `Limits` (recolhido no fim), não num cartão inteiro antes do dado. Confirmação passageira ("Versão 3 salva") é toast; resultado que a pessoa precisa ler com calma — senha gerada, resposta crua do IXC — fica na tela. Formulário que não é o assunto da tela abre em `Modal`, não empilhado acima da lista.

Tabela é `.table` com `.tr` em grade e as colunas em `--cols`. ⚠️ Cada `.tr` é uma grade independente: coluna `auto` dá larguras diferentes por linha e o cabeçalho desalinha — use só larguras fixas ou `minmax`/`fr`.

**Estilo.** Parte do código usa formatação bem compacta (várias instruções por linha). Ao editar um arquivo, siga o estilo dele em vez de reformatar.

**Comentários explicam o porquê, não o quê.** Especialmente decisões de segurança e escolhas não óbvias.

## Antes de abrir PR ou dar push

```bash
npm run typecheck && npm run lint && npm test
```

Os três precisam passar. Hoje a suíte tem **1522 testes** (18 falhas conhecidas de tela/inicialização sintética, vindas da frente do Breno).

## Segurança — pontos já decididos

- Senha com **scrypt** (nativo do Node — evita dependência compilada que quebraria o build), salt por usuário, comparação de tempo constante
- Sessão em cookie `HttpOnly`/`SameSite=Lax`/`Secure`; **o banco guarda só o SHA-256 do token**
- Login que falha sempre responde a mesma mensagem, e gasta o mesmo tempo mesmo com e-mail inexistente
- Segredos **nunca** vão para o repositório. `.env*` é ignorado, exceto os `.example`

Ver [`docs/security/authentication.md`](docs/security/authentication.md).

## Limites conhecidos (não são bugs a "descobrir")

- A tela de Usuários gerencia contas de verdade: criar, desativar/reativar, trocar perfil e resetar senha, tudo auditado. A senha é **sempre gerada pelo sistema** e mostrada uma única vez; ninguém escolhe senha de terceiro. Duas travas impedem auto-bloqueio: não dá para desativar ou rebaixar a própria conta, nem deixar o sistema sem nenhuma conta capaz de gerenciar usuários
- Troca de senha pelo próprio usuário fica no rodapé da barra lateral (botão "Senha"). Exige a senha atual e **derruba as outras sessões** — trocar a senha precisa expulsar quem estava dentro
- Conta criada ou senha resetada pelo admin nascem com `must_change_password`: no primeiro acesso a pessoa é obrigada a definir a sua, num diálogo que não fecha
- **Não há envio de e-mail no projeto** (sem SMTP, sem provedor). Por isso "esqueci minha senha" não manda link: registra um pedido que aparece na tela de Usuários, e quem administra gera a senha nova e entrega. O pedido é aceito mesmo para e-mail sem conta — recusar revelaria quais endereços têm conta
- O rate limit de login é **memória do processo**: com mais de uma instância cada uma conta a sua parte. Migra para Redis quando houver escala horizontal
- Custo por atendimento não é medido (depende do Langfuse, issue #6)
- Tempo médio de atendimento também não é medido — a Visão geral escreve isso em vez de estimar
- Responder pela tela de Atendimentos existe atrás de `FEATURE_ATTENDANT_REPLY`, e só com **texto livre dentro de 24 horas** da última mensagem do cliente — fora disso a Meta exige modelo aprovado, que ainda não é suportado. O campo fica desabilitado enquanto a flag, o token ou o login faltarem. A sugestão da IA e a resposta redigida do copiloto podem virar **rascunho** no campo; o atendente edita e envia. `copilot.suggestion.used` continua registrando *cópia*: o que vai para a auditoria como envio é `whatsapp.reply.sent`
- Recibo de entrega e leitura (`statuses` do webhook) é gravado na resposta enviada (`channel_messages.delivery_status`): a tela mostra *Aceita pela Meta → Enviada → Entregue → Lida*, ou *Falhou* com o motivo. O recibo **nunca rebaixa** — "entregue" que chega depois de "lida" é ignorado — e só vale para resposta nossa (`role = agent`), casada pelo `wamid`
- **Atendimentos se atualiza por consulta, não por push**: a cada 5 s com a aba visível (lista e conversa aberta); com a aba escondida, só a lista, a cada 30 s. Fora da caixa de entrada, a casca do app consulta a lista a cada 30 s — é o que mantém o "(3)" do título e o número ao lado de Atendimentos no menu em qualquer tela. O navegador pode espaçar mais as consultas de aba em segundo plano. Se a escala pedir, o próximo passo é SSE, não encurtar o intervalo
- **A espera é calculada, não marcada à mão**: desde a primeira fala do cliente depois da última resposta **enviada por um humano** — sugestão da IA não conta como resposta, e a primeira resposta automática também não. A cor na lista é o SLA à vista: até 5 min normal, até 30 min atenção, depois atrasado (`waitTone`). Não há roteamento automático: ninguém recebe conversa sem pedir, quem assume é quem clica (ou quem responde)
- Em Atendimentos: `/` no campo de resposta abre as respostas aprovadas, `Alt+↑`/`Alt+↓` trocam de conversa, e o sino liga aviso do sistema quando alguém entra na fila (só o nome, nunca o texto — ele apareceria na tela de bloqueio). Sugestão da IA que o atendente enviou como estava vira uma linha só, em vez de duas bolhas iguais. Fora da janela de 24 horas o campo dá lugar ao motivo: **envio de modelo aprovado (template) não existe ainda**
- Áudio, foto, documento e figurinha **não somem mais**: viram uma fala do cliente entre colchetes ("[Áudio recebido — …]"), sem acionar a IA e sem desfecho. A mídia em si **não é baixada nem exibida**; a legenda de foto aparece ao atendente, mas nunca é tratada como pedido. Reação a mensagem e aviso de sistema continuam ignorados. **No modo autônomo a IA responde** (`media-reply-shared.ts`): foto/vídeo/documento → "não consigo abrir, me conta… se for comprovante, o dia em que pagou"; áudio sem transcrição → pede para escrever; figurinha só cumprimenta quem chega agora (no meio da conversa é reação). Uma resposta por rajada (reserva `media-reply:<telefone>:<tipo>:<10 min>`), nunca com humano na conversa — em 24/11 uma conversa nova aberta com figurinha ficou sem resposta
- O webhook da Meta pode trazer **várias mensagens no mesmo POST**; a rota processa todas (`parseMetaMessages`). Antes só a primeira era lida
- O **nome do perfil de WhatsApp** (`channel_contacts`) aparece na lista e no cabeçalho, mas é o que a pessoa escolheu para si: não identifica ninguém. É limpo de caractere invisível e de inversão de texto antes de gravar
- Mensagens gravadas no mesmo lote ganham 1 ms de diferença, e a leitura desempata pondo a fala do cliente antes da resposta: com o mesmo carimbo, o banco devolvia a sugestão antes da pergunta que ela respondia
- A base de conhecimento **não é segmentada por perfil**: todo documento publicado é visível a quem tem `customer.read`. Não existe conceito de documento restrito
- **Conversa de grupo do WhatsApp não é atendimento.** O caminho antigo (via n8n) repassava qualquer mensagem, e identificadores `@g.us` entraram na tela de Atendimentos com intenção classificada e transbordo contado. A rota nova recusa na entrada; o que já está gravado é **filtrado na leitura** (`lib/platform/conversation-scope.ts`), não apagado — filtrar preserva o histórico e não exige migração. `scripts/contar-grupos.mjs` mede o resíduo
- O painel lateral de Atendimentos mostra o **cadastro do IXC** do telefone da conversa (`/api/conversations/customer`), consultado **uma vez ao abrir** — nunca a cada atualização, porque o IXC tem limite por minuto. A cidade só aparece quando vem como nome: o IXC costuma devolver o código interno ("1759"). Casar telefone com cliente é `findCustomerByPhone` em `lib/integrations/ixc/readonly-provider.ts`. O segredo é o formato — o canal manda `5579998307232` e o IXC guarda `(79) 99830-7232`; dígitos puros devolvem zero em silêncio. A regra é **exatamente um resultado ou nada**: buscar pelo final do número trouxe 4 clientes diferentes na base real, e identificar o cliente errado é pior que não identificar
- `FEATURE_IXC_FULL_BASE` está **ligada** em produção (exigia `FEATURE_AUTH=true`, o código recusa subir sem isso — e ambas já estão de pé). A lista de Clientes deixou de ser só a allowlist de homologação; Chamados mostra a fila real do provedor (OS não fechadas, paginadas). A OS não traz o nome do cliente — só `id_cliente` e endereço — e buscar o nome seria uma consulta por linha da página. `scripts/ixc-probe-listing.mjs` foi o que confirmou, antes de ligar, que a listagem paginada do IXC de fato funciona
- Churn é **realizado**, não previsto: medimos quem saiu, não quem vai sair. Não há score de saúde nem elegibilidade de upgrade — nada disso é calculado, e a tela diz o que faltaria
- O CRM passou a existir (issue #17): **Comercial → Funil** grava lead, etapa, origem e histórico de verdade. Conversão e ciclo médio são calculados do que está gravado, e valem `null` — não zero — enquanto nada tiver encerrado. **Valor de pipeline continua não existindo**: exigiria um valor estimado por lead, que ninguém preenche; somar plano suposto daria número bonito e falso
- As **etapas do funil são fixas** (`LEAD_STAGES` em `lib/platform/crm-shared.ts`), não configuráveis. A issue pedia configuráveis; a escolha foi consciente, porque etapa configurável só serve depois que a operação sabe qual é o funil dela — e ninguém nunca usou um aqui
- Contato desconhecido no WhatsApp vira lead sozinho. **Quem já é cliente no IXC não vira** — e, se o IXC não responder, ninguém vira: na dúvida o funil não cria, senão um ERP fora do ar encheria o funil de cliente antigo
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
- `docs/integrations/` — IXC (mapeamento de dados, segredos, ponte) e o **canal de WhatsApp**: `whatsapp-meta.md` (oficial, recomendado) e `whatsapp-evolution.md` (não oficial, em risco de banimento)
- `docs/queues-bullmq.md` — filas
- `scripts/mine-whatsapp-backup.mjs` — estudo do backup de WhatsApp das atendentes, **um lote por loja** (`--lote itabaiana`). Lê o `msgstore.db` já aberto, anonimiza (sem agenda de contatos no backup: o nome é achado por lista de prenomes, cumprimento, maiúsculas e rótulos como "Login:"/"Local:"), separa a saudação automática do WhatsApp Business e grava só o texto limpo em `data/backup-analise/<lote>/` (fora do git). Estatística, roteiro de fato da atendente e respostas rápidas saem sem modelo; `custo` estima a análise por conversa, que só roda com `OPENAI_API_KEY`
- Issues no GitHub descrevem o roadmap por milestone (M1 a M5)
