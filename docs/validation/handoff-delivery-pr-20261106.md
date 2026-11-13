# Transferência humana: candidata consolidada para revisão

Base exata: PR #41, `aabf4f4c0381be3be4e55c9fa4e1d354a6f56eec`, branch `fix/conversation-channel-scope-20261105`. Essa base inclui #36 (`719252f`) com motivo/contexto/responsável. `main` não é a base dessa linha. Nenhum head existente é alterado.

Extrai de `c76b808` somente atribuição/auditoria/coordenação, incluindo o CAS originalmente revisado no #59 (`c07e6b4`), sem importar a cadeia de inicialização #55 desse PR. Não contém recibos duráveis do Copiloto, mudanças de pool, pagamentos #65–#67 ou conexões. O PR #59 continua separado; não integrar sua mesma correção duas vezes.

## Comportamento

O resumo herdado identifica recomendação de humano sem fingir transferência concluída, apresenta motivo/contexto e responsável atual, separa canais e remove responsável antigo ao reabrir. A nova atribuição usa CAS e auditoria na mesma transação; erro não confirma mudança. Envios humanos reservam a conversa e confirmam a atribuição auditada antes do transporte. Bot e mutações respeitam reserva persistida, com advisory lock transacional curto. Não há conexão mantida em transação durante HTTP.

Chave de envio humano é vinculada a canal/conversa/texto/ID do ator/e-mail/papel; contexto divergente ou registro antigo sem vínculo retorna409. Replay confirmado não reenvia nem reassume após release/novo responsável. Falhas incertas preservam reserva. UPDATE RETURNING detecta resultado não gravado. Falhas após aceitação mantêm o humano responsável e informam recorded=false quando a gravação não é confirmada.

Mudança funcional deliberada: n8n delegado sempre retorna autoReply=false, mesmo com flag ligada, pois não oferece protocolo coordenado de reserva/ack. Meta mantém envio coordenado. O helper best-effort pós-envio foi removido. Sem novo schema, migração, dependência ou configuração aplicada.

## Validação da árvore extraída

- Build e validação de artefato, typecheck, lint e diff-check passaram.
- 917/917 testes agregados offline, excluindo os cinco testes de socket `ixc-http.test.mjs`. A primeira execução começou antes do build e três arquivos falharam por dist ausente; a execução sequencial final após build passou integralmente.
- PostgreSQL17.11 NOVO descartável, 20 migrações, runtime não proprietário e transporte de mensagens inteiramente injetado em memória: dez registros de evidência em `handoff-delivery-pr-20261106.json`.
- Auditoria negada antes do transporte; humanos concorrentes com um envio; humano primeiro/bot primeiro; mutações bloqueadas em voo; replay após transições intermediárias; contexto divergente; timeout/rede/2xx sem ID/5xx; UPDATE de resultado suprimido; histórico falha após aceitação; COMMIT antes/depois injetado; seis reservas mantidas após restart limpo.
- Loader real de resumo e PostgreSQL comprovam motivo, contexto, responsável, isolamento do mesmo ID entre canais e reabertura sem herdar responsável anterior.
- Harness reproduzível: `PG_BIN=/path/to/postgresql/bin node --experimental-strip-types tests/manual/handoff-postgres.mjs`. Não lê DATABASE_URL. Clusters e processos encerrados ao terminar. Ajustado o log do pg_ctl restart no harness para não herdar pipe do processo pai; repetição final passou.
- Conteúdo de produto foi extraído sem mudança funcional da candidata c76b808, cuja composição ampla havia passado PostgreSQL/Chromium/login/atribuição/Copiloto. Esse ensaio anterior não equivale a testar navegador nesta árvore extraída. O compositor visual de envio segue pendente; nenhum envio real foi realizado.

## Segurança, operação e limites

Reservas não expiram automaticamente. Um COMMIT confirmado no banco mas sem ack pode deixá-las sem token conhecido pelo chamador. Não há endpoint de reconciliação nesta candidata. Procedimento futuro precisa suspender/drenar remetentes, provar que nenhum worker retomará envio, conferir recibos do provedor e chave vinculada, registrar decisão auditada e liberar somente token exato. Se resultado continuar desconhecido, manter bloqueio. Não fazer limpeza por TTL, retry cego ou reenvio com outra chave para contornar.

Papel sintético tem SELECT/INSERT/DELETE em channel_idempotency_keys, UPDATE(response_json), INSERT nas colunas de mensagem e atribuição, UPDATE nos campos de estado e INSERT/SELECT auditoria. Mutações de estado agora exigem leitura de chaves. Nenhum grant real foi consultado/aplicado; política mínima e imutabilidade forte permanecem decisões separadas. Usuário/sessão são autorizados antes da transação, sem serialização de revogação durante I/O.

Não é transação distribuída nem exactly-once com a Meta. Falha de persistência pode bloquear reconciliação automática; não repara histórico. Leituras de resumo não formam snapshot transacional. Bot libera reserva antes de o chamador concluir gravação de histórico: deduplicação por período de espera entre IDs distintos não foi resolvida. O pool da base permanece sem a alteração independente de timeout; deadlines SQL não limitam aquisição de conexão.

Implantação mista com workers antigos é insegura, pois ignoram reservas. Rollback deve suspender remetentes/preservar reservas, não retornar à atribuição best-effort com envios ativos. Não houve deploy, mudança de flag, produção, banco existente, uso de credencial real ou mensagem real. Permanecer draft; nenhuma prontidão de produção declarada.

Próxima ação: revisar o diff e os limites, preparar reconciliação auditada com teste de worker antigo, testar compositor em navegador com transporte sintético e revisar deduplicação do bot e a retirada de envio delegado n8n antes de propor implantação.
