# OS: reserva e consulta após resultado incerto

Base: PR #107, 661c7a2607e80d3ea16807b925ea5363f8200487. Sem implantação ou chamadas reais.

A reserva é INSERT ON CONFLICT DO NOTHING no ledger existente, usando o índice único (operation, idempotency_key), antes da chamada externa. Não requer migração: status já é text. O SHA-256 do pedido ocupa o marcador invoiceId desta operação (OS não tem fatura), mantendo a chave vinculada ao conteúdo sem guardar relato. Não existe liberação automática, TTL ou retry externo.

pending significa reservado, podendo ou não ter chegado ao IXC; unknown significa resposta não confirmada. Timeout, JSON sem ID, erro externo ou falha de persistência após sucesso não permitem reenvio. Mesmo se persistir unknown falhar, pending continua durável. blocked só é produzido pela política local antes da chamada. Conflito de conteúdo retorna unknown para não liberar a tentativa original.

A interface guarda somente uma chave opaca em localStorage antes do POST. Após reload ou resposta perdida, o operador usa Consultar tentativa (GET autenticado, no-store, limitado ao autor). Ausência não prova que a requisição não chegará: permanece unknown. Sucesso/bloqueio confirmado permite encerrar a tentativa explicitamente; pending/unknown não. Limites: limpar armazenamento, outro navegador ou outra chave não fornece deduplicação semântica global. Não há garantia de exactly-once no ERP.

## Reconciliação operacional

Consultar o ledger pelo botão, preservando chave/correlationId. Se pending/unknown persistir, conferir no IXC a OS efetivamente criada para o cliente, assunto e momento da tentativa, sem reenviar. O resultado ausente numa listagem parcial/cacheada não prova não execução. Não há endpoint de desbloqueio automático/manual implementado nesta correção: uma decisão auditada de recuperação exige evidência remota específica. Não apagar a reserva para repetir.

## Bloqueios do piloto

O POST atual não recebe/transmite id_contrato; falta contrato oficial do IXC para vínculo e encerramento. O catálogo expõe apenas id/nome e não comprova ausência de workflows ou despacho. Nome de assunto “teste” ou setor “Administrativo” não é evidência suficiente.

A referência oficial já citada pelo projeto, https://api-provedor.ixcsoft.com.br/, foi aberta nesta investigação, mas não expôs conteúdo textual acessível. A coleção Postman mencionada pelo código não está presente no checkout. Não foi inferido endpoint de fechamento ou campo de vínculo.

Evidência mínima necessária: export oficial da operação OS de Cliente (inserir), com campo de contrato e regra de propriedade; operação documentada de finalizar/encerrar, campos obrigatórios e efeitos; operação de leitura por ID que confirme cliente/contrato/status; configuração real e revisada de assunto/setor demonstrando que não dispara técnico, agendamento, mensagens ou outras automações. Nenhuma OS do piloto deve ser criada antes disso.

## Verificação

Testes locais sem rede: concorrência da mesma chave, reserva indisponível, resposta perdida após efeito remoto simulado, falha do ledger após sucesso, payload divergente, retorno mínimo e persistência de chave/reload. Os testes de concorrência usam repositório em memória; o SQL usa o índice único já existente, mas não houve ensaio concorrente em PostgreSQL real nem browser E2E.
