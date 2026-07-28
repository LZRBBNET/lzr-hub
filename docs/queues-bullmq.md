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
