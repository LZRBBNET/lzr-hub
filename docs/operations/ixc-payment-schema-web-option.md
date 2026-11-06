# Alternativa temporária na aplicação — preparada, não implantada

Depende do executor de projeção do #66. Candidata separada: não modifica o PR #66
que continua sendo executor avulso. Não é uma correção do contrato de pagamentos.

## Por que esta alternativa existe

Inventário atual: ferramentas Railway permitem leituras/gestão, não shell/exec/SSH.
O CLI Railway não está instalado nem há credencial de CLI no processo. O cloud
reporta política restricted/enforced, sem domínio IXC, identidade ou segredo
configurado; TCP vazio/VPN não configurada. Não remover proxy ou criar túnel,
serviço/função, credencial ou acesso persistente como atalho. Desktop declarado não
significa navegador autenticado disponível; nenhuma ferramenta callable foi achada.
Acesso do operador em outro navegador não é herdado pelo cloud.

## Controles implementados

`/api/admin/ixc-payment-schema`: GET apenas status, POST coleta. Desativada (404)
sem TODAS as configurações. Usa as credenciais existentes somente no servidor;
não expõe token/capability, nem aceita recurso, ID, URL ou query do cliente.

Além das configurações explícitas do executor avulso, exige:
- FEATURE_AUTH=true;
- IXC_SCHEMA_WEB_ENABLED=true;
- IXC_SCHEMA_WEB_ORIGIN: origem HTTPS exata do LZR já confirmada;
- IXC_SCHEMA_WEB_OPERATOR_ID: ID interno confirmado do administrador autorizado;
  nome do titular IXC NÃO é prova de login ou identidade LZR;
- IXC_SCHEMA_WEB_STARTED_AT: início ISO UTC, já atingido; prazo até 15 minutos
  entre início e IXC_SCHEMA_DIAGNOSTIC_EXPIRES_AT. Clock servidor deve ser correto.

Exige sessão resolvida, integrations.test, papel Administrador e ID exato do operador.
Sec-Fetch-Site same-origin e URL na origem configurada são obrigatórios; POST exige
Origin exata, header x-lzr-diagnostic-action: collect-shape, sem corpo ou query.
Um formulário cross-site ou visitante não consegue reservar nem consultar o IXC.
XSS/sessão comprometida no mesmo domínio não são resolvidos por estes controles;
confirmar segurança de sessão, TLS e navegador antes de habilitar a janela.

Reserva antes da rede com INSERT único na tabela audit_events existente, ID fixo
ixc-payment-schema-once-v1, ON CONFLICT DO NOTHING RETURNING. Não usa auditoria
best-effort. Sem confirmação de inserção, nenhuma chamada IXC. ID não varia por
requisição, janela, processo ou deploy. Reconexão, concorrência e reinício usam o
mesmo Postgres e não podem consumir novamente. NÃO apagar/renomear a reserva nem
restaurar snapshot antigo para tentar de novo. A garantia depende da durabilidade
do banco existente; nenhuma mudança de schema/migração foi adicionada.

A auditoria guarda somente estado reserved/completed, descrições estáticas e tempo;
não guarda alvo/IDs do cliente, operador, credenciais, valores ou estrutura coletada.
GET não faz consulta IXC; devolve unused/reserved/completed/unverified e sempre
retryAllowed:false. Estado unused não autoriza executar; é apenas observação.
Falha ambígua no INSERT: parar, consultar status, não repetir POST. reserved não
prova se houve envio/efeito; completed não garante entrega da resposta ao navegador.
Nenhum resultado é persistido para reenvio. Perder a resposta pode impedir obter o
esquema sem outra decisão/autorização; não há retry automático.

A coleta reutiliza as três leituras fixas sem retry/redirecionamento e a projeção
fechada do #66. Não declara vínculo, pagamento, quitação, total ou recebimento
composto. Registro real existe apenas transitoriamente na memória do servidor.
JSON bruto, erros e valores nunca são retornados ou registrados pelo código.
Confirmar que logging/APM externos não capturam corpos/headers/env antes da ativação.

