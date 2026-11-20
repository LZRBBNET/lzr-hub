# Geração e autorização de despacho — PR #110

Base de implementação: c60019898cf0340edda125212620fbe97b3fe0cc. Nenhuma ativação, merge, migração de produção ou chamada externa.

## Contrato

A rota Meta captura uma geração antes da triagem/modelo. O registro por inbound é durável: retry recupera a geração original, nunca recebe uma geração atualizada só porque a conversa foi devolvida à IA. Handoff, assumir, devolver e resolver invalidam permissões antigas sob a mesma trava curta de conversa. Atualizações de triagem vinculadas a turno obsoleto também são recusadas.

O handoff grava etapa do ticket, nova geração e uma permissão de confirmação do próprio inbound na mesma transação. Essa confirmação é diferente da resposta comum: pode operar no modo humano, mas somente enquanto sua geração e operação continuarem atuais. Uma tomada/devolução/resolução antes do despacho a invalida. Falha de COMMIT não atualiza a permissão em memória.

Não há nova tabela/migração: usam-se registros com prefixos conversation-fence e conversation-turn na tabela de idempotência existente, com chaves derivadas de canal/conversa/inbound. O remetente continua usando autoreply e a reserva delivery existente. Não apagar esses registros para liberar retry: o consumo do turno é durável, inclusive se a chave de envio for encerrada/reconciliada.

| Estado | O que significa | Transferência |
| --- | --- | --- |
| prepared | Reserva existe, sem autorização de transporte | Pode revogar a reserva e invalidar o turno |
| dispatch_authorized | Autorização de uso único consumida; ainda NÃO comprova chamada iniciada, aceite ou entrega | Recusada até conclusão/reconciliação |
| uncertain + workerSettled | Worker encerrou tentativa, resultado ou autorização requer reconciliação | Continua bloqueada; usa o fluxo autenticado de reconciliação existente |
| reserva concluída | Transporte retornou e registro foi concluído, ou reserva foi reconciliada | Pode ocorrer, com nova geração |

A checagem de autorização é a última operação de banco antes da invocação do transporte. Não se mantém transação/lock de banco aberto enquanto se aguarda rede. A transição humana e essa autorização usam a mesma trava; somente uma ordem vence. Se a autorização venceu primeiro, a transferência retorna conflito/não confirmada: NÃO está concluída enquanto a reserva estiver aberta. O chamador precisa retomar a transferência depois da conclusão/reconciliação. Reserva não significa que o provedor já foi chamado; não há promessa de desfazer envio iniciado.

Se a transferência venceu, nenhum turno da geração anterior consegue nova autorização, mesmo com resposta do modelo pronta, retry ou retorno posterior à IA. A confirmação própria é de uso único. Rejeição não pode limpar reserva já autorizada nem reserva de outro token. Ausência do mecanismo de fence no sender automático bloqueia envio, sem fallback livre. A confirmação automática SAIR/VOLTAR da mesma rota também passa pelo remetente cercado, eliminando o bypass direto dessa entrada; regras de opt-in/out não foram alteradas.

Auditoria identifica rotação, preparação revogada, turno obsoleto, autorização, conflito de transferência e resultado incerto. Eventos de autorização não afirmam entrega. Perda da resposta do COMMIT da autorização não inicia transporte nesse worker: preserva a operação e tenta marcá-la para reconciliação. Se o banco continuar indisponível, a reserva permanece bloqueada. Queda abrupta depois da autorização e antes do transporte não recebe expiração automática nem liberação cega: requer comprovação de encerramento do worker.

## Ativação e rollback

Sem apply de schema. A garantia requer TODOS os workers/remetentes e rotas de posse desta versão. Antes de ativação autorizada, desabilitar ingresso/envios automáticos nas versões antigas, drenar ou reconciliar reservas pendentes e substituir todas as réplicas. Não fazer rolling enable com workers antigos ainda capazes de enviar sem fence. A flag/controle operacional efetivo deve ser confirmado pelo operador; este PR não modifica configuração.

Rollback de código é compatível com o schema, mas não preserva a garantia: desligar envios e drenar/reconciliar antes de voltar. Não remover os novos registros nem marcar dispatch_authorized como enviado. Uma versão antiga ignora esses registros; isso não a torna segura para retomar automação. Nenhum passo de ativação/rollback foi executado.

