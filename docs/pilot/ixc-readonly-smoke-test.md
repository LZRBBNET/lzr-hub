# Smoke test IXC somente leitura

Status em 12/07/2026: **não executado contra o IXC real**. Motivo: `IXC_BASE_URL`, `IXC_API_TOKEN`, `IXC_ALLOWED_CUSTOMER_IDS` e `STAGING_JOB_SECRET` ainda não estavam configurados no gerenciador seguro. O sistema permaneceu fechado e não realizou chamada externa.

Quando os secrets forem configurados, executar `POST /api/integrations/ixc/smoke` com autenticação administrativa e um único ID autorizado. O resultado persiste apenas metadados sanitizados.

| Operação | Resultado | Latência | Cache | Registros | Erro sanitizado | Correlação |
|---|---|---:|---|---:|---|---|
| autenticação | pendente | — | none | — | secrets ausentes | — |
| cliente | pendente | — | miss | — | — | — |
| contratos | pendente | — | miss | — | — | — |
| plano | pendente | — | miss | — | — | — |
| faturas | pendente | — | miss | — | — | — |
| pagamentos | pendente | — | miss | — | — | — |
| OS | pendente | — | miss | — | — | — |
| conexão | pendente | — | miss | — | — | — |
| cache | pendente | — | hit | — | — | — |

É proibido copiar nome, CPF/CNPJ, telefone, endereço, login, cobrança ou resposta bruta para este documento.
