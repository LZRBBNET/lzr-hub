# Runbook de integrações

## Desenvolvimento

```bash
npm ci
npm run dev
```

## Validação

```bash
npm run lint
npx tsc --noEmit
npm test
```

## Ativação futura

1. Criar adaptador e testes de contrato.
2. Configurar credenciais apenas no cofre do ambiente.
3. Validar em sandbox com dados fictícios.
4. Habilitar a feature flag somente em homologação.
5. Testar timeout, retry, idempotência, circuit breaker e DLQ.
6. Fazer rollout gradual e monitorado.

## Rollback

1. Desligar a feature flag do conector.
2. O pipeline volta imediatamente ao adaptador mock ou handoff humano.
3. Drenar a fila afetada para DLQ sem repetir ações transacionais.
4. Registrar correlação, impacto e versão.
5. Reverter o commit ou a versão do Site somente após preservar auditoria.
