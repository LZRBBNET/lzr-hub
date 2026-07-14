# Relatório da Fase 3A — homologação IXC somente leitura

## Escopo entregue

- Branch: `feat/staging-ixc-readonly`
- Base: `e45a371`
- Arquitetura: Cloudflare D1 + Drizzle, jobs/checkpoints/DLQ persistíveis em D1 e busca híbrida com evidência.
- Migration `0001_sticky_pyro.sql`: aditiva, com cache, jobs, checkpoints e saúde.
- Scripts: create, migrate, seed, status, backup e restore test.
- IXC: provider `staging-readonly`, nove operações sem efeito colateral e escrita bloqueada por guard.
- Allowlist: validação de 1 a 10 IDs; nenhum ID real versionado.
- Mappers: cliente, contrato, fatura, pagamento, OS e conexão.
- Resiliência: timeout, retry curto, rate limit, circuit breaker, TTL, deduplicação, checkpoint e DLQ.
- Observabilidade: correlação, latência, falhas, cache, jobs, health e auditoria sanitizada.
- Customer 360: fonte/modo/cache/horário/erro parcial e dados mascarados.

## Reais e mocks

Reais nesta entrega: código, D1 local de homologação, migrations, seed sintético, backup/restore, guards, contratos, painel e testes. O D1 hospedado é provisionado pelo checkpoint do Sites.

Permanecem mock ou desativados: Meta/WhatsApp, Chatwoot, envio de cobrança, desbloqueio, alteração de plano, OS real, comandos de rede e IA externa. A conexão IXC real só fica ativa depois que URL, token somente leitura e IDs autorizados forem fornecidos como secrets; sem isso, o sistema falha fechado.

## Rollback

Retornar ao checkpoint anterior para aplicação. A migration é aditiva e não deve ser revertida destruindo tabelas durante incidente. Desativar `IXC_MODE`, revogar o token e manter evidências sanitizadas. O restore foi validado em banco local isolado.

## Riscos restantes

- Credenciais e allowlist reais ainda precisam de aprovação e configuração fora do Git.
- Os nomes exatos dos recursos IXC devem ser confirmados contra a versão instalada da BBNET no teste de conexão.
- Agendamento permanece desligado até o piloto validar carga e rate limit.
- Produção e qualquer escrita continuam fora do escopo.

## Próximo passo autorizado

Configurar secrets de staging e até 10 IDs internos autorizados; executar teste de conexão e contrato contra o IXC real; iniciar piloto com 2 a 3 usuários. Não habilitar escrita.