## Validação isolada

Teste PostgreSQL opt-in em tests/conversation-fence.pg.test.mjs aceita somente socket Unix sob /tmp/lzr-fence-*. Não lê DATABASE_URL e não usa rede TCP. Foi executado em PostgreSQL 17.12 local, contêiner sem rede/portas, dados efêmeros, com as 25 migrações locais. Fetcher do sender é um stub local; nenhum provedor foi chamado.

Casos: handoff antes do begin; revogação entre preparação e autorização; confirmação própria e uso único; takeover/devolução/resolução; retry com geração antiga; autorização antes de transferência (conflito); resultado incerto; perda de resposta de COMMIT sem chamada de transporte; aceite com falha de conclusão preserva reserva incerta sem reenvio; callback antigo não remove reserva nova; oito disputas concorrentes reais no PostgreSQL. Testes locais existentes de sender/triagem foram atualizados com dependências de fence explícitas, sem usar isso como prova de concorrência.

Este corte protege o despacho de resposta da rota Meta. Não certifica ações IXC/OS, publicação n8n, carga operacional, entrega ao cliente/técnico ou outros serviços de campanhas. Não modifica o patch independente de elegibilidade de OS. Uma entrada recebida durante autorização em andamento pode ficar aguardando conclusão/reconciliação antes de efetivar a transferência; o conflito não deve ser apresentado como encaminhamento concluído.

Resultado deste corte: 10 testes PostgreSQL (incluindo suíte), 126 testes unitários focados, TypeScript e ESLint direcionado passaram. O banco efêmero usa somente fixtures sintéticas.

## Recuperação e isolamento de lote após revisão

A reconciliação autenticada agora admite também `pending + bot + dispatch_authorized`, exclusivamente com referência explícita da confirmação operacional de que todos os workers capazes de executar aquela reserva foram interrompidos e não podem retomar. Essa confirmação é uma declaração auditada do supervisor/administrador, não um detector automático de processos. Além dela, continua obrigatória a conclusão comprovada no provedor (aceita com ID, ou não enviada com confirmação explícita). Sem qualquer uma das provas, manter bloqueado. Não existe TTL, reenvio ou classificação de ausência de recibo como não enviada.

Sob a mesma trava, a operação revalida sessão/permissão, token da reserva, canal/conversa, geração, token consumido no turno e vínculo da operação. Reservas preparadas, humanas, legadas ou inconsistentes não recebem essa exceção. Auditoria, ledger idempotente, encerramento da operação e remoção da reserva são atômicos. O turno continua consumido; replay não envia. O formulário distingue a evidência do worker da evidência do provedor. Se o operador não conseguir identificar os executores responsáveis, deve interromper todos os executores capazes de retomar essa operação antes de atestar; sem isso, recuperação segue bloqueada.

Cada mensagem do POST Meta agora tem isolamento de exceção: uma transferência em conflito não impede processar itens seguintes. Qualquer item falho produz HTTP 503, nunca confirmação 200 do lote incompleto. A Meta pode reentregar o lote; itens concluídos usam sua idempotência original, e o item falho não recebe marcador de conclusão pelo isolador. Erros retornam apenas contagem, sem texto de exceção ou dados pessoais. Falhas globais de infraestrutura continuam não confirmadas. Não há inbox durável novo: a recuperação de item não persistido depende da reentrega do provedor; não é garantia de retenção infinita.

Ficha e setor do pedido completo passam em `recordTriage` junto ao handoff, na mesma transação condicionada à geração. Saiu a gravação anterior à validação. Atualizações posteriores de ficha/setor vinculadas a geração antiga também são recusadas. Nenhum efeito IXC foi executado, habilitado ou validado; a fronteira das ações externas permanece fora deste corte.

Validação complementar: 137 testes locais passaram. PostgreSQL isolado: 12 testes incluindo suíte, com competição entre setores (somente ficha vencedora persiste), rejeição de mutação tardia, recuperação após autorização sem workerSettled, rejeição sem prova operacional e com token divergente, replay idempotente e impossibilidade de reutilizar turno consumido. TypeScript, ESLint direcionado e diff verificados. Não houve teste visual do formulário nesta revisão nem confirmação operacional de worker real.
