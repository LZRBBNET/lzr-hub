# Demo web sintética — preparação privada, sem implantação

Preparação original validada na candidata privada; esta publicação é integração restrita sobre #52, com a fonte #47 reaproveitada sem modificar sua implementação. Conferidos PRs abertos e Linear antes do trabalho; nenhum PR atual trata da barreira global de páginas ou deste build Node. Não duplica #45/#50: seus guards continuam aplicando RBAC e troca de senha nas APIs. Não usa autenticação por headers de Sites/ChatGPT em outro host.

## Lacuna e mudança

Home entregava LzrHubApp antes da consulta client-side /api/auth/me. Uma falha dessa consulta mantinha a interface inicial. FEATURE_AUTH protegia os handlers que usam authorize, mas não o HTML nem globalmente endpoints públicos/de jobs. Demo compartilhável precisa de barreira anterior ao HTML e aos handlers.

proxy.ts cobre todas as rotas dinâmicas na demo: resolve sessão real via currentUser (token hasheado, usuário ativo/expiração/revogação); anônimo recebe redirect fixo para login nas páginas e 401 em APIs. Headers de identidade/prefetch/RSC não autenticam. APIs mantêm autorização do papel, sem permissões novas. Senha provisória conserva o shell com formulário existente e só libera identidade/troca própria/logout; negócio continua bloqueado. Falha de armazenamento não autoriza nem devolve erro interno.

Públicos exatos: GET/HEAD login, auth/me, favicon e assets estáticos necessários; POST auth/login exige Origin HTTPS configurada. Demais escritas também exigem Origin exata. Sem login social, signup, recuperação anônima, webhook ou job liberado por segredo. O pedido de recuperação da tela antiga não é fluxo público habilitado nesta demo. Não é garantia contra XSS ou substituto do RBAC/limites existentes.

Modo web exige todos os gates #47, NODE_ENV=production para cookie Secure, SYNTHETIC_WEB_DEMO=true, confirmação declarada de banco sintético, pgvector/perfis de homologação desligados e origem HTTPS canônica sem path/query/credenciais. Configuração inválida dá 503 até no login. Build Node fixa marcador de proteção: remover ambas as flags de ativação depois do build não reabre páginas/APIs.

## Build Node separado e comandos preparados

vinext instalado é 0.0.50. Seu código exige Cloudflare quando detecta wrangler no root; o primeiro ensaio sem cloudflare foi recusado por essa verificação do framework, sem execução de serviço. Agora o script copia somente app/components/lib/db/types/public, proxy, tsconfig/package/next.config para work/synthetic-web, diretório gerado e ignorado. Não copia .env, .git, hosting identity, Wrangler, worker ou plugin Sites. Remove apenas esse diretório gerado antes do build; falha não conserva marker de sucesso antigo. Dependências são as já instaladas, sem instalação nova.

Depois de configurar exclusivamente variáveis sintéticas no futuro alvo autorizado:

```
node --experimental-strip-types scripts/synthetic-web.mjs check
node --experimental-strip-types scripts/synthetic-web.mjs build
```

Não usar npm start (executa migração automática) nem vinext start no dist antigo. Start preparado, NÃO executado nesta entrega:

```
node --experimental-strip-types scripts/synthetic-web.mjs start
```

Start valida novamente contexto e DATABASE_URL PostgreSQL com usuário/senha/banco, PORT entre 1024–65535 e marker do build Node. Não carrega dotenv, provisiona, migra ou executa bootstrap. Serve somente artefato work/synthetic-web/dist. Uma instância/processo: estado da fatura é local em memória; múltiplas réplicas ou restart divergem de promessas/ledger persistidos. Não deve ser adotado sem revisão da configuração do alvo.

Sintaxe de URL e marcador declarados NÃO comprovam origem/isolamento do PostgreSQL. Antes de qualquer uso real, responsável deve confirmar banco descartável sintético, conexão privada do serviço, ausência de endpoint público de banco e de credenciais/clientes de produção, schema/migrações e contas fictícias. Não copiar URL para navegador, repositório ou log. O servidor não implementa proxy de PostgreSQL nem abre sua porta; regras de rede do provedor ainda são uma exigência externa.

