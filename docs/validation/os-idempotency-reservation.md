# OS: reserva e consulta após resultado incerto

Base: PR #107, 661c7a2607e80d3ea16807b925ea5363f8200487. Sem implantação ou chamadas reais.

A reserva é INSERT ON CONFLICT DO NOTHING no ledger existente, usando o índice único (operation, idempotency_key), antes da chamada externa. Não requer migração: status já é text. O SHA-256 do pedido ocupa o marcador invoiceId desta operação (OS não tem fatura), mantendo a chave vinculada ao conteúdo sem guardar relato. Não existe liberação automática, TTL ou retry externo.

pending significa reservado, podendo ou não ter chegado ao IXC; unknown significa resposta não confirmada. Timeout, JSON sem ID, erro externo ou falha de persistência após sucesso não permitem reenvio. Mesmo se persistir unknown falhar, pending continua durável. blocked só é produzido pela política local antes da chamada. Conflito de conteúdo retorna unknown para não liberar a tentativa original.

A interface guarda somente chaves opacas e marcadores de conclusão em localStorage antes do POST. Após reload ou resposta perdida, o operador usa Consultar tentativa (GET autenticado, no-store, limitado ao autor). Ausência não prova que a requisição não chegará: permanece unknown. Sucesso/bloqueio confirmado permite encerrar a tentativa explicitamente; pending/unknown não. Uma segunda reserva durável por cliente/assunto impede que outra chave, aba ou dispositivo contorne a tentativa criada por esta versão. Não há garantia de exactly-once no ERP.

## Reconciliação operacional

Consultar o ledger pelo botão, preservando chave/correlationId. Se pending/unknown persistir, conferir no IXC a OS efetivamente criada para o cliente, assunto e momento da tentativa, sem reenviar. O resultado ausente numa listagem parcial/cacheada não prova não execução. Não há endpoint de desbloqueio automático/manual implementado nesta correção: uma decisão auditada de recuperação exige evidência remota específica. Não apagar a reserva para repetir.

## Bloqueios do piloto

O POST passa a exigir contractId, validá-lo por leitura exata e enviá-lo como id_contrato_kit. A semântica foi confirmada pela wiki oficial, conforme evidência abaixo. O endpoint oficial de encerramento foi localizado, mas faltam os requisitos condicionais e efeitos descritos abaixo. O catálogo expõe apenas id/nome e não comprova ausência de workflows ou despacho. Nome de assunto “teste” ou setor “Administrativo” não é evidência suficiente.

A extração textual de https://api-provedor.ixcsoft.com.br/ retornou vazia. Posteriormente a coordenação abriu a coleção JavaScript pelo navegador oficial e encontrou Sistema > Suporte > Ordem de serviço > Ações > Finalizar: POST /webservice/v1/su_oss_chamado_fechar. Evidência recebida da coordenação, sem nova chamada ao IXC pelo executor. A coleção Postman não está presente no checkout.

O exemplo de encerramento lista id_chamado, id_tarefa_atual, eh_tarefa_decisao, sequencia_atual, proxima_sequencia_forcada, finaliza_processo_aux, gera_comissao_aux, id_processo, data_inicio, data_final, id_resposta, mensagem, id_tecnico, id_equipe, gera_comissao, status, data, id_evento, id_su_diagnostico, justificativa_sla_atrasado, id_evento_status, id_proxima_tarefa, id_proxima_tarefa_aux, latitude, longitude e gps_time. Todos aparecem vazios, exceto status F; não há resposta exemplar. Isso não demonstra quais campos podem ser omitidos nem autoriza enviar vazios: processo, próxima tarefa, comissão e eventos podem ter efeitos condicionais.

Na criação POST su_oss_chamado, a coleção contém id_contrato_kit (não id_contrato). Obrigatórios marcados: tipo C, id_assunto, id_cliente, id_filial, origem_endereco M, prioridade 1, setor e status A. A wiki oficial posteriormente confirmou que id_contrato_kit se relaciona ao id da tabela cliente_contrato; o código agora usa esse vínculo explicitamente.

Evidência mínima restante: obrigatoriedade condicional, omissão segura, efeitos e resposta do endpoint de encerramento; validação operacional da leitura por ID que confirma cliente/vínculo/status (implementada e testada apenas com dados sintéticos); configuração real e revisada de assunto/setor demonstrando ausência de despacho, agendamento, mensagens, comissão e outras automações. Endpoint encontrado não equivale a operação segura demonstrada. Nenhuma OS do piloto deve ser criada antes disso.

## Verificação

Testes locais sem rede: concorrência da mesma chave, reserva indisponível, resposta perdida após efeito remoto simulado, falha do ledger após sucesso, payload divergente, retorno mínimo e persistência de chave/reload. Os testes de concorrência usam repositório em memória; o SQL usa o índice único já existente, mas não houve ensaio concorrente em PostgreSQL real nem browser E2E.

## Revisão do delta 53413ae

