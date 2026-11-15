# Régua de cobrança: contrato observado e cobertura

Auditoria local sobre `e0b2ccc66cb6e090c4eb8d70db60c4b6b8c0b44e` (#94). Descreve esta candidata; não confirma configuração atual de produção nem aprovação comercial. Nenhuma consulta remota ou mensagem foi realizada.

| Tema | Comportamento no código | Evidência de teste existente / complemento |
| --- | --- | --- |
| Antes, no dia e depois do vencimento | Configuração aceita offsets inteiros de -30 a +180; seleção exige igualdade exata entre data civil do vencimento + offset e hoje em Brasília. | `tests/collection-dispatch.test.mjs` cobre D-3/D0; novo `tests/collection-calendar-boundaries.test.mjs` cobre D+3 e ausência de antecipação/catch-up. |
| Virada de dia | `businessToday` usa America/Sao_Paulo; prefixo da data de vencimento permanece data civil. | Novo teste: 02:59:59.999Z/03:00:00Z, mês, ano, ano bissexto e prefixo timestamp. `tests/billing-aging-civil-date.test.mjs` cobre datas civis inválidas no aging. |
| Janela de execução | Segunda a sexta, 08:00 inclusive até 20:00 exclusive, Brasília. Resolver candidatos não equivale a admitir execução. | Testes existentes de expediente/fim de semana; novo teste cobre os quatro limites exatos e sábado/domingo. Não há calendário de feriados neste predicado. |
| Promessa | Pendente pausa inclusive até a data prometida; dia seguinte libera avaliação, não escolhe nova etapa. Acesso bloqueado ou temporariamente liberado não muda a pausa. | `tests/unified-promise-pause.test.mjs`: fronteira civil, dois estados de acesso, renovação, estados terminais e dados incompletos. |
| Pagamento | Fonte fresca e saldo aberto confirmado antes de reservar; consumidor protegido revalida evidência antes da continuação simulada (não ligado ao worker padrão). | `tests/collection-dispatch-source.test.mjs` e `tests/collection-dispatch-route.test.mjs`: pagamento após preview/cache e após enfileiramento; fontes incompletas recusadas. |
| Duplicação | Ledger único por invoiceId/stepId/scheduledFor; fila recebe chave correspondente. Falha incerta da fila conserva reserva e não repete automaticamente. | `db/schema.ts` índice `collection_dispatches_once`; testes de concorrência em memória e falha de fila em `tests/collection-dispatch-route.test.mjs`. Isso não prova entrega exatamente uma vez em transporte real. |
| Envio | Consumo exige evidência confiável e continuação explícita; esta rodada chama somente funções puras. | `services/queue-runtime/src/billing-reminders.mjs`; testes de rota usam continuações simuladas. Nenhuma integração externa ativada. |

## Achados prioritários antes de operação real

1. **Ausência de status pode encerrar uma promessa sem comprovação de pagamento.** `app/api/billing/promises/route.ts:34` transforma ausência do provider ou erro de snapshot em mapa vazio. `evaluatePendingPromise` em `lib/platform/payment-promise-service.ts:97` retorna `fulfilled` para status `undefined`; a rota de revisão persiste o resultado. `tests/payment-promise.test.mjs` inclusive espera esse comportamento. Isso contrasta com o comentário de não concluir sem verificar o IXC e com a postura conservadora da seleção de cobrança. Uma falha de leitura pode remover a pausa da promessa; não prova pagamento nem envio ocorrido. Próxima correção deve distinguir consulta indisponível/incompleta de evidência positiva, com regressão da rota antes de mudar o comportamento. Não foi alterado aqui.
2. **Guard de consumo não está conectado ao worker padrão.** `services/queue-runtime/src/worker.mjs:8` registra o processador genérico em todas as filas; não usa `createProcessor` de `processor.mjs`. Os testes de rota chamam explicitamente o consumidor protegido com continuação fictícia. O worker genérico não envia mensagens, mas concluir seu job não comprova revalidação ou entrega. Integrar adaptador/guard é trabalho posterior; nenhum worker foi ativado nesta rodada.

## Divergências e decisões que continuam abertas

- A referência histórica a lembretes no vencimento ou depois não autoriza remover suporte a offsets negativos. Não foi localizada nesta leitura uma regra comercial posterior que confirme os offsets aprovados para operação. Nenhuma política foi alterada.
- Fim de semana ou promessa podem fazer passar a data exata de uma etapa. O código não faz recuperação automática na segunda-feira ou no fim da promessa: só uma etapa cuja data coincida com hoje será elegível. Escolher recuperação retroativa seria mudança comercial e técnica, fora desta entrega.
- `getLatest()` usa a versão mais recente, enquanto a persistência denomina a regra `draft`. Não há nessa rota um filtro de publicação. Esse rótulo não deve ser apresentado como aprovação para contato real.
- O resolvedor puro pressupõe data válida; a entrada real passa pela validação de `loadFreshDispatchInvoices`. Não se deve usar o resolvedor isolado como saneador de datas ou prova de autorização.
- A releitura pelo consumidor não é transação atômica com uma futura continuação externa; falha após efeito e antes de confirmação permanece sem prova de execução única.
- Reserva no ledger, enfileiramento e mensagem entregue são resultados diferentes. Fila indisponível pode deixar reserva sem envio; a prevenção de repetição não constitui reconciliação de entrega.

## Entrega e limites

Oito regressões novas, somente calendário, com fixtures fictícias. Comando:

`FEATURE_QUEUES=false node --experimental-strip-types --test tests/collection-calendar-boundaries.test.mjs`

Somente esse arquivo novo foi executado nesta rodada; a cobertura anterior acima foi inspecionada, não reexecutada. Nenhum runtime, política, schema ou configuração foi modificado. O teste não comprova banco concorrente real, trabalhador hospedado, WhatsApp ou efeitos em clientes. A próxima validação operacional depende de confirmar configuração comercial e dos gates independentes de implantação; esta auditoria não os libera.
