# Composição de worker: reprodução e proposta sintética

Base `bec037ba5a3cd39ffd56185817b212611cd0cffa` (#96). Nenhuma alteração em `services/queue-runtime`, flags, runtime ou deployment. A correção de evidência de promessas do #96 permanece isolada e inalterada.

## Comportamento reproduzido

O helper lê o arquivo executável `worker.mjs`, remove suas três declarações de import e executa o corpo em contexto com Worker, configuração, runtime, process e console substituídos. Nenhum BullMQ, Redis ou conexão real é carregado. Captura o callback efetivamente registrado. Mesmo com evidência fictícia de fatura paga, promessa ativa ou leitura incompleta disponível no fixture, o callback original retorna `processedAt` sem consultar essa evidência e sem chamar transporte.

O risco comprovado é **conclusão genérica do job sem a avaliação de cobrança**, não mensagem enviada indevidamente. O worker atual não tem transporte de cobrança. Um futuro sender inserido nesse caminho sem integrar os guards poderia ignorá-los; isso é risco de integração, não incidente observado.

## Proposta mínima, ainda não operacional

Vincular o processador ao nome registrado da fila e usar `createProcessor('billing-reminders', dependências confiáveis, {UnrecoverableError})`. Na ausência de adaptador de evidência ou continuação, recusar; manter demais filas genéricas. Não adicionar transporte até existir definição e verificação da fronteira de reserva, confirmação e falha ambígua. O protocolo persistente necessário não é implementado aqui.

O modo `synthetic-guarded` existe somente no helper de testes: o Worker substituto troca o callback pelo consumidor protegido. Isso demonstra **uma composição proposta**, não corrige ou valida o vínculo de produção. O modo é obrigatório; `production` é recusado. O stub de transporte é fechado, não recebe callback de envio do chamador e sempre retorna `simulationOnly:true, delivered:false` quando conclui.

## Cobertura

`node --test tests/billing-worker-composition.test.mjs`

16 casos: callback original; ausência de opt-in; pagamento; promessa; evidência incompleta/antiga/ausente; continuação ausente; identidade da fila/chave adulterada; concorrência; falha depois de reserva; perda da reserva ao reiniciar; fila genérica; mapeamento de recusa terminal para erro não recuperável injetado.

A reserva em um conjunto em memória (Set) ocorre somente na continuação sintética, depois dos guards e antes do stub. Duas chamadas concorrentes nessa instância usam uma chamada ao stub. Falha após reserva suprime retry e pode representar perda; instância nova permite repetição. Não há prova de idempotência durável, exactly-once, comportamento Redis/BullMQ, ACK, entrega ou atomicidade entre leitura e efeito.

O teste não executa o worker real conectado a filas. Não valida o tratamento de eventos completed/failed/DLQ; captura callbacks e verifica a fronteira anterior ao stub. Os guards já tinham testes diretos; o novo valor é comparar a composição extraída do arquivo executável com a substituição explicitamente sintética.

Cleanup fecha workers fictícios, remove listeners e limpa reservas; os handlers de process são injetados e não instalados no processo hospedeiro. Não há processos externos, containers, banco, credenciais ou arquivos de cliente. O gap operacional do worker permanece aberto e nenhum gate de imagem, hospedagem ou TLS é promovido por estes resultados.
