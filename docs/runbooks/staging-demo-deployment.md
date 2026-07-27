# Runbook — staging demo do LZR HUB

## Objetivo

Publicar uma demonstração protegida do LZR HUB com dados sintéticos, agente em modo mock e bloqueio absoluto de IXC e escritas externas.

## Controles obrigatórios

Use exatamente as variáveis de `.env.staging.example`. A aplicação falha fechada se qualquer uma delas divergir.

- `LZR_ENV=staging`
- `NEXT_PUBLIC_LZR_ENV=staging`
- `LZR_RUNTIME_MODE=mock`
- `IXC_MODE=disabled`
- `IXC_TRANSPORT=disabled`
- `IXC_WRITE_ENABLED=false`
- `FEATURE_IXC_WRITE=false`
- todas as integrações externas e perfis de homologação desligados

O ambiente publicado não recebe `IXC_API_TOKEN`, token de relay, segredo de job ou credenciais de WhatsApp. Não existe fallback para o IXC.

## Preparação e validação

```bash
npm run install:ci
npm run lint
npm run typecheck
npm run test:staging
npm test
npm run build:staging
npm run validate:artifact
```

O health check deve retornar somente:

```json
{
  "status": "ok",
  "environment": "staging",
  "runtimeMode": "mock",
  "ixc": "disabled",
  "externalWrites": false
}
```

## D1 local sintético

O D1 não é requisito do primeiro deploy mock. Para validar o ciclo local:

```bash
npm run db:staging:create
npm run db:staging:migrate
npm run db:staging:seed
npm run db:staging:seed
npm run db:staging:status
npm run db:staging:backup
npm run db:staging:restore:test
```

Executar o seed duas vezes comprova idempotência. Não promover o banco local ou o identificador placeholder de `wrangler.jsonc` como banco remoto real.

## Publicação

1. Confirmar que o acesso do Sites está em modo `custom`, restrito ao proprietário ou à lista explicitamente aprovada.
2. Publicar somente a branch `feat/staging-demo-deployment`.
3. Salvar uma versão e implantar essa versão pelo fluxo de checkpoint do Sites.
4. Verificar o status terminal da implantação.
5. Confirmar que a política de acesso continua protegida.
6. Verificar `/api/health` e as jornadas descritas em `docs/demo/staging-test-scenarios.md`.

Não alterar `main`, não fazer merge e não tocar no PR do relay.

## Rollback

1. Reimplantar a versão anterior estável pelo Sites.
2. Se houver qualquer dúvida sobre isolamento, remover a implantação atual do tráfego e manter `IXC_MODE=disabled`.
3. Preservar logs sanitizados, sem mensagens de clientes, tokens ou identificadores reais.
4. Registrar o incidente na Issue #27.

O rollback não exige chamada ao IXC, restauração remota de D1 ou execução de escrita externa.
