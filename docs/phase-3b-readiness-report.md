# Fase 3B — relatório de prontidão

## Resultado

A infraestrutura de ativação, smoke tests e piloto está pronta, mas a Fase 3B **não pode ser declarada concluída contra o IXC real** enquanto secrets, IDs autorizados e participantes não forem configurados. O sistema falhou fechado e não fez chamadas externas.

## Implementado

- contrato canônico `IXC_ALLOWED_CUSTOMER_IDS`, com compatibilidade de rollback;
- retry configurável limitado a 0 ou 1;
- bloqueio de ID antes de qualquer chamada de rede;
- leitura de plano separada e mapeada;
- smoke runner com autenticação, cliente, contratos, plano, faturas, pagamentos, OS, conexão e cache;
- resultados sanitizados e auditados em D1;
- piloto restrito a 2 ou 3 IDs de usuário;
- métricas, feedback, sugestões e bugs sem PII;
- referências de screenshot somente `sanitized://`;
- latência total e por bloco no Customer 360;
- migrations aditivas, backup e restore testados.

## Bugs encontrados e corrigidos

1. O prompt da Fase 3B usava `IXC_ALLOWED_CUSTOMER_IDS`, enquanto o código anterior esperava outro nome. Foi adotada a chave canônica sem quebrar rollback.
2. `IXC_RETRY_LIMIT` não era configurável. Agora aceita somente 0 ou 1.
3. O plano era inferido do contrato e não tinha consulta/telemetria própria. A leitura `getPlan` foi adicionada.
4. Customer 360 não apresentava latência total e por bloco. As métricas agora acompanham cada fonte.
5. Não existia persistência sanitizada para smoke, feedback e bugs do piloto. Foram adicionadas tabelas D1 e APIs protegidas.

## Validação executada

- contrato e smoke tests com fixtures sanitizadas;
- 401, 403, 429, 500 e timeout;
- cliente ausente, payload incompleto e campo inesperado;
- múltiplos contratos, fatura, pagamento, OS e conexão;
- cache, circuit breaker e falha parcial;
- allowlist antes da rede;
- sanitização de telemetria e feedback;
- migrations locais, backup e restore isolado.

## Pendências reais

- cadastrar `IXC_BASE_URL`, `IXC_API_TOKEN`, `IXC_ALLOWED_CUSTOMER_IDS` e `STAGING_JOB_SECRET` no gerenciador seguro;
- cadastrar 2 a 3 participantes em `PILOT_ALLOWED_USER_IDS`;
- ativar `IXC_MODE=staging-readonly` e `PILOT_MODE=internal` somente depois da prontidão;
- executar smoke real e preencher o relatório sem PII;
- executar o piloto de 3 a 5 dias úteis;
- corrigir bugs reais e decidir go/no-go.

## Rollback

Definir imediatamente `IXC_MODE=disabled` e `PILOT_MODE=disabled`, revogar o token IXC, retornar ao checkpoint anterior e preservar apenas auditoria sanitizada. As migrations são aditivas; não excluir tabelas durante resposta a incidente.

Decisão atual: **não avançar para clientes, escrita IXC ou WhatsApp real**.
