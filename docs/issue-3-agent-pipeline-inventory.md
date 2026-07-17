# Issue #3 — inventário do pipeline de atendimento

## Escopo e base analisada

- Issue: `#3 — Homologar o pipeline de IA (/api/agent) de ponta a ponta com casos reais`.
- Branch de trabalho: `feat/issue-3-agent-pipeline-homologation`.
- Base local analisada: `d3d0b54` (conteúdo publicado na `main` do GitHub em `f8adec5`).
- Áreas deliberadamente fora do escopo: `lib/integrations/ixc/**`, autenticação/HTTP/allowlist IXC, endpoints de staging IXC, Postman, WhatsApp e escrita real.
- Flags de escrita mantidas desligadas: `IXC_WRITE_ENABLED=false` e `FEATURE_IXC_WRITE=false`.

## Fluxo implementado antes da homologação

```text
POST /api/agent
  -> valida message (string, 1..5000) e limita history às 40 últimas entradas
  -> runAgentPipeline(message, history)
     -> analyzeIntent (regras determinísticas)
     -> resolução simples de respostas curtas/referências pelo histórico
     -> execute (ferramentas demonstrativas embutidas no pipeline)
     -> responseFor (texto por intenção)
     -> detector de repetição
     -> evaluate
     -> AgentResult + ConversationState + correlationId
```

## Arquivos e responsabilidades

| Área | Arquivo | Responsabilidade atual |
| --- | --- | --- |
| Endpoint | `app/api/agent/route.ts` | Parse do JSON, validação mínima e limite de histórico |
| Orquestração | `lib/agent/pipeline.ts` | Intenção, seleção/execução demonstrativa, resposta, avaliação e estado |
| Contratos | `lib/agent/types.ts` | Intenções, recibos, resultado, avaliação e estado persistível |
| Repetição | `lib/agent/repetition.ts` | Normalização, similaridade, número de perguntas e falsa alegação simples |
| Conhecimento | `lib/platform/knowledge-service.ts` | Ingestão/publicação e busca lexical em memória |
| Observabilidade | `lib/observability/telemetry.ts` | Eventos sanitizados; ainda não é chamado pelo pipeline do agente |
| Testes do agente | `tests/agent-conversation.test.mjs` | Continuidade, repetição, artefatos, transbordo e mudança de assunto |
| Teste HTTP/render | `tests/rendered-html.test.mjs` | Shell e um fluxo PIX pela rota compilada |

## Entrada e saída atuais

Entrada HTTP: `{ message: string, history?: ChatMessage[] }`. A mensagem é limitada a 5.000 caracteres; o histórico é truncado para 40 entradas, mas seus itens ainda não eram validados estruturalmente.

Saída: `AgentResult`, com intenção, confiança, objetivo, estado, texto, `ToolReceipt[]`, pendências, resumo, próximo passo, avaliação, estado conversacional e correlação. Antes da homologação, `ToolReceipt.status` distinguia apenas `completed` e `failed`.

## Intenções e ferramentas disponíveis

Intenções iniciais: falta de conexão, lentidão, Wi-Fi, boleto, PIX, desbloqueio, humano e informação geral.

Ferramentas demonstrativas iniciais:

- `customer.lookup`;
- `billing.open_invoice`, `billing.generate_pix`, `billing.issue_copy`, `billing.payment_status`;
- `network.onu_status`, `network.pppoe_status`, `network.optical_power`, `network.regional_incident`, `network.session_diagnostics`, `network.cpe_status`, `network.wifi_diagnostics`;
- `support.open_ticket`;
- `workflow.create_handoff`;
- `knowledge.search`.

Todas eram implementadas como resultados locais dentro de `pipeline.ts`; não existe chamada IXC nesse fluxo.

## Estado, histórico e avaliação

- O endpoint preserva no máximo 40 mensagens.
- Respostas curtas (`sim`, `não`, `cadê`, `onde`, `não funcionou`, `já reiniciei`) tentam herdar a intenção anterior.
- Mudança explícita de assunto prevalece sobre o histórico.
- A repetição usa Jaccard de trigramas e similaridade da abertura nas três últimas respostas.
- A avaliação fornece notas e detecta falsa alegação somente quando não há ferramenta `completed`.
- Não havia política formal para irritação, reclamação, ameaça de cancelamento, dados contraditórios ou repetição sem resolução.

## Linha de base

| Comando | Resultado | Duração aproximada | Observação |
| --- | --- | ---: | --- |
| `npm ci` | FALHOU | 9 s | Ambiente tentou criar `/root/.npm`; limitação ambiental, sem alteração de produto |
| `npm run install:ci` | APROVADO | 10 s | Caminho suportado pelo projeto, com HOME/cache locais |
| `npm run lint` | APROVADO | 3,4 s | Sem avisos do código |
| `npm run typecheck` | APROVADO | 2,7 s | TypeScript sem erros |
| `npm test` | APROVADO | 3,1 s | 38/38 testes; inclui build |
| `npm run build` | APROVADO | 2,7 s | Artefato Vinext gerado e validado |
| `npm run validate:artifact` | APROVADO | 0,2 s | Worker ESM e manifesto presentes |

## Riscos e lacunas encontrados

1. Toda ferramenta embutida retornava sucesso; timeout, indisponibilidade, retorno vazio, parcial e proibido não eram representáveis.
2. Uma ferramenta `completed` bastava para permitir frases de sucesso, sem exigir evidência específica da alegação.
3. Ações de boleto, PIX, chamado e transbordo eram demonstrativas, mas o contrato não expunha isso de forma estruturada.
4. `tools.every(status === completed)` marcava o turno como entregue mesmo quando a resposta fazia uma pergunta complementar.
5. Não havia resultado padronizado para ação real, simulação, evidências, alertas, motivo de transbordo e estado final.
6. Handoff dependia quase somente do pedido explícito por humano.
7. JSON/histórico malformados não possuíam testes de contrato suficientes.
8. Cobertura conversacional era pequena diante dos 60 cenários obrigatórios.
9. A validação de falsa confirmação não relacionava verbo, ferramenta, resultado e evidência.
10. O pipeline não emitia telemetria própria e o resumo não formalizava dados coletados, falhas e recomendação ao atendente.

## Pontos de falsa confirmação

- `execute()` criava recibos demonstrativos com `completed`.
- `responseFor()` usava “gerei”, “anexada”, “aberto” e “transferi” sem distinguir simulação de execução externa.
- O estado `delivered` derivava apenas de todos os recibos terem status `completed`.
- `hasFalseActionClaim()` só bloqueava alegações quando o total de ferramentas concluídas era zero.

## Plano de implementação

1. Preservar `status: completed|failed` para consumidores existentes e acrescentar um resultado operacional normalizado.
2. Extrair um executor demonstrativo controlável, sempre identificado como simulação e sem integração externa.
3. Relacionar alegações de sucesso a evidência válida e ao recibo da ferramenta correta.
4. Formalizar política de transbordo e resumo sanitizado para o atendente.
5. Validar o corpo e o histórico na borda HTTP.
6. Criar um contrato tipado de cenários e executor comum para os 60 casos.
7. Testar propriedades estruturais, evitando snapshots frágeis de texto longo.
8. Documentar resultados, bloqueios externos e prontidão da Issue #3.
