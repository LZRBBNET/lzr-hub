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

## Nota de arquitetura: `IXC_BASE_URL` aponta para a ponte, não para o IXC direto

O Cloudflare Workers não tem IP de saída fixo, e o webservice do IXC exige IP liberado ("Redes Permitidas"). Por isso `IXC_BASE_URL`/`IXC_API_TOKEN` em staging e produção devem apontar para a ponte própria (servidor com IP fixo dedicado) que repassa a chamada ao IXC — nunca direto para `ixc.bbnetup.com.br`. Nesse caso, `IXC_API_TOKEN` é o segredo compartilhado da ponte (`BRIDGE_SHARED_SECRET`), não o token real do IXC — o token real fica só dentro da ponte. Ver `docs/integrations/ixc-data-mapping.md` para o histórico da descoberta.

## Ponte em produção: `https://ixc-bridge.bbnetup.com.br`

A ponte está no ar com HTTPS (Caddy + Let's Encrypt) em `srv-ixc` (168.181.28.74), com egress fixo em `168.181.31.250`. O firewall (`ufw`) só libera a porta 443 pra faixas de IP do Cloudflare — nenhuma outra origem consegue chamar essa URL diretamente (nem de um PC de desenvolvedor). Por isso:

- **Deploy real (staging/produção no Cloudflare Workers)**: configurar via `wrangler secret put IXC_BASE_URL` com o valor `https://ixc-bridge.bbnetup.com.br` e `wrangler secret put IXC_API_TOKEN` com o `BRIDGE_SHARED_SECRET` da ponte.
- **Dev local (`.env.local`)**: continua usando um túnel SSH (`ssh -N -L 3000:localhost:3000 bbnet@168.181.28.74 -p 27977`) e `IXC_BASE_URL=http://localhost:3000`, porque o seu PC não é um IP do Cloudflare e seria bloqueado pelo firewall na porta 443 pública.
