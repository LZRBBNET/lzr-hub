# Gate PostgreSQL em Railway isolado — proposta não executada

**Este roteiro não confirma existência de ambiente nem aprovação de criação/custo/publicação; esses registros são externos ao código.** Este roteiro não autoriza executar comandos na Railway. O manifesto é uma trava operacional, não prova de consentimento, controle de faturamento ou atestado criptográfico da plataforma.

## Fatia preservada

- Base funcional local: `b1670ef210d29c972c160fd7540fcb7c0d1ca8ea` (customer/tone/promessa/fila supervisionada).
- `scripts/test-recovery-cases-postgres.mjs` permanece sem alteração, exclusivamente loopback.
- Nova entrada separada: `scripts/test-recovery-cases-railway.mjs`. Não usa `DATABASE_URL`, `.env`, APIs Railway, IXC ou serviços de envio. Sem manifesto, recusa antes de DNS/conexão.
- Reproduz as mesmas asserções reais de migração, concorrência, unicidade, CAS, replay, rollback, fechamento/reabertura e apresentação pós-commit do gate local. Um teste compara os blocos para impedir substituição silenciosa por mocks.
- A execução real deste gate e o navegador continuam **não verificados**. Testes das proteções não equivalem a teste PostgreSQL.

## Alvos de produção proibidos

Projeto aprovado: `fd218da3-58f8-4a2a-9910-d92908acde96` (`zippy-cat`). O projeto pode conter teste separado. Os quatro IDs de produção observados no controle da plataforma (environment, Postgres, app e volume) continuam proibidos em qualquer posição do manifesto. O código compara seus digests SHA-256 exatos, sem publicar os identificadores em claro. Os IDs privados devem continuar sendo conferidos no controle da plataforma; testes públicos usam um sentinela sintético adicional pela mesma função.

Não duplicar production, seu volume, variáveis, webhooks ou segredos. Não apontar branch de teste para o serviço de produção. Não alterar `main` ou seu auto-deploy.

## Caminho mínimo após as autorizações específicas

1. Criar environment **EMPTY**, com nome `lzr-qa-<sufixo>`, sem herdar dados/variáveis. Registrar IDs reais novos, aprovados e distintos.
2. Criar novo Postgres e volume exclusivamente de teste. Nome do serviço: `lzr-qa-db-<sufixo>`; DB novo: `lzr_recovery_test_<nonce hexadecimal de 24 caracteres>`. Configurar nome antes da inicialização, ou criar esse DB novo somente no serviço vazio já verificado. Nunca renomear/reutilizar DB de produção.
3. Conferir no controle Railway project/environment/service/volume reais, hostname privado e orçamento/prazo aprovados. O script não faz essa inspeção nem provisiona recursos. Confirmar ausência de backup/restauração/clonagem de produção.
4. No DB vazio confirmado, provisionar separadamente um **comentário do banco** no formato `lzr-recovery-disposable:<projectId>:<environmentId>:<databaseServiceId>:<nonce>`. O gate apenas lê esse marcador; não se autoautoriza criando-o. Não executar `COMMENT ON DATABASE` antes de confirmar alvo e autorização. O comentário não é segredo e não contém senha.
5. Após autorização de publicação, publicar uma branch **draft de teste** contendo toda a cadeia local e este gate. A source precisa ser `LZRBBNET/lzr-hub`, branch `test/...` ou `qa/...`, commit exato revisado. Não basta usar a branch remota antiga sem os commits locais. Preservar evidência do SHA publicado antes de configurar o runner.
6. Criar serviço runner dedicado, **sem domínio público**, no mesmo environment de teste. Configurar build/runtime Node >=22.13 (preferência pela versão24 já testada), dependências pelo lockfile; start exclusivo `node --experimental-strip-types scripts/test-recovery-cases-railway.mjs`. Nenhum pre-deploy `npm start`/`db:migrate`; nenhuma política de reinício automático ou cron para este gate de execução única.
7. Configurar só manifesto e conexão de teste descritos abaixo. Executar uma vez; se falhar após escrever, inspecionar e preservar evidências. O banco deixa de ser vazio após execução: repetição exige outro DB descartável explicitamente verificado, não apagar/restaurar para esconder falha.
8. Guardar logs, versão PostgreSQL, SHA e resultado real. O runner pode terminar normalmente; não confundir processo concluído com app de navegador disponível.

