# Relatório de validação — relay IXC

Data: 2026-07-24  
Branch: `feat/ixc-fixed-egress-relay`  
Issue: #25  
Base GitHub: `main` (`f8adec5`)

## Escopo validado

- transporte `direct` e `relay`;
- produção sem token IXC no Worker;
- ausência de fallback relay → direct;
- HMAC SHA-256, timestamp, nonce e replay;
- Cloudflare Access obrigatório na borda do relay;
- catálogo fixo de oito operações read-only;
- bloqueio de URL, resource, path, query, método, headers e corpo IXC arbitrários;
- allowlist de clientes antes da chamada upstream;
- timeout, retry limitado, rate limit, concorrência e circuit breaker;
- sanitização de resposta de erro e logs;
- health/ready sem consultar IXC;
- container e deployment declarativos.

## Linha de base

Antes das alterações:

- 38/38 testes do LZR HUB aprovados;
- lint, typecheck, build e artefato aprovados.

## Resultado final

| Comando | Resultado | Duração |
| --- | --- | ---: |
| `npm run install:ci` | aprovado | 10,519 s |
| `npm run lint` | aprovado, zero warnings | 3,009 s |
| `npm run typecheck` | aprovado | 5,923 s |
| `npm test` | 43/43 aprovados | 3,271 s |
| `npm run build` | aprovado | 2,766 s |
| `npm run validate:artifact` | aprovado | 0,156 s |
| `npm run test:relay` | 41/41 aprovados | 0,438 s |
| `npm run typecheck:relay` | aprovado | 1,037 s |

Total: 84 testes aprovados, zero falhas.

Os testes usam IXC e relay falsos. Nenhuma suíte automatizada apontou para a API real.

## Cobertura relevante

Os 41 testes próprios do relay cobrem:

- operação permitida e proibida;
- campos, URL, resource, headers, método, query e payload arbitrários;
- assinatura válida, inválida e ausente;
- Access ausente;
- timestamp expirado;
- replay;
- corpo alterado;
- correlation ID;
- allowlist;
- ausência de token em resposta/log;
- timeout, 429, 500, autenticação, permissão e IP;
- resposta inválida e vazia;
- circuit breaker e rate limit;
- limite de corpo e JSON/Content-Type inválidos;
- flags de escrita;
- segredo ausente;
- health, ready e logs sanitizados.

Os cinco testes de integração no HUB cobrem:

- Worker → relay assinado;
- produção relay sem token;
- produção bloqueando direct;
- direct somente em staging controlado;
- falha do relay sem fallback direto.

Os 38 testes antigos continuaram aprovados.

## Validações bloqueadas

| Item | Estado | Motivo |
| --- | --- | --- |
| IP pertence ao servidor/NAT | BLOQUEADO POR INFRAESTRUTURA | sem acesso ao servidor |
| egress IPv4 `168.181.31.250` | BLOQUEADO POR INFRAESTRUTURA | sem shell no servidor |
| estabilidade/NAT/CGNAT/assimetria | BLOQUEADO POR INFRAESTRUTURA | sem acesso à rede |
| acesso relay → IXC real | BLOQUEADO POR INFRAESTRUTURA | relay não implantado |
| allowlist IXC | BLOQUEADO POR INFRAESTRUTURA | egress não comprovado |
| Worker → Access → Tunnel → relay | BLOQUEADO POR INFRAESTRUTURA | Tunnel/Access não configurados |
| smoke real | BLOQUEADO POR INFRAESTRUTURA | dependências acima |
| build/inspect da imagem Docker | BLOQUEADO PELO AMBIENTE DE EXECUÇÃO | binário Docker indisponível |
| validação cruzada Postman | BLOQUEADO POR TRABALHO DEPENDENTE | Collection da Issue #23 ausente na `main` |

## Segurança e impacto real

- zero operação real de escrita;
- zero chamada à API real do IXC;
- zero alteração de cliente, contrato, cobrança, pagamento ou OS;
- `IXC_WRITE_ENABLED=false`;
- `FEATURE_IXC_WRITE=false`;
- nenhum secret real versionado;
- o token IXC é proibido no Worker quando `LZR_ENV=production`;
- produção falha fechada se o relay estiver indisponível.

## Decisão

Pronto para revisão de código e preparação controlada do servidor.

Não pronto para produção até comprovar egress, liberar o IP no IXC, implantar Tunnel/Access, configurar secrets e concluir o smoke test read-only.
