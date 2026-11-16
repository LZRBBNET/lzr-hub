# OS: reserva e consulta após resultado incerto

Base: PR #107, 661c7a2607e80d3ea16807b925ea5363f8200487. Sem implantação ou chamadas reais.

A reserva é INSERT ON CONFLICT DO NOTHING no ledger existente, usando o índice único (operation, idempotency_key), antes da chamada externa. Não requer migração: status já é text. O SHA-256 do pedido ocupa o marcador invoiceId desta operação (OS não tem fatura), mantendo a chave vinculada ao conteúdo sem guardar relato. Não existe liberação automática, TTL ou retry externo.

pending significa reservado, podendo ou não ter chegado ao IXC; unknown significa resposta não confirmada. Timeout, JSON sem ID, erro externo ou falha de persistência após sucesso não permitem reenvio. Mesmo se persistir unknown falhar, pending continua durável. blocked só é produzido pela política local antes da chamada. Conflito de conteúdo retorna unknown para não liberar a tentativa original.

A interface guarda somente chaves opacas e marcadores de conclusão em localStorage antes do POST. Após reload ou resposta perdida, o operador usa Consultar tentativa (GET autenticado, no-store, limitado ao autor). Ausência não prova que a requisição não chegará: permanece unknown. Sucesso/bloqueio confirmado permite encerrar a tentativa explicitamente; pending/unknown não. Uma segunda reserva durável por cliente/assunto impede que outra chave, aba ou dispositivo contorne a tentativa criada por esta versão. Não há garantia de exactly-once no ERP.

## Reconciliação operacional

Consultar o ledger pelo botão, preservando chave/correlationId. Se pending/unknown persistir, conferir no IXC a OS efetivamente criada para o cliente, assunto e momento da tentativa, sem reenviar. O resultado ausente numa listagem parcial/cacheada não prova não execução. Não há endpoint de desbloqueio automático/manual implementado nesta correção: uma decisão auditada de recuperação exige evidência remota específica. Não apagar a reserva para repetir.

## Bloqueios do piloto

O POST atual não recebe/transmite id_contrato; falta contrato oficial do IXC para vínculo e encerramento. O catálogo expõe apenas id/nome e não comprova ausência de workflows ou despacho. Nome de assunto “teste” ou setor “Administrativo” não é evidência suficiente.

A referência oficial já citada pelo projeto, https://api-provedor.ixcsoft.com.br/, foi aberta nesta investigação, mas não expôs conteúdo textual acessível. A coleção Postman mencionada pelo código não está presente no checkout. Não foi inferido endpoint de fechamento ou campo de vínculo.

Evidência mínima necessária: export oficial da operação OS de Cliente (inserir), com campo de contrato e regra de propriedade; operação documentada de finalizar/encerrar, campos obrigatórios e efeitos; operação de leitura por ID que confirme cliente/contrato/status; configuração real e revisada de assunto/setor demonstrando que não dispara técnico, agendamento, mensagens ou outras automações. Nenhuma OS do piloto deve ser criada antes disso.

## Verificação

Testes locais sem rede: concorrência da mesma chave, reserva indisponível, resposta perdida após efeito remoto simulado, falha do ledger após sucesso, payload divergente, retorno mínimo e persistência de chave/reload. Os testes de concorrência usam repositório em memória; o SQL usa o índice único já existente, mas não houve ensaio concorrente em PostgreSQL real nem browser E2E.

## Revisão do delta 53413ae

Defeitos corrigidos: duas chaves podiam passar em paralelo para o mesmo cliente/assunto; resposta antiga de uma aba podia limpar a tentativa de outra; authorize permite usuário ausente quando FEATURE_AUTH está desligada. Agora a reserva service_order.scope usa hash de cliente/assunto e o mesmo índice único; GET e POST exigem operador identificado; a conclusão no navegador grava marcador da chave exata, sem apagar o ponteiro compartilhado (inclusive na corrida entre leitura e gravação). A resposta exibida fica vinculada à chave consultada.

A reserva de escopo permanece mesmo depois de sucesso e não tem TTL. Isso bloqueia futuras OS legítimas do mesmo cliente/assunto até existir reconciliação auditada com prova remota e procedimento explícito de liberação. Não implementamos liberação por snapshot parcial, por timeout ou pelo botão de nova tentativa. Outros assuntos não compartilham a reserva. O estado do escopo é pending e não representa uma segunda chamada externa; o estado do pedido original continua em service_order.open.

Atomicidade PostgreSQL: INSERT ... ON CONFLICT DO NOTHING com RETURNING concede a reserva a um único concorrente, usando o índice (operation,idempotency_key) da migração 0009_flaky_whizzer.sql. A reserva é aguardada antes da chamada remota. Se a reserva ou a leitura falhar, nenhuma chamada é iniciada. Se o processo cair depois da reserva, ela fica retida; não se infere ausência de efeito remoto.

Compatibilidade: operation/status são text, sem enum/check nessa migração, portanto não há DDL novo. A tabela/índice precisam estar aplicados no destino; o banco de produção não foi inspecionado. Registros antigos sem fingerprint permanecem bloqueados em replay, sem reenvio. Reservas antigas não possuem o novo escopo: antes de qualquer rollout é necessário reconciliar operações anteriores e drenar escritores da versão antiga. Rodar versões antigas e novas simultaneamente não oferece proteção cruzada. Nenhuma migração, rollout ou limpeza foi executada.

GET: exige customer.read e ixc.write, sessão identificada, mesmo e-mail autor, e responde no-store; chave inexistente/de outro autor retorna unknown sem detalhe do registro. A chave do navegador é global à origem: trocar de conta não expõe a operação de outro autor, mas pode exigir voltar à conta original para consultá-la. Não há desbloqueio por troca de conta.

Validação adicional limitada ao novo delta: corridas de chaves distintas, replay incerto, resultado antigo após recarga e substituição da chave entre leitura e conclusão, além da concorrência da mesma chave. Typecheck e lint direcionado. Não encontrados psql, postgres ou socket local de PostgreSQL; nenhum ambiente PostgreSQL isolado disponível foi identificado. Não houve teste concorrente real no banco, criação de serviço, uso de banco de produção ou instalação. A revisão foi feita em uma segunda passagem pelo mesmo executor, não por outro revisor humano/agente.
