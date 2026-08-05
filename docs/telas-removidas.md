# Telas removidas do menu — e o que falta para cada uma voltar

Sete itens saíram da navegação em 05/08/2026. Nenhum deles tinha fonte de dados:
todos mostravam um aviso explicando o que faltava. O aviso era honesto, mas o
item continuava no menu, e item de menu que não leva a lugar nenhum ensina quem
usa a desconfiar do sistema inteiro — inclusive das telas que funcionam.

O texto que essas telas exibiam está preservado aqui. O código foi removido; o
histórico está no Git. Quando a fonte de dados existir, a tela volta.

## Leads, Funil e Kanban — depende de um CRM

Antes viviam de dados de demonstração num `useState`: dava para "criar" um lead
e "mover de etapa", e tudo sumia ao recarregar a página.

Hoje **nenhum lead é registrado em lugar nenhum** — nem no LZR HUB, nem no IXC.
O primeiro registro que existe de um cliente é o contrato já assinado.

Para existir:

| O que falta | Por quê |
|---|---|
| Captura do contato | Alguém precisa registrar o interessado antes da venda |
| Origem | De onde veio (WhatsApp, indicação, campanha) — sem isso não há como comparar canais |
| Etapas e responsável | Um funil só significa algo se a mudança de etapa for gravada com quem moveu e quando |
| Consulta de cobertura | Qualificar lead sem saber se o endereço tem rede é chute |

Existe a tabela `leads` no schema, sem nenhuma rota que escreva nela.

## Saúde do Cliente, Upgrade e Customer Intelligence — depende de sinal não coletado

Antes exibiam um score que `calculateHealth()` devolvia **igual para todo
cliente**, a partir de fatores fixos no código. Score inventado é pior que score
nenhum: as pessoas passam a priorizar atendimento por ele.

Para um score de saúde existir:

| Sinal | Situação |
|---|---|
| Consumo | Não é coletado; exigiria integração de monitoramento de rede |
| Reincidência de chamado | As OS existem no IXC, mas nada correlaciona repetição por cliente |
| Comportamento de pagamento | Atraso recorrente é o sinal mais forte que existe. Está no IXC e ainda não é lido por cliente |
| Satisfação | O CSAT só é coletado quando a IA responde — e ela está em modo observação |

Para oportunidade de upgrade, além disso: consumo contra o plano contratado,
cobertura no endereço (oferecer plano que a rede não entrega gera cancelamento,
não venda) e histórico de recusa.

## Campanhas de cobrança — depende de canal de envio ligado

A tela simulava criar campanha e enfileirar job, com público inventado.
Enfileirar uma campanha de verdade manda mensagem para cliente de verdade, e
isso não pode ser demonstrado como se fosse real.

Depende de `FEATURE_QUEUES` e de um canal de envio autorizado. A **régua**
(configuração de quando falar com quem está em atraso) continua no menu e é
real: salvar régua não dispara mensagem nenhuma.

## O que continua medido de verdade

- **Churn realizado** — contratos encerrados, lidos do IXC
- **Vendas fechadas** — contratos ativados, lidos do IXC
- **Posição financeira** — faturas em aberto e vencidas, lidas do IXC
- **Atendimento da IA** — desfechos e avaliações das conversas gravadas
