# Arquitetura do LZR HUB

## Objetivo

O LZR HUB é a camada de inteligência, regras, Customer 360, auditoria e interface da operação. Serviços externos permanecem desacoplados e são acessados somente por contratos de adaptadores.

## Pipeline único

```text
Mensagem -> Conversation State -> Intent Analyzer -> Execution Planner
         -> Tool Engine -> comprovantes/artefatos -> Response Generator
         -> Generic Response Guard -> Evaluator -> Supervisor
```

O AI Training Mode chama exatamente a mesma rota `/api/agent`. Ele apenas expõe a avaliação posterior e permite registrar um caso aprovado.

## Fontes de verdade

- IXC: cliente, contrato, fatura, pagamento e ordem de serviço.
- LZR HUB: políticas, contexto unificado, IA, workflows, permissões e auditoria.
- Chatwoot: mensagens, conversas, inbox, equipes e atribuição.
- PostgreSQL/pgvector: conhecimento revisado e recuperação semântica.
- Redis/BullMQ: filas, retries e tarefas assíncronas.
- Langfuse: observabilidade opcional, nunca fonte transacional.

## Invariantes

1. Nenhuma resposta confirma ação sem `ToolReceipt` concluído.
2. Artefatos fazem parte do resultado da ferramenta e da mensagem entregue.
3. Falhas não viram sucesso textual.
4. A integração real fica desligada por padrão.
5. Logs e telemetria devem mascarar PII.
6. Escritas futuras no IXC exigirão permissão, política, idempotência e auditoria.

## Estado desta fundação

Os adaptadores reais ainda não estão conectados. O modo atual usa dados fictícios e contratos mock. O painel informa explicitamente o modo de cada serviço.

## Fase 2 profissional

- `Customer360Service` agrega contrato, financeiro, rede, suporte e inteligência com `Promise.allSettled` e falha parcial explícita.
- Suporte correlaciona incidentes, mapa, clientes afetados, chamados e massivas demonstrativas.
- Cobrança possui régua versionada e campanhas confirmadas administrativamente, sempre em modo demo.
- Comercial mantém leads, cobertura mock, funil, metas e oportunidades sem confirmar venda no IXC.
- Customer Intelligence calcula saúde e risco operacional por regras explicáveis e versionadas.
- Conhecimento mantém documentos, versões e evidências; ausência de evidência exige pergunta ou handoff.
- Filas possuem idempotência, correlação, tentativas, falha, DLQ, reprocessamento e cancelamento demonstrativos.
- RBAC e auditoria protegem ações e registram origem humana/IA.
- O núcleo conversacional persiste fingerprints e impede repetição sem progresso.
