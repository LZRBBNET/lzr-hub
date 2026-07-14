# Runbook de staging

1. Confirmar acesso restrito aos usuários do piloto.
2. Configurar D1 `DB` e secrets distintos.
3. Manter `LZR_ENV=staging`, `IXC_MODE=disabled` durante migrations.
4. Executar status, migration, seed sintético, backup e restore test.
5. Cadastrar no máximo 10 IDs internos autorizados.
6. Ativar `IXC_MODE=staging-readonly` somente após teste de contrato.
7. Conferir health, auditoria, cache, falha parcial e mascaramento.
8. Em incidente: definir `IXC_MODE=disabled`, revogar token, preservar logs sanitizados e seguir rollback.

Rollback de aplicação é feito retornando ao checkpoint anterior. Migration desta fase é aditiva; não excluir tabelas em resposta a incidente. Para dados de teste, exportar evidência, apagar apenas registros com origem `staging-seed` e registrar a operação.

## Evidência local reproduzível

Em 12/07/2026, as migrations `0000` e `0001` foram aplicadas no D1 local isolado de homologação; o seed inseriu dois registros sintéticos. O export SQL foi restaurado em outro diretório e a consulta de integridade encontrou 14 tabelas. O backup gerado é ignorado pelo Git por conter estado de ambiente.

Comandos: `npm run db:staging:create`, `db:staging:migrate`, `db:staging:seed`, `db:staging:status`, `db:staging:backup` e `db:staging:restore:test`.
