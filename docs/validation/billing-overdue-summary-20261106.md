# Resumo de vencidas: evidência local

Branch fix/billing-overdue-summary-20261106 sobre 57ad19b (#65). Linear BBN-6, PRs abertos e agentes ativos consultados. #69 trata datas civis; correções de régua/worker e trabalho de conexões não foram duplicados.

Reprodução sintética: summarizeFullBase somava faturas recebidas, canceladas, desconhecidas, futuras ou vencendo hoje; lote misto retornava 2100 em vez de 300. Onze testes novos falhavam antes. Agora exige abertura explícita A/aberta/aberto/em aberto e atraso de pelo menos um dia para somar e distribuir nas faixas. Data ausente só conta entre abertas. Preserva overdueTotal/openCount remotos, overdueScanned e truncated; não inventa nova contagem global.

Validação: node --experimental-strip-types --test tests/billing-overdue-summary.test.mjs tests/billing.test.mjs: 22/22; eslint dos dois arquivos, tsc --noEmit e git diff --check passaram. Referência às 23h de Brasília, status desconhecido/encerrado, datas atuais/futuras, lote misto e regressões. Testes de funções com dados fictícios, sem transporte externo, banco ou mensagens.

Limites: não comprova que a fonte real retorne linhas inconsistentes. Contagens remotas continuam sendo metadados da fonte e podem divergir da amostra local. Não muda o cálculo de valores monetários ou o resumo allowlist. Datas civis inválidas continuam dependendo de #69; composição ainda não homologada. Não houve build novo, navegador, PostgreSQL, IXC, produção ou publicação remota.

Próxima ação: revisar o incremento e compor com #69, executando ambas as suítes antes de propor publicação. Nenhuma autorização anterior de publicação foi reutilizada para estes arquivos novos.

## Composição com #69

Patch exato do PR #69 head 9150dd567a411d129109cc6fc4444d54d2aafc4e aplicado sem conflito. Mantém os 18 casos de datas civis e acrescenta dois casos integrados em torno de 03:00 UTC (meia-noite de Brasília), misturando data impossível, recebida, status desconhecido, futura e aberta vencida. Soma/faixas conferidas, contagens remotas preservadas.

42/42 testes de cobrança passaram em cada processo TZ=UTC, America/Los_Angeles e Asia/Tokyo (mesmos casos, não 126 casos diferentes). ESLint, tsc --noEmit e diff-check passaram. Sem alteração de esquema/dependência ou consulta externa; não foi executado build, navegador ou PostgreSQL. Candidata em review/billing-summary-composition-20261106, preparada para revisão incremental sobre #69. Limitações dos metadados remotos e do resumo allowlist permanecem.