## Sequência proposta — não executada

1. Revisar candidata, diff e testes, confirmar admin LZR e alvo IXC autorizados.
   Não inferir IDs operacionais nem publicá-los. Confirmar mesmo banco em réplicas.
2. Obter autorização específica do alvo/SHA antes de implantar. Implantar inicialmente
   com flags diagnósticas ausentes/desligadas. Validar TLS, cookie e bloqueio anônimo
   sem ativar consulta. Deploy/build/configuração não foram feitos nesta tarefa.
3. Configurar janela e alvo exatos apenas no serviço aprovado, usando credenciais já
   existentes; isto também é mudança de produção e exige aprovação correspondente.
4. Operador autenticado no navegador seguro realiza GET de status (mesma origem).
   Só depois das verificações faz UM POST vazio com o header estático obrigatório.
   Não incluir cliente/fatura em URL, corpo ou captura. Não abrir snapshot.
5. Capturar somente projeção, parar no primeiro erro; se resposta incerta, GET status,
   sem novo POST. Nenhuma escrita IXC. As únicas escritas são reserva/completion no
   audit_events do LZR; ainda não foram executadas em banco real.
6. Desabilitar IXC_SCHEMA_WEB_ENABLED e IXC_SCHEMA_DIAGNOSTIC_APPROVED; retirar
   configurações temporárias, preservar reserva. Confirmar 404 sem consulta.
7. Preparar remoção da rota e módulo web/testes após a coleta. Não apagar a reserva
   nem alterar o provider normal para acomodar resposta não comprovada.

## Evidências e limites

60 testes offline do executor/handler passaram, incluindo expiração durante a
confirmação no banco: agora o prazo é rechecado antes da resposta e a estrutura
é suprimida se expirar. Revisão independente reproduziu a falha anterior, validou
a correção e não identificou outro bloqueador de código.

Executado com o build real em servidor HTTPS local, PostgreSQL 17.11 descartável
Docker sem rede (socket Unix) e Chromium com perfil/trust store isolados por processo.
Login real da aplicação: cookie Secure/HttpOnly/SameSite=Lax e invisível a JS.
Anônimo/leitor bloqueados sem IXC; outro administrador e ausência do header CSRF
bloqueados no navegador. Duas requisições concorrentes produziram 200/503, apenas
três chamadas ao IXC falso, uma reserva completed e nenhum payload persistido.
Replay503, expiração404 e novo processo com mesmo banco503 não fizeram novas
consultas. Saída projetada não conteve sentinelas de valores/segredos.

O adapter Drizzle e a unicidade foram exercitados no PostgreSQL sintético real; não houve consulta IXC externa, teste no Railway, proxy/TLS/cookies reais de produção ou implantação.
Nenhuma credencial, custo ou acesso persistente foi criado. Nenhum comentário Linear
foi tentado após a negativa.

Consulta read-only ao inventário de connector tunnels Railway retornou Internal error;
não repetida. Portanto não foi comprovada existência/ausência de túnel utilizável.
Nenhum túnel foi criado, usado ou configurado. Desktop segue desconhecido, sem
ferramenta callable; não inferir autorização de um recurso apenas declarado.
Lint, build:staging e validação do artefato também passaram nesta candidata.

A tentativa inicial de adicionar a CA ao trust store compartilhado do navegador
foi rejeitada pela revisão automática por ampliar confiança TLS futura. Não foi
repetida. Usou-se somente CA/perfil temporários isolados por processo em /workspace,
sem flags para ignorar erros de certificado. Perfil e chaves locais de teste foram
removidos ao concluir; nenhuma configuração de confiança compartilhada foi alterada.
GET de status após expirar continua404 por desenho: nessa situação reconciliar
somente por auditoria autorizada, nunca repetir POST. A garantia de reserva depende
da conservação do banco; não foi testada restauração/perda do banco.