Configuração não secreta adicional aos gates #47: SYNTHETIC_WEB_DEMO=true, NODE_ENV=production, SYNTHETIC_DATABASE_CONFIRMATION=isolated-synthetic-postgres-v1, SYNTHETIC_DEMO_ORIGIN preenchida com a origem HTTPS exata do alvo autorizado; FEATURE_PGVECTOR=false, FEATURE_AGENT_HOMOLOGATION_PROFILES=false. Não há origem real ou senha fornecida neste documento. Variáveis DATABASE_URL e contas devem ser exclusivas da homologação e entregues privadamente, depois da autorização.

## Evidência e limites

Testes focados usam runtime real de proxy do vinext, guard/resolver e MemoryAuthRepository. Artefato Node é exercitado diretamente com Request/Response e guard offline, sem listen: redirect antes de HTML privado, APIs recusadas, headers forjados/RSC/prefetch, login público, auth/me sem sessão, POST login inválido sem leitura DB, Origin ausente recusada e drift/remoção de flags com 503. Configuração e launcher inválidos recusados antes de abrir banco ou socket.

Não é teste de servidor HTTP/reverse proxy, TLS/cookie no navegador, login PostgreSQL ou rede do provedor. Falta validar esses pontos no alvo autorizado. Assets JS/CSS públicos não são identidade nem conteúdo personalizado; no-store protege respostas dinâmicas, e backend não aceita identidade enviada por esses assets. Health dinâmico também exige sessão; não configurar healthcheck público em /api/health supondo acesso anônimo.

Nenhuma conta/recurso/domínio/acesso persistente/produção/credencial real/serviço/banco/despesa/deploy criado. Sem PR novo ou merge nesta preparação. Próximo passo externo: conta/conexão Render e decisão de recurso/orçamento; então revisão de alvo privado, aplicação deliberada da massa e navegador. Não provisionar a partir destes comandos sem essa autorização.

## Revisão isolada para draft de integração

Base #52 a3e81f9e203df7da1f518c9548780e86b58929a4 (árvore 27b9f052c4434297d1e48735ab115c23848cf37f). Reaproveita os seis arquivos de #47 093a4fb2b2764cc8eea35e36648a4ee0d92557b6 sem modificar seus blobs. Eles são dependência existente, não correção concorrente; remover sua diferença após integração de #47. O incremento novo são proxy, configuração/launcher, testes, guia e exclusão de work gerado no lint/typecheck. #50–#52 já estão na base, preservando sessão, senha provisória e cookie inválido. Não contém a composição completa #34–#53, seed ou bootstrap de atendimento/contas.

Testes de flags tornados autocontidos para não depender do #43. Verificação adicional cobre normalização de URL, headers internos falsos e contrato legado sem opt-in, com zero leitura de sessão nesse último caso. Build Node mantém marcador obrigatório mesmo se flags desaparecerem. Sem conflito de aplicação, nova dependência de pacote, schema, migração ou alteração de configuração real.

Revisão de dados dos arquivos alterados: identidades e credenciais de teste explicitamente fictícias/.invalid; nenhuma chave privada/token de provedor ou URL real de banco nova identificada. Literais PostgreSQL estão somente nos testes, com senha invented e host example.invalid. Não é detector universal de segredos. Assets JS do build Node também são examinados por presença de DATABASE_URL/URI PostgreSQL.

Resultados desta árvore: 84/84 focados (proxy, fonte sintética e guard/auth-me), 1120/1120 agregados permitidos, 1/1 verificação explícita do artefato Node; builds Node e legado/artefato, lint, typecheck e diff-check OK. Cinco testes HTTP com sockets excluídos; sem CI remoto alegado. Logs /tmp/lzr-web-review-{focused,suite,artifact,node-build,build,lint,typecheck,staging}.log. As contagens se sobrepõem; não somar. Build staging e 25/25 testes passaram nesta árvore isolada. Nenhum SQL, banco, servidor, acesso persistente, conta, serviço pago, produção, merge ou deploy executado. Draft não autoriza aplicação ou publicação de homologação.