Defeitos corrigidos: duas chaves podiam passar em paralelo para o mesmo cliente/assunto; resposta antiga de uma aba podia limpar a tentativa de outra; authorize permite usuário ausente quando FEATURE_AUTH está desligada. Agora a reserva service_order.scope usa hash de cliente/assunto e o mesmo índice único; GET e POST exigem operador identificado; a conclusão no navegador grava marcador da chave exata, sem apagar o ponteiro compartilhado (inclusive na corrida entre leitura e gravação). A resposta exibida fica vinculada à chave consultada.

A reserva de escopo permanece mesmo depois de sucesso e não tem TTL. Isso bloqueia futuras OS legítimas do mesmo cliente/assunto até existir reconciliação auditada com prova remota e procedimento explícito de liberação. Não implementamos liberação por snapshot parcial, por timeout ou pelo botão de nova tentativa. Outros assuntos não compartilham a reserva. O estado do escopo é pending e não representa uma segunda chamada externa; o estado do pedido original continua em service_order.open.

Atomicidade PostgreSQL: INSERT ... ON CONFLICT DO NOTHING com RETURNING concede a reserva a um único concorrente, usando o índice (operation,idempotency_key) da migração 0009_flaky_whizzer.sql. A reserva é aguardada antes da chamada remota. Se a reserva ou a leitura falhar, nenhuma chamada é iniciada. Se o processo cair depois da reserva, ela fica retida; não se infere ausência de efeito remoto.

Compatibilidade: operation/status são text, sem enum/check nessa migração, portanto não há DDL novo. A tabela/índice precisam estar aplicados no destino; o banco de produção não foi inspecionado. Registros antigos sem fingerprint permanecem bloqueados em replay, sem reenvio. Reservas antigas não possuem o novo escopo: antes de qualquer rollout é necessário reconciliar operações anteriores e drenar escritores da versão antiga. Rodar versões antigas e novas simultaneamente não oferece proteção cruzada. Nenhuma migração, rollout ou limpeza foi executada.

GET: exige customer.read e ixc.write, sessão identificada, mesmo e-mail autor, e responde no-store; chave inexistente/de outro autor retorna unknown sem detalhe do registro. A chave do navegador é global à origem: trocar de conta não expõe a operação de outro autor, mas pode exigir voltar à conta original para consultá-la. Não há desbloqueio por troca de conta.

Validação adicional limitada ao novo delta: corridas de chaves distintas, replay incerto, resultado antigo após recarga e substituição da chave entre leitura e conclusão, além da concorrência da mesma chave. Typecheck e lint direcionado. Não encontrados psql, postgres ou socket local de PostgreSQL; nenhum ambiente PostgreSQL isolado disponível foi identificado. Não houve teste concorrente real no banco, criação de serviço, uso de banco de produção ou instalação. A revisão foi feita em uma segunda passagem pelo mesmo executor, não por outro revisor humano/agente.

## Vínculo explícito de contrato

Evidência oficial recebida da coordenação por navegação em https://wikiapiprovedor.ixcsoft.com.br/index.php# > Suporte > Ordens de serviço > id_contrato_kit: “Relacionado com o campo id da tabela cliente_contrato”; campo de busca avançada, não obrigatório no ERP. O LZR torna esse vínculo obrigatório para impedir a abertura ambígua do piloto.

A UI pede o código do contrato escolhido. POST exige contractId e faz leitura exata, sem cache de snapshot, de cliente_contrato.id, com filtro de cliente e limite 2. Só aceita página completa com total 1, ID exato, id_cliente correspondente e status A. A política também verifica o objeto confirmado pelo provider. O payload de criação envia id_contrato_kit, nunca id_contrato. Cliente/contrato podem mudar no ERP entre leitura e escrita; não se afirma transação distribuída.

O fingerprint da tentativa inclui contrato. O ledger de sucesso guarda somente mensagem local e IDs de OS/contrato em JSON; legado sem esses metadados é unknown. Consultar uma tentativa com IDs confirmados faz leitura exata de su_oss_chamado.id, filtrada por id_cliente e id_contrato_kit; confirma propriedade, vínculo e estado presente no retorno. Falha, ausência, vínculo divergente ou múltiplos resultados não liberam reserva. Sem ID retornado não há busca ampla: permanece necessária reconciliação manual auditada. O mapper preserva contractId a partir exclusivamente de id_contrato_kit.

Compatibilidade: chamadas legadas sem contractId são recusadas (400 na rota; recusa antes do transporte no cliente). Não há fallback para o primeiro contrato, snapshot parcial ou vínculo presumido. Nenhuma coluna/migração nova. Reservas de escopo continuam por cliente/assunto, de forma conservadora, mesmo entre contratos diferentes.

Divergência documental ainda aberta: wiki apresenta prioridade N e coleção anterior apresenta 1. O código conserva o padrão anterior 1; não se considera a equivalência resolvida. Não houve implementação de encerramento nem criação real. Configuração sem despacho e requisitos condicionais de encerramento seguem bloqueantes.

Testes sintéticos focalizados: contrato ausente/inativo/estrangeiro, resultado múltiplo/incompleto, envio de id_contrato_kit, recusa do legado antes de transporte e reconciliação com vínculo ausente/divergente. Nenhum cliente real foi consultado nesta implementação.
