# Fronteiras de integração

| Serviço | Responsabilidade | Modo inicial | Escrita real |
|---|---|---|---|
| IXC | Cadastro, contrato, financeiro e OS | mock | bloqueada |
| Meta WhatsApp | Transporte oficial de mensagens | desativado | bloqueada |
| Evolution API | Canal de homologação | desativado | bloqueada |
| Chatwoot | Omnichannel e operação | desativado | bloqueada |
| BullMQ/Redis | Filas e retries | desativado | não aplicável |
| Langfuse | Traces sanitizados | desativado | não transacional |
| pgvector | Conhecimento revisado | desativado | somente conteúdo aprovado |

Controladores e componentes não devem importar SDKs de fornecedores. Toda integração passa pelas interfaces em `lib/integrations/contracts.ts`.
