# Revisão da fronteira de envio e carga da fila

Base inspecionada: f6900cd8152831c15b84c8149cc5927aed32e6c8, PR draft #110. Revisão local de código; nenhum banco, provedor, chave ou dado operacional consultado. Este documento não remove os dois gates abaixo e não autoriza implantação.

## Fronteira de envio: o que está comprovado

`persistHumanHandoff` grava inbound/contexto e chama `recordTriage` antes de enviar a confirmação. `DbTicketRepository.updateTriage` altera o ticket, mas não participa de `lockDelivery`. Já `DbConversationDelivery.begin` usa essa trava, verifica reserva e responsável da conversa e cria uma reserva por token. Ele não verifica ticket, geração ou origem do turno. A devolução humana usa a trava existente; o handoff automático não.

Depois de `await delivery.begin`, `metaAutoReplySender` chama `sendTextMessage`/`sendInteractiveList`; `cloud-client.post` invoca `fetch`. Não há autorização comum ao ticket nesse intervalo. A reserva no banco não comprova que `fetch` começou, assim como `fetch` iniciado não comprova aceite ou entrega Meta.

| Intercalação | Comportamento atual | Garantia possível sem mudar protocolo |
| --- | --- | --- |
| Turno A ainda no modelo; B persiste handoff; A chega a begin | A pode reservar e iniciar chamada, se ninguém assumiu | Nenhuma proteção por handoff nessa fronteira |
| A termina begin; B persiste handoff; A ainda não invocou fetch | A pode iniciar chamada depois da transferência | Uma nova leitura apenas estreita o intervalo; não elimina a corrida |
| A invoca fetch; B persiste handoff | A chamada já começou; resposta pode chegar depois | Não é possível desfazer envio com UPDATE ou assumir que AbortController o cancelou no provedor |
| B persiste handoff e tenta sua própria confirmação | A confirmação usa o mesmo sender de qualquer turno | Bloquear todo ticket em handoff também bloqueia a confirmação legítima |

Portanto não foi acrescentada uma checagem simples de stage: ela não distingue as duas origens e não fornece a garantia pedida. Não foi introduzida transação mantida durante chamada de rede. Nenhuma garantia de “nenhuma chamada depois de handoff” deve ser derivada apenas de uma reserva `pending`.

## Menor próximo corte verificável de concorrência

1. Persistir uma geração/versão de posse por atendimento. Capturá-la no começo do turno; invalidá-la ao encaminhar, devolver ou resolver. Mudanças e autorização de despacho precisam usar a mesma trava curta por canal/conversa, incluindo todos os caminhos de envio automático.
2. A confirmação do próprio encaminhamento recebe uma permissão específica, de uso único, vinculada ao evento/turno e à geração resultante. Um booleano recebido do chamador não é suficiente. Nenhuma permissão antiga sobrevive a release/resolve.
3. Antes de despachar, verificar geração, titularidade, janela e chave idempotente; registrar autorização de despacho separada de chamada iniciada, aceite Meta e recibo. Resultado incerto conserva reserva para reconciliação.
4. Isso garante que não haja NOVA autorização para turno obsoleto depois da transferência, mas não prova que uma autorização anterior já invocou fetch. Para ordenar a invocação efetiva em relação à transferência, é necessário um único executor de despacho/decisão por conversa, com fencing na retomada após falha. A decisão precisa reconhecer despacho já autorizado como pendência até o executor reconciliá-lo; não pode chamá-lo automaticamente de envio iniciado. Essa mudança de protocolo/worker excede uma guarda de sender.
5. Verificar em PostgreSQL isolado as intercalações antes de begin, depois do commit de begin/antes de fetch, durante fetch, release/resolve e queda do worker. Testar também confirmação própria, recuperação de reserva incerta e retomada com geração antiga. Os testes em memória anteriores não provam essas propriedades.

Até esse corte, operação automática concorrente continua bloqueada; as proteções atuais preservam fila/estado, mas não revogam turnos já iniciados. Isso não impede revisão independente do PR ou operação humana já autorizada pelas regras existentes.

## Carga e paginação: escopo necessário

`listConversations` seleciona recentes e todas as pendências explícitas e depois lê todo o histórico e todos os outcomes dessas conversas. Portanto o custo depende tanto da quantidade de pendências quanto da duração do histórico. Apenas adicionar LIMIT às pendências faria casos desaparecerem: `/api/conversations` não retorna cursor/total; Atendimentos deriva filtros e fila do array recebido; o contador global também conta esse array. O poll da tela repete a leitura a cada cinco segundos.

Próximo corte proposto, sem alterar a consulta atual neste commit:

- Endpoint de fila com `items`, `nextCursor`, `hasMore` e agregados independentes (`pendingCount`, `oldestPendingAt`), escopados por autorização, canal e filtros. Página vazia/erro não significa fila vazia; estado resolvido deve prevalecer sobre ticket legado inconsistente.
- Cursor por ordem estável de início da pendência e ID do atendimento/conversa (com desempate por canal). Não usar offset nem timestamp da última mensagem como única chave: novo inbound move registros e causa saltos. Atribuições sem ticket exigem identidade equivalente persistida. Refresh do começo captura novas pendências; cliente deduplica por canal/ID e mantém contexto selecionado.
- Buscar somente resumo da página: última mensagem/cliente, espera agregada, estado e último outcome. Histórico completo fica na abertura da conversa, já limitada. Agregados não devem depender de todos os textos carregados no processo Node.
- Atualizar Atendimentos com carregamento explícito das próximas páginas e erro recuperável; contador global e dashboard usam agregados, não comprimento da página. Busca e “Minhas” precisam ser feitas no servidor antes de paginar, não sobre uma página parcial.
- Verificar mais pendências que o tamanho da página, mesma data em canais diferentes, novo inbound durante paginação, assumir/devolver/resolver entre páginas, refresh, erro de próxima página e resolved→novo inbound. Medir plano SQL/índices em ambiente isolado antes de escolher limite.

Não foi imposto teto silencioso nem criada escala. O PR mantém os gates de concorrência e de carga documentados; este commit é análise, sem alteração de comportamento ou migração.
