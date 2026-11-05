# Filas reais com Redis e BullMQ

A fila roda fora do runtime web. O HUB acessa uma API Node protegida, e os workers BullMQ consomem o Redis em processos separados.

## Subir localmente

1. Copie `.env.example` para `.env.local`.
2. Defina:

```env
FEATURE_QUEUES=true
QUEUE_SERVICE_URL=http://127.0.0.1:8790
QUEUE_SERVICE_SECRET=local-development-secret-change-me-123456
```

3. Suba as integrações:

```bash
docker compose --profile integrations -f docker-compose.integrations.yml up -d --build
```

4. Inicie o HUB normalmente e abra **Administração → Equipes, Filas e Jobs**.

## Verificação

```bash
docker compose --profile integrations -f docker-compose.integrations.yml ps
docker compose --profile integrations -f docker-compose.integrations.yml logs -f queue-api queue-worker
curl http://127.0.0.1:8790/healthz
```

O endpoint `/healthz` não expõe conteúdo de jobs. Os endpoints `/v1/*` exigem `Authorization: Bearer <QUEUE_SERVICE_SECRET>`.

## Testes de integração

Com o Redis ativo:

```bash
cd services/queue-runtime
npm install
TEST_REDIS_URL=redis://127.0.0.1:6380/1 npm test
```

O teste cobre processamento normal, retry automático, DLQ, reprocessamento manual e idempotência.

## Produção

- Use `rediss://` ou uma rede privada entre API, workers e Redis.
- Gere um `QUEUE_SERVICE_SECRET` aleatório com pelo menos 32 caracteres.
- Publique a API de filas somente para o HUB; não a exponha diretamente ao navegador.
- Execute pelo menos um processo `queue-worker` continuamente.
- Mantenha `FEATURE_QUEUES=false` até Redis, API, worker, segredo e URL estarem configurados.
- O processador desta entrega confirma o pipeline assíncrono, mas não realiza escrita no IXC, envio de WhatsApp ou cobrança externa.

## Cobrança: bloqueio obrigatório no consumidor

`worker.mjs` associa cada fila a `createProcessor(name)`. A fila
`billing-reminders` passa por `processBillingReminder` antes de qualquer
continuação. As outras filas continuam com o processador demonstrativo.

**Não existe remetente de cobrança nem adaptador de evidência instalado no
worker.** Sem essas dependências, cobrança falha explicitamente, sem retornar
`processedAt`, sem mensagem e sem ser marcada como concluída pelo processador.
Este código não habilita fila, bridge, WhatsApp, acesso ao IXC ou implantação.
O payload novo contém somente contexto para consulta, nunca autorização:
`schemaVersion: 1`, `invoiceId`, `customerId`, `ruleId`, `ruleVersion`, `stepId`,
`scheduledFor`, `channel` e `templateId`. Jobs legados sem esse contexto falham
fechado; não se deduz regra/data pelo nome do job nem se completa com valores
atuais. Não os reenvie automaticamente.

### Contrato para uma futura integração autorizada

As duas dependências são injetadas pelo código servidor, nunca pelo payload:

- `readEvidence(context, { requestedAt, signal })`: uma consulta nova por
  tentativa, inclusive retry. Deve resolver exatamente a fatura e seu dono,
  a intenção persistida, a **última** versão/etapa da régua e o estado de
  cancelamento, em fontes autorizadas. Não pode copiar afirmações do job,
  usar cache, lista parcial ou presumir abertura por ausência de pagamento.
- `continueEligible(context)`: fronteira para um eventual processador
  autorizado. Hoje aparece somente como fake nos testes, que retorna
  `{ simulated: true, delivered: false }`. Sua ausência, erro ou retorno
  não objeto falha explicitamente. O guard não inventa recibo nem determina
  que uma resposta do futuro remetente equivale a entrega.

A evidência normalizada deve conter:

```js
{
  complete: true,
  observedAt: "2026-11-05T15:00:00.000Z", // observado nesta consulta, não no enqueue
  invoice: {
    id: "invoice-fictional", customerId: "customer-fictional",
    status: "A", dueAt: "2026-11-05"
  },
  intent: {
    invoiceId: "invoice-fictional", customerId: "customer-fictional",
    ruleId: "rule-fictional", ruleVersion: 1, stepId: "step-fictional",
    scheduledFor: "2026-11-05", channel: "WhatsApp", templateId: "template-fictional",
    idempotencyKey: "invoice-fictional:step-fictional:2026-11-05",
    offsetDays: 0, current: true, active: true, cancelled: false
  }
}
```

`complete`, `current`, `active` e `cancelled` são afirmações positivas que o
adaptador deverá comprovar, não valores padrão. O ledger atual e os metadados
presentes no job, isoladamente, **não satisfazem esse contrato**. Falha ou
ambiguidade em qualquer consulta torna a evidência indisponível/incompleta.
`observedAt` deve refletir a evidência financeira e operacional efetivamente
consultada nesta tentativa, não somente o término de uma chamada com dados
antigos. O adaptador precisa controlar origem, autenticidade e semântica:
um timestamp recente sozinho não prova que os dados vieram do IXC.

O guard exige identidade exata, status positivamente aberto (`A`, `aberto`,
`aberta`, `em aberto`), correspondência de todo o contexto e a data calculada
com vencimento fresco + deslocamento atual. Datas impossíveis, versão
obsoleta, cancelamento, etapa desativada, dia diferente ou horário fora de
08h–20h em dia útil de Brasília bloqueiam. A observação não pode anteceder o
início da tentativa, estar no futuro ou ter mais de 5 segundos ao retornar.
A fonte tem timeout de 5 segundos e recebe um `AbortSignal`; uma resposta
atrasada não chama a continuação. Erros usam códigos fixos, sem corpo de
resposta, dados da fatura ou detalhes do provedor nos logs.

### Falhas, retries e limites

- Um bloqueio lança erro e segue os retries/DLQ existentes. Não remove nem
  cancela fisicamente jobs, não muda retroativamente jobs já concluídos e não
  altera o ledger para sugerir envio. O painel pode mostrar `failed`, não um
  novo estado `blocked`.
- O guard reduz a janela entre consulta e continuação, mas não cria transação
  atômica entre pagamento, cancelamento e envio. Antes de integrar um remetente,
  é necessário definir idempotência durável, concorrência, cancelamento durante
  envio e tratamento de resultado incerto. Retry não pode repetir uma mensagem
  aceita pelo provedor cuja resposta tenha se perdido.
- Aprovação de template, destinatário, opt-in, política do canal e autorização
  operacional continuam sendo requisitos da integração futura. Passar neste
  guard não autoriza contato real. Não existe configuração de ambiente que
  instale automaticamente as dependências ausentes.

### Testes sem serviços externos

```bash
node --test services/queue-runtime/tests/billing-reminders.test.mjs
node --experimental-strip-types --test tests/billing-queue-payload.test.mjs
```

Esses testes usam somente dados fictícios, fontes em memória e continuação
fake. Também integram o `npm test` da raiz. O teste separado com Redis valida
transporte/retry/DLQ genéricos; não é prova de envio ou revalidação de cobrança.
