# Reconciliação somente leitura após bootstrap incerto

Continuação local separada do PR #48. inspectSyntheticBootstrap não conecta e exige cliente injetado, gates estritos da demo e confirmação declarada de banco sintético. Essa declaração não comprova isolamento do alvo.

Uma única consulta SELECT parametrizada busca somente id/email/role/name/active das até quatro contas esperadas em example.invalid. Nunca lê hash/salt/senha, cria conta, redefine credencial, abre transação ou retorna nome/ID de conta encontrada. Classifica cada e-mail como matching, absent ou conflict; resposta inesperada/duplicada/erro vira unknown. retryAllowed e credentialsVerified permanecem false em todos os casos.

Matching não prova que uma senha funciona nem que o bootstrap originou aquela conta; absent não prova que uma transação antiga não pode confirmar depois. Conexão, SQL e estado observados precisam ser reconciliados operacionalmente antes de qualquer retry. Não há autorização automática de criação/escrita.

17/17 testes com transporte em memória passaram; lint, typecheck e diff-check OK. Nenhum PostgreSQL/serviço/consulta real foi executado. Não comprova SQL/isolamento/concor­rência/durabilidade ou resultado definitivo de COMMIT. Logs /tmp/lzr-bootstrap-reconciliation{,-typecheck,-lint}.log.

Próxima ação: revisar esta consulta e testar respostas parciais/duplicadas no candidato sintético autorizado; homologar origem/schema, migrações, conexão dedicada, login/troca de senha e recuperação de falha com PostgreSQL isolado quando permitido. Sem produção, custo, merge ou deploy.

Revisão adicional: escopo malformado, IDs duplicados e entradas não sintéticas são recusados antes de SQL. Linhas duplicadas/fora do escopo, tipos inválidos ou campos ausentes retornam unknown sem qualquer conta confirmada. A ausência observada continua sem autorizar retry.

Revisão isolada sobre #48: 1123/1123 agregados permitidos, 25/25 staging e 17/17 focados passaram, build/artefato/lint/typecheck/diff-check OK. Logs /tmp/lzr-reconciliation-review-{focused,suite,build,typecheck,staging}.log e /tmp/lzr-current-reconciliation-lint.log. Sem nova migração/schema/dependência/configuração.
