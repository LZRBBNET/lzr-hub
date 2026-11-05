# Preflight local antes de homologar staging

Este comando verifica somente a configuração já fornecida ao processo. Não conecta rede ou banco, não muda variáveis, não cria usuários e não publica nada.

```bash
node --experimental-strip-types scripts/check-staging-readiness.mjs
```

Execute no ambiente isolado candidato, com as variáveis que o processo de execução receberá. Não execute através de `scripts/staging-env.sh`: esse wrapper troca flags herdadas por valores seguros e esconderia a configuração que se deseja verificar. O preflight não carrega arquivos `.env` automaticamente.

## Interpretar o resultado

- Saída `blocked`, código 1: há requisito de demo divergente, credencial externa conhecida presente ou valor inválido de FEATURE_AUTH. Corrija a configuração apenas no ambiente autorizado e repita a checagem. Valores nunca são incluídos na saída; `blockers` identifica somente nomes de variáveis conhecidas e códigos fixos.
- Saída `configuration_valid`, código 0: passaram apenas os checks locais de configuração. Não significa ambiente protegido, banco sintético, homologação concluída ou autorização para publicar. `readyForProduction` é sempre `false`.
- `applicationAuth` mostra apenas se a flag da aplicação exige login. Não comprova identidade, sessão, RBAC ou proteção externa.
- `databaseConnectionConfigured` indica somente presença não vazia de `DATABASE_URL`, a variável usada pelo runtime atual. Não conecta, não valida a URL e não prova isolamento. Somente DATABASE_PUBLIC_URL não configura o runtime.

A lista de credenciais é explícita e cobre nomes conhecidos de IXC, LLM, Meta, n8n, Telegram, Evolution, Chatwoot, observabilidade, jobs e filas. Não descobre aliases, arquivos, credenciais embutidas em outras URLs ou novas integrações. Configuração limpa não é auditoria completa de segredos.

## Evidência ainda necessária

1. Acesso: comprovar no ambiente isolado a negação a visitante não autorizado e o acesso do participante correto. Se a aplicação exige login, validar sessão válida/inválida/expirada e RBAC. Se a demo depende de proteção externa, verificar essa política e sua aplicação real. Não desligar autenticação para fazer teste passar.
2. Banco: confirmar destino isolado e dados exclusivamente fictícios antes de conectar. Não usar somente nome de host ou flag como prova. Se o recorte não usar banco, registrar explicitamente essa limitação.
3. Runtime: demonstrar que o processo que serve o artefato usa a configuração verificada. Build de staging não fixa automaticamente seu ambiente posterior.
4. Efeitos: testar com fontes/transportes fictícios e registrar ausência de mensagens, ordens, cobranças ou outras ações reais. O preflight não observa rede em execução.

## Testes reproduzíveis

```bash
node --experimental-strip-types --test tests/staging-readiness.test.mjs
```

O glob da suíte agregada `npm test` inclui o arquivo. A suíte `test:staging` existente continua com o recorte anterior; execute o teste acima também quando validar este preflight isoladamente.

Todos os testes novos usam valores fictícios. Os subprocessos de CLI recebem somente o mapa de fixtures e não herdam secrets do processo de teste. Não executar este comando contra produção faz parte do escopo desta entrega; nada foi inspecionado ou alterado em um deployment real.

## Validação desta entrega, 2026-11-05

- 45/45 testes novos passaram, incluindo CLI com códigos 0/1, falhas múltiplas, saída sem valores, flag de autenticação e URL de banco sem exposição.
- 935/935 testes agregados sem sockets passaram; os cinco testes de `tests/ixc-http.test.mjs` foram excluídos. Não equivale à execução integral de `npm test`.
- 39/39 testes da suíte de staging existente passaram com build e validação do artefato. Typecheck, lint e revisão independente sem bloqueador.
- Testes desta entrega propagam explicitamente os preloads `--require` do processo pai aos subprocessos CLI, sem herdar variáveis ou credenciais. A rodada usou barreira de rede/socket; fixtures somente.
- Nenhuma execução contra ambiente publicado, banco real, Site ou produção. Sem criação de sessão, conta, credencial, mensagem, merge ou deploy.

Próxima ação: no candidato isolado autorizado, executar o preflight diretamente com a configuração de runtime pretendida e reunir as quatro evidências acima. Se houver bloqueio, não tratar a saída como aprovação e não alterar produção para resolvê-lo.