Railway documenta IDs de ambiente/serviço e metadados Git, estes últimos somente quando o deploy vem de um trigger GitHub. Não preencher metadados falsos para simular execução Railway. [Variáveis de referência](https://docs.railway.com/variables/reference).

O runner usa apenas DNS privado do mesmo environment, rejeita endereço público/loopback/link-local e fixa o IP resolvido na conexão. A Railway documenta isolamento de rede por environment e tráfego privado por Wireguard; isso não substitui conferir o alvo no controle da plataforma. [Rede privada](https://docs.railway.com/networking/private-networking).

## Manifesto e variáveis (exemplo propositalmente inválido)

`RECOVERY_CASE_RAILWAY_TARGET_JSON` deve conter JSON com **todos** os campos abaixo e nenhum extra:

```json
{
  "version": 1,
  "projectId": "fd218da3-58f8-4a2a-9910-d92908acde96",
  "environmentId": "PREENCHER_APOS_APROVACAO",
  "environmentName": "lzr-qa-PREENCHER",
  "runnerServiceId": "PREENCHER_APOS_APROVACAO",
  "databaseServiceId": "PREENCHER_APOS_APROVACAO",
  "databaseVolumeId": "PREENCHER_APOS_APROVACAO",
  "databaseHost": "lzr-qa-db-PREENCHER.railway.internal",
  "databasePort": 5432,
  "databaseName": "lzr_recovery_test_PREENCHER",
  "databaseUser": "postgres",
  "sourceCommit": "SHA_EXATO_PUBLICADO_E_REVISADO",
  "branch": "test/railway-isolated-gate",
  "nonce": "PREENCHER_24_HEXADECIMAIS",
  "approvedAt": "PENDENTE",
  "expiresAt": "PENDENTE",
  "maxAdditionalUsd": 5,
  "approvalReference": "PENDENTE"
}
```

- `RECOVERY_CASE_RAILWAY_TEST_DATABASE_URL`: URL exclusivamente do DB de teste com usuário/senha novos do teste, hostname exato privado, porta5432 e nome exato; sem parâmetros/query/fragment. Nunca exibir seu valor em logs ou artefatos.
- `RECOVERY_CASE_RAILWAY_ALLOW_MIGRATION`: `<environmentId>:<databaseServiceId>:<nonce>`, confirmação explícita do mesmo alvo.
- Metadados `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_SERVICE_ID`, `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_BRANCH`, `RAILWAY_GIT_REPO_OWNER` e `RAILWAY_GIT_REPO_NAME` devem vir do runtime real e coincidir.
- Nenhum `DATABASE_URL`, variável `PG*`, token Railway/API, IXC, Meta, Groq ou Langfuse operacional herdado. O driver PostgreSQL lê também `process.env`; o runner rejeita essas variáveis antes de DNS mesmo quando chamado com outro objeto de configuração. Flags `FEATURE_*` presentes precisam ser `false`; modos IXC/piloto ausentes ou `disabled`.
- `approvalReference` deve apontar ao registro real da aprovação (formato `approved-...`), não criar aprovação por preencher texto. Duração máxima24h, valor reconhecido máximoUSD5, ao menos60s restantes antes de iniciar migração.

Antes de qualquer migração: verifica usuário/DB/IP/porta/comentário no servidor e ausência de tabelas, views, sequences e foreign tables não sistêmicas. Um advisory lock de sessão recusa runners concorrentes. Não cria/drop/reset DB, não limpa tabelas, não muda escopo de produção.

## Segundo estágio: navegador autenticado, separado do runner

Somente após PostgreSQL passar e a implantação de teste estar autorizada: serviço app separado, mesmo environment, banco sintético e usuários de teste com permissões Cobrança/Somente leitura. Não usar credenciais reais nem copiar o login de produção. Envio, auto-reply, IXC write, filas e integrações externas permanecem desligados.

O app precisa de domínio HTTPS de teste e login antes de mostrar dados; a rede privada não é acessível pelo navegador. Testes de criação/vínculos IXC exigem fixture sintética somente leitura, revisada, em vez de um token IXC real. Essa fixture/browser setup não é entregue por este gate e não deve ser substituída silenciosamente por produção. [Limite da rede privada para browsers](https://docs.railway.com/deployments/troubleshooting/slow-deployments).

Executar o roteiro já documentado: abrir/assumir/retorno/relato, duas sessões e versão concorrente, fechar/reabrir, fatura/promessa/protocolo de outro cliente, resposta após fechar/navegar, destino Attendance fora das primeiras40 e ausência de fallback. Registrar tela/resultado real sem contatos externos.

## Custo, prazo e encerramento

O campo de orçamento é reconhecimento, **não medidor nem limitador de cobrança**. Nenhum script aqui controla faturamento ou garante hard cap. O responsável deve acompanhar uso e encerrar recursos de teste antes do limite aprovado ou24h, o que ocorrer primeiro, preservando evidências. Não criar ambiente até haver autorização e mecanismo operacional de acompanhamento/limpeza. Cleanup deve usar somente IDs novos registrados; nunca os IDs proibidos acima.
