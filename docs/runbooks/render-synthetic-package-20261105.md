# Candidata de homologação Render — draft para revisão

Consolida runtime/testes da candidata privada dos três fluxos, Blueprint e inicialização corrigida, sobre #54 head 0d786b6d31abc4e7e94c78a52760decff5bcf3c3 (árvore local equivalente d6bf5f2/64a7d38). Não altera produção ou heads dos drafts existentes. Composição por conteúdo, não promessa de ancestralidade de commits recriados pelo conector. Histórico detalhado de QA e recibos privados não foi copiado para este draft.

Dependências reaproveitadas: #34→#37→#38→#39/#40 e #46 para cobrança/data civil/régua; #35 para Cliente 360; #36→#41 para handoff por canal; #42 para fonte válida do Copiloto; #43→#44 para staging/preflight; #45→#47→#48/#49 e #50→#51→#52 para fonte sintética, preparação aditiva/reconciliação e sessão/senha; #53 para fixture de atendimento; #54 para Node/barreira de acesso. Preserva test do #40, test:staging do #43 e lockfile da candidata. Não integra #32 concorrente ou IXC/Meta reais.

## Inicialização explicitamente inativa

Blueprint deploy/render/render.synthetic-review.yaml mantém exatamente web Node e PostgreSQL com plan: free, mesma região, ipAllowList: [] no banco e DATABASE_URL por fromDatabase/connectionString interna. Declara SYNTHETIC_INIT_ENABLED=false; não contém capability/hash/salt de login, senha de operador, generateValue ou hook de seed/migração. Chaves de integração/envio/filas/LLM desligadas. Origem HTTPS é entrada manual não secreta (sync:false), nunca adivinhada/interpolada.

AutoDeployTrigger: off, previews globais off e previews independentes do serviço ausentes, que desativa sua geração em recursos novos conforme a referência. Não usa o campo deprecated pullRequestPreviewsEnabled. Branch é review/render-synthetic-initialization-package-20261105, exclusivamente de draft. Nenhuma configuração YAML gera autorização para aplicar recursos. Startup só serve artefato Node validado e não inicializa schema/dados. Blueprint permanece sem parâmetros necessários para habilitar a rota privilegiada.

Inicializador corrigido: uma operação por controller antes de qualquer await, banco/OID/hostname e preflight vinculados ao processo, reserva durável, zero sobrescrita, migrações pinadas e sem retry de resultado incerto. Driver recebe parâmetros explícitos; query/fragmento/porta alternativa na URI são recusados. Leituras de catálogo usam pg_catalog. Esse código é preparado para uso manual posterior, não é executado pelo Blueprint.

## Segurança e dados

Revisão em checkout separado sobre o conteúdo consolidado, com testes e revisão dos arquivos do diff. Novos dados são fictícios/.invalid, nomes DEMO e IDs reservados; material de login e capability não foram gerados ou configurados. Não há valor real novo identificado ou link de artefato privado. Gate exige auth/staging/mock e credenciais externas conhecidas ausentes. Assets Node verificados sem DATABASE_URL/URI PostgreSQL. Não é detector universal de segredos nem auditoria global de rede.

A conexão do inicializador é interna direta com ssl=false explícito; não alegar TLS verificado ou usar URL externa. Caso a política exija TLS, é necessária revisão explícita de CA/configuração, sem fallback por PGSSLMODE. Nenhum PostgreSQL real foi iniciado; SQL, catálogo/permissões, concorrência/durabilidade e navegador/TLS ainda dependem de homologação autorizada. OID não identifica globalmente um recurso; verificar workspace/host privado e descartabilidade. Lock é cooperativo, não contém administrador com acesso concorrente. Free suspende/reinicia: estado da fatura em memória pode divergir do ledger persistido; uma instância e sessão deliberada.

## Plano remoto: possível, ainda não criado

Contrato atual da ferramenta conectada create_blueprint permite criar o objeto Blueprint e planejar o primeiro sync sem aplicar recursos. Usar autoSync=false (default é true), existingResources=create_new (nunca adopt), repo LZRBBNET/lzr-hub, branch exata deste draft e path deploy/render/render.synthetic-review.yaml. O workspace deve ser explicitamente confirmado pelo usuário; não usar fallback de sessão. Apenas consulta list_workspaces ocorreu, sem selecionar ou modificar destino. Acesso do Git provider da Render ao repositório privado ainda não foi comprovado.

| Etapa | Efeito | Aprovação necessária |
|---|---|---|
| Criar somente plano | registra Blueprint e calcula alterações; não aprova sync | confirmar workspace e autorizar planejamento remoto com autoSync=false/create_new |
| Aprovar plano | cria recursos, pode executar build/deploy e gera credencial gerenciada do PostgreSQL | revisar planningOutcome=planned, diff exato de dois recursos free, ACL, branch/commit, origem HTTPS e limites de uso; autorização explícita de apply |
| Habilitar inicialização | concede operação privilegiada no banco vazio | autorização separada do alvo descartável, rede/TLS, capability e material de login sintético por canal privado; validação real e operação manual única |

Não chamar approve_blueprint para plano failed/no_changes, nem confundir fornecimento de valores ou aceite de custo com autorização de deploy. Depois de corrigir arquivo, replanejar e revisar o novo diff. Não executar retries cegos de ação com resultado incerto. AutoSync=false do Blueprint é separado do autoDeployTrigger:off do serviço; ambos são necessários para manter mudanças posteriores manuais.

Free não é garantia universal de custo zero: build/banda têm quotas, pode haver cobrança extra se existir meio de pagamento. PostgreSQL free expira em 30 dias, um por workspace, sem backup. Conferir disponibilidade, limites e retenção antes de apply, sem upgrade automático. Não houve leitura de faturamento, criação de plano, recurso, segredo, servidor, banco ou deploy nesta entrega.

Fontes consultadas em 2026-11-05: [Blueprint](https://render.com/docs/blueprint-spec) e [Free](https://render.com/docs/free), mais contrato das ferramentas create_blueprint/approve_blueprint da conexão. Markdown da referência não pôde ser lido por content-type; HTML oficial lido. Guard Python valida YAML/política local (17 mutações recusadas), não schema completo/API Render. CLI Render não está instalada; não foi instalada/autenticada. Resultado remoto precisa ser conferido antes de qualquer aprovação.

## Resultado local da integração

1443/1443 agregados permitidos, 39/39 staging, 34/34 focados (motor/controller/proxy/guard/jornada), smoke do artefato Node 1/1 e auditoria anônima 74 operações/51 rotas passaram. Guard final reexecutado com 17 mutações recusadas após remover campo deprecated de previews; alterações finais de YAML não mudam o artefato de aplicação. Builds Node e legado/artefato, lint/typecheck/diff-check OK. Cinco testes ixc-http com sockets excluídos. Contagens sobrepostas; resultados locais, não CI remoto.

Logs /tmp/lzr-render-package-{focused,node-build,build,artifact,boundary,suite,staging,guard,lint,typecheck}.log. Revisão dirigida dos 75 arquivos: sem chave privada/token de provedor/URI real de banco ou link de artefato privado identificados; literais de URI em testes são .invalid e marcados como fixtures. Não é detector universal. Nenhuma aprovação remota, ação negada/pendente de provisionamento ou resultado externo incerto novo. Pacote congelado anterior preservado.
