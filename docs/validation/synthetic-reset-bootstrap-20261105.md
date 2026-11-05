# Reset explícito e preparação aditiva de contas sintéticas

Preparação original privada e025511 sobre c34bb25; versão revisada isolada sobre #47 (árvore 72a0655), sem publicar a composição inteira. Nenhum serviço, PostgreSQL, seed, migração, provisionamento ou configuração real foi executado.

## Reset

POST /api/demo/invoices aceita action=reset_fixture, invoiceId=901 e confirmation=RESET_SYNTHETIC_INVOICE_901. Mantém os gates estritos do #47 e sessão com billing.write-demo. Fora do modo retorna 404 antes de autenticação/banco. Sem confirmação não muda a fatura. Reabre apenas o estado financeiro sintético em memória, invalida cache e é idempotente. Resposta declara databaseReset=false, delivered=false e aviso de que promessas/histórico persistidos permanecem.

Não apaga nem reclassifica promessas, ledger, usuários ou auditoria. Uma promessa fulfilled existente não volta a pending; um job/ledger antigo não é apagado. Repetir a mesma rodada pode continuar deduplicada. Esta é uma reabertura controlada de fixture, não um reset integral de uma campanha. A duração/dia de vencimento da fixture permanece o da inicialização; para mudar esse referencial é preciso reiniciar o processo deliberadamente.

## Bootstrap aditivo

bootstrapSyntheticAccounts recebe cliente transacional dedicado por injeção; não importa pg, não conecta e não tem CLI/rota/execução automática. Exige os gates da demo e SYNTHETIC_DATABASE_CONFIRMATION=isolated-synthetic-postgres-v1. Essa declaração não comprova procedência do banco: operador deve comprovar isolamento antes de fornecer um cliente.

Aceita de uma a quatro contas, e-mails únicos em example.invalid, nome DEMO, papéis Supervisor/Atendente/Cobrança/Somente leitura e senha individual de 16–256 caracteres fornecida pelo chamador. Não oferece senha padrão e não permite Administrador. O chamador deve gerar senhas aleatórias fortes e entregá-las privadamente; comprimento mínimo não comprova entropia.

Valida todas as entradas e calcula hashes scrypt antes de BEGIN. Usa INSERT parametrizado em users, ON CONFLICT(email) DO NOTHING RETURNING id. Conta existente é conflito: aborta o lote e tenta ROLLBACK, sem UPDATE/DELETE/TRUNCATE. Não cria schema nem migrações. Retorna apenas ID/e-mail/papel das contas criadas, nunca senha/hash/salt. must_change_password=true.

Falha na resposta de BEGIN é sanitizada como não confirmada: descartar o cliente, sem presumir estado transacional. Falha de inserção, conflito, COMMIT ou ROLLBACK resulta em “não confirmado; não repetir automaticamente”. Não afirma rollback se conexão falhou, nem idempotência depois de COMMIT incerto. Antes de repetir deve-se consultar o candidato e reconciliar contas existentes sem redefinir suas senhas. Transação exige conexão dedicada; não fornecer Pool cuja query possa trocar de conexão.

## Evidência e limites

Testes em memória verificam reset, gate após troca para produção, endpoint com confirmação, hash verificável sem senha em parâmetros/retorno, SQL aditivo, conflito, entrada inválida e falhas BEGIN/INSERT/COMMIT/ROLLBACK sem replay. O teste inicial confundiu updated_at com comando UPDATE; o matcher passou a verificar palavras SQL, sem alterar produto por esse caso.

Os fakes capturam SQL e falhas; não executam PostgreSQL nem provam isolamento, atomicidade/rollback, schema, concorrência ou durabilidade reais. Login/logout com handlers reais e memória permanece coberto pela suíte anterior. Nenhum dado privado novo ou credencial real foi incluído.

Próxima etapa independente: preparar plano verificável de alvo/schema vazio e procedimento de reconciliação de bootstrap incerto, somente leitura e com transporte fictício. Antes da demo utilizável ainda falta PostgreSQL exclusivamente sintético, migrações aprovadas, bootstrap executado no alvo autorizado, login/troca de senha pelo navegador, processo único e estratégia explícita de sessão/campanha por demonstração. Não reaplicar patch Railway antigo ou aprovação de resultado incerto.

Resultados originais na composição: 46/46 focados, 1373/1373 agregados permitidos e 39/39 staging passaram; build/artefato, lint, typecheck e diff-check OK. Excluídos cinco testes HTTP com sockets e integração Redis. Logs /tmp/lzr-bootstrap-reset-{focused,suite,build,lint,typecheck,staging}.log. Revisão de segurança do diff concluída sem bloqueador adicional no escopo testado; resultado permanece privado/local, sem CI remoto alegado.

Revisão em cópia isolada sobre #47: fixture tornou-se autocontida, sem depender das flags adicionadas em #43. Corrigida também a descrição/erro de falha em BEGIN: não afirmar que a transação não iniciou quando a resposta foi perdida. Schema conferido em drizzle/0002 e 0003: users, unicidade de email e must_change_password já existem; nenhuma migração adicional necessária ou executada.

Versão revisada isolada: 44/44 focados, 1106/1106 agregados permitidos e 25/25 staging passaram; build/artefato, lint, typecheck e diff-check OK. Logs /tmp/lzr-reset-review-{before,focused,suite,build,lint,typecheck,staging}.log. Seis arquivos revisados, sem dados privados/credenciais reais identificados.
