# Checklist do piloto interno

## Antes

- [ ] Aprovar 2 a 3 participantes e seus perfis RBAC.
- [ ] Obter autorização para até 10 cadastros internos.
- [ ] Configurar token IXC exclusivo somente leitura.
- [ ] Confirmar acesso restrito, D1, migration, backup e restore.
- [ ] Validar health sem PII e agendamento desligado.

## Roteiro diário

- [ ] Localizar cada ID autorizado; tentar um ID não autorizado.
- [ ] Conferir cliente, contratos, plano, vencimento, faturas, pagamentos, OS e conexão.
- [ ] Comparar dados mascarados com o IXC sob supervisão.
- [ ] Atualizar manualmente e observar cache hit/miss.
- [ ] Simular 401, 403, 429, 500 e timeout no mock server.
- [ ] Confirmar que falha de uma fonte não derruba os outros blocos.
- [ ] Tentar operação de escrita de teste e confirmar bloqueio anterior à rede.
- [ ] Revisar auditoria, jobs, DLQ e métricas.

## Encerramento

- [ ] Classificar bugs por severidade.
- [ ] Exportar somente métricas agregadas.
- [ ] Remover dados do piloto conforme retenção.
- [ ] Revogar ou rotacionar token.
- [ ] Decidir go/no-go para a próxima fase; não habilitar escrita implicitamente.
