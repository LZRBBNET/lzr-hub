# Reconciliação auditada: código e validação sintética

Atualização incremental do PR #68 sobre 0780d49, mantendo base #41 (inclui #36). Código e testes idênticos à candidata revisada 578a321; exclui todas as capturas e relatórios que as referenciam adicionados posteriormente ao head original. Esta entrega contém somente código, testes e este resumo textual. Não republica imagens cuja divulgação foi negada.

O atendimento exibe estado incerto persistente e bloqueia novos envios. Supervisor/Administrador podem registrar conclusão com referência manual de evidência. Reconciliação registra auditoria, encerra a chave original, grava resultado idempotente e remove reserva na mesma transação. Não chama transporte, não altera responsável e não fabrica histórico. Replay não reenvia nem remove reserva posterior.

Revisão independente reproduziu pedidos já autenticados concluindo após logout, desativação ou demissão. Correção revalida sessão/usuário/papel dentro da transação, após lock da conversa, com FOR SHARE nos registros de identidade. Inclui proteção contra formulário trocar de reserva mantendo evidência antiga.

Validação da candidata de mesmo código: 931 testes automatizados na base do PR; 1007 na composição local sem conflitos com 57ad19b (linha atual verificada em metadados). Build/artefato, lint e typecheck passaram. PostgreSQL17.11 novo descartável, papel não proprietário, Chromium/login sintético e transporte em memória: 19 registros por árvore, incluindo concorrência, falha de auditoria, escritas suprimidas, COMMIT incerto, replay, tentativa ativa, restart normal e formulário500px. Nove casos independentes de revogação/expiração durante corpo atrasado ou espera de advisory lock retornaram401/403, preservando reserva e auditoria; replay revogado também negado. Zero mensagens reais. Evidência visual permanece local; não é CI remoto ou homologação de produção.

Reprodução:

```sh
npm test
npm run lint
npm run typecheck
PG_BIN=/path/to/postgresql/bin PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node --experimental-strip-types tests/manual/handoff-postgres.mjs
PG_BIN=/path/to/postgresql/bin NODE_PATH=./node_modules node --experimental-strip-types tests/manual/reconciliation-revocation.mjs
```

Limites: conferência externa manual, ausência de recibo não prova não envio; sem exactly-once ou confirmação de entrega. Reservas legadas/ativas/sem encerramento persistido permanecem bloqueadas. Sem TTL/force-unlock. Deduplicação entre eventos distintos do bot, pool e workers antigos continuam pendentes. Não houve ensaio de perda de energia, relógios divergentes ou capacidade sustentada.

Sem DDL novo. FOR SHARE precisa SELECT e UPDATE em alguma coluna das tabelas bloqueadas; ensaio usa UPDATE(last_login_at) em users e UPDATE(expires_at) em sessions, além de privilégios limitados de ledger/auditoria. UPDATE(expires_at) permite alterar validade a quem comprometer esse papel: revisar o papel antes de ativar, sem grants amplos. Permissões reais não modificadas; ausência de privilégio falha fechada503.

Não misturar versões que ignoram reservas/estados reconciliados. Implantação futura exige suspender/drenar remetentes antigos e revisar privilégios/retenção. Rollback deve suspender envios e preservar reservas, tombstones, ledger e auditoria, sem restaurar confirmação falsa. n8n delegado permanece somente sugestões. Manter draft; revisar a candidata exata antes de qualquer integração autorizada. Sem merge remoto ou deploy.
