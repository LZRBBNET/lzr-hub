# Secrets IXC — staging somente leitura

Configure exclusivamente pelo gerenciador seguro do Sites, nunca em arquivo versionado ou mensagem de log.

| Chave | Tipo | Regra |
|---|---|---|
| `IXC_MODE` | env | `staging-readonly` somente após todos os secrets |
| `IXC_BASE_URL` | secret | origem HTTPS autorizada, sem caminho de escrita |
| `IXC_API_TOKEN` | secret | token exclusivo e com menor privilégio |
| `IXC_ALLOWED_CUSTOMER_IDS` | secret | 1 a 10 IDs internos autorizados, separados por vírgula |
| `IXC_TIMEOUT_MS` | env | 500–10000; padrão 3500 |
| `IXC_RETRY_LIMIT` | env | 0 ou 1; somente 429/5xx/timeout |
| `IXC_CACHE_TTL_SECONDS` | env | 30–3600; padrão 300 |
| `STAGING_JOB_SECRET` | secret | autentica smoke/sync administrativo |

Ordem segura: cadastrar URL, token, allowlist e segredo administrativo; manter `IXC_MODE=disabled`; validar prontidão sem valores; por último alterar para `staging-readonly` e publicar nova revisão. Se qualquer validação falhar, retornar `IXC_MODE=disabled` e revogar o token.

O código rejeita produção, escrita, allowlist vazia, mais de 10 IDs e IDs com formato inesperado. O nome antigo `IXC_ALLOWLIST_IDS` é lido apenas para rollback compatível; novas configurações devem usar `IXC_ALLOWED_CUSTOMER_IDS`.
