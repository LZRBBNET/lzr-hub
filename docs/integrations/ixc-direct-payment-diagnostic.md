# Diagnóstico direto e delimitado de uma página de pagamentos

Alternativa LOCAL preparada; não ativada, implantada ou homologada no IXC real.
Não substitui o catálogo do Hub nem depende do código da bridge antiga.

O transporte GET com corpo JSON já existe em `lib/integrations/ixc/http.ts`.
O comando abaixo usa a variante diagnóstica do mesmo mecanismo nativo, com limites explícitos e o provider existente,
sem `runtime.ts`, dotenv, banco, sessão do Hub ou migrador. O método POST usado
pela bridge NÃO é utilizado diretamente no webservice.

## Contrato e acesso futuro

Invocação por Node instalado, sem npm/npx/install:

`python3 -I scripts/launch-ixc-diagnostic.py --node "$(command -v node)"`

O launcher exige Python isolado (`-I`) e o caminho absoluto do Node instalado e
confiável. Não expande IXC_DIRECT_AUTHORIZATION no comando: copia somente as
chaves autorizadas para o ambiente passado em `os.execve`, sem valores em argv.
PATH é restrito e NODE_ENV é fixado em production. NODE_OPTIONS, variáveis Python,
NO_PROXY e demais opções herdadas não chegam ao Node. A origem do placeholder
continua dependendo do binding seguro; o launcher não distingue segredo bruto.
O bootstrap da plataforma/Python anterior ao launcher continua uma dependência;
`-I` não neutraliza retroativamente mecanismos de carregamento do sistema.

O placeholder de IXC_DIRECT_AUTHORIZATION deve vir de HTTP network secret configurado com segurança.
A configuração de escopo deve chegar por stdin,
sem shell history, argv, arquivo persistente ou cópia de variáveis de produção.
O comando não fornece esse acesso; a flag é um opt-in técnico, não autorização.
Não colar credencial na conversa. Não usar autenticação administrativa/cookie.

O JSON de entrada admite APENAS `origin`, `customerId`, `invoiceId`, `page`.
Não há valores padrão de cliente/fatura ou credencial. Origem aceita nesta
proposta: `https://ixc.bbnetup.com.br`, sem path/query/userinfo; o fato de ser host
administrativo conhecido NÃO prova acesso ao webservice. IDs canônicos positivos,
sem zeros iniciais, até 32 dígitos; page inteiro de 1 a 1000. O token real não é aceito no JSON. Nada é criado ou configurado por este comando.

Antes de executar fora do laboratório, confirmar:
- Endpoint HTTPS `/webservice/v1/` desse host e certificado confiável.
- Disponibilidade segura de credencial EXISTENTE, usuário/grupo com somente leitura
  das duas classes; autorização de seu uso direto no destino, sem revelar valor.
- Origem de execução permitida pela política Cloud e pelas redes autorizadas IXC.
  Não alterar allowlist/ACL, ignorar TLS, usar proxy alternativo/túnel ou contornar política.
- Um par cadastro/fatura real explicitamente autorizado e sua finalidade; escopo
  inclui até três leituras, não consulta massiva. Nenhum contato/ação financeira.

## Protocolo preservado

`getInvoicePaymentPage` do provider: fatura exata e propriedade antes; movimentos
paginados; fatura/propriedade novamente depois. GET + JSON + `ixcsoft: listar`,
Basic conforme mecanismo já existente. Só `/webservice/v1/fn_areceber` e
`/webservice/v1/fn_movim_finan`; máximo três chamadas, retry zero, 3,5 segundos por
transporte (não é deadline global rígido do processo), corpo de pedido até 4 KiB e resposta até 1 MiB. Stdin até 4 KiB/2s.
Sem cache/snapshot ou varredura adicional. Redirecionamentos NÃO são seguidos;
TLS é verificado explicitamente (`rejectUnauthorized:true`), com agente próprio via proxy oficial e CA pública do Cloud; a invocação com ambiente limpo antes do Node é obrigatória. Não há POST de escrita nem fallback para a bridge.

Não altera filtros, `id_receber`/`id_fatura`, propriedade, cobertura, paginação,
mapper `valor`, projeção ou regra de rejeição. Em particular NÃO mapeia `credito`
como `valor` e NÃO atribui ID solicitado ao registro recebido para fazê-lo passar.
Guardas existentes permanecem responsáveis pela recusa; a dupla prova não é
snapshot atômico e não detecta mudança/reversão entre as leituras.

## Saída e significado

Eventos JSON fixos: `ixc.directResponseShape` apresenta recurso invoice/movements,
sequência, status HTTP, presença de registros e tipos em um catálogo fixo de
campos (`id`, `id_cliente`, `id_receber`, `id_fatura`, `valor`, `credito`, `data`,
`data_pagamento`, `tipo_recebimento`). Nunca chaves arbitrárias ou valores.
`ixc.paymentLookupDiagnostic` conserva catálogo de fase/etapa/categoria v1.
`ixc.directDiagnostic` informa refused/rejected/accepted, contagem de chamadas e,
em sucesso, se total foi confirmado. Não imprime IDs, URL, token, payload, dados
financeiros, mensagem externa ou stack. Correlação fixa `direct-diagnostic` é
marcador desse processo serial, não identificador único entre execuções.

Exit 78: configuração recusada, antes de qualquer chamada. Exit 1: leitura ou
validação recusada. Exit 0: página aceita pelas validações atuais, NÃO quitação,
liquidação, ausência global, qualidade do mapeamento ou origem comum com a UI.
Tipos de campos não estabelecem sua semântica. Dados transitam em memória, mas
não são liberados como relatório de pagamentos. Não anexar dumps para investigar.

## Evidências e gates

Documentação oficial consultada: https://api-provedor.ixcsoft.com.br/ (GET/listar/
Basic, conforme conferência documental da coordenação) e
https://nodejs.org/docs/latest-v24.x/api/http.html (request + end/write corpo).
Token/permissões/redes: https://wiki-erp.ixcsoft.com.br/documentacao/guias-tutoriais/api/como-gerar-um-token-para-integracoes-api.html .
Essas fontes não comprovam o retorno financeiro da instância BB NET.

Processo sem credenciais e transporte HTTP de laboratório podem ser medidos sem
emular API/ERP, sem dados de negócio e com network none. Não são integração IXC.
A consulta positiva autenticada permanece NÃO EXECUTADA até autorização/acesso.
Promover este diagnóstico ao Hub exigiria revisão separada de configuração e
implantação; não é necessário criar nova ponte/VM para tentar o acesso direto.

## Adaptação ao proxy gerenciado (posterior a 060d3c8)

Somente HTTPS_PROXY, CODEX_PROXY_CERT e o placeholder IXC_DIRECT_AUTHORIZATION
fornecidos oficialmente pelo ambiente são preservados no ambiente antes do Node, além de PATH/NODE_ENV e opt-in. Não preservar NODE_OPTIONS,
NODE_TLS_REJECT_UNAUTHORIZED, configuração de agente global, NO_PROXY ou ambiente
inteiro. A plataforma/Python anterior ao launcher continua dependência do bootstrap
confiável; não há alegação de protegê-lo retroativamente.

O CLI compara HTTPS_PROXY com http_proxy de /etc/codex/network-policy.json, distingue
o tcp_connect_proxy de VPN e exige regra explícita exata para ixc.bbnetup.com.br.
Não inventa proxy nem confere autorização por aparência do valor de env. A política
local é snapshot: a decisão efetiva continua no proxy gerenciado, nunca no programa.
Se metadados/forma de proxy diferirem (inclusive bridge local diferente da referência),
recusa; não tenta endereço alternativo. Node 24.5+ da linha24 é exigido pelo suporte
proxyEnv documentado. Sem instalação ou setGlobalProxyFromEnv.

A CA é lida do caminho oficial observado neste executor,
/usr/local/share/ca-certificates/environment-proxy-ca.crt; deve ser arquivo regular,
não gravável por grupo/outros, até64KiB e X509 CA. Variação desconhecida é recusada.
Usa Agent explícito com proxyEnv contendo somente HTTPS_PROXY, TLS verificado,
raízes padrão mais CA oficial, sem keepalive e máximo um socket. Não desabilita TLS,
não injeta credencial por túnel TCP e não possui fallback direto nesse CLI.
Agent é destruído na recusa de configuração e no finally da leitura. Máximo de três
GETs e demais limites permanecem. Transporte não confiável produz exit78 e categoria
fixa transport-configuration ANTES de ler stdin de cliente/credencial.

Neste executor, o domínio permanece fora da política e não há segredo pronto
anunciado: nenhuma chamada/preflight externo foi feito. A autorização da rede está
pendente. Uso positivo via proxy, handshake remoto e substituição de network-secret
NÃO TESTADOS. Placeholder Basic ainda exige confirmação de formato e substituição;
não cadastrar valor bruto por inferência. Publicar alteração do ambiente exige
aprovação, salvar/republicar e nova tarefa; preserve patches/bundles desta tarefa.

## Cabeçalho opaco e limite de procedência

Chave proposta do HTTP network secret: IXC_DIRECT_AUTHORIZATION. Seu valor real
seria o cabeçalho Authorization completo (Basic mais credencial API codificada),
inserido somente no gerenciador seguro após aprovação; nunca nesta conversa,
stdin, argv ou arquivo. O processo deve receber apenas o placeholder e o proxy
HTTPS gerenciado substituí-lo no destino permitido443. Não é túnelTCP/VPN.

O cliente valida apenas valor não vazio, até512caracteres, sem CR/LF, sem espaços
nas extremidades e compatível com cabeçalhoHTTP. Não decodifica, codifica ou
acrescenta Basic. O wrapper obrigatório sobrescreve o cabeçalho interno não usado
do provider; token interno vazio não é credencial nem fallback. Provider normal
e seus consumidores não foram modificados.

Não existe formato documentado de placeholder que permita distingui-lo de um
segredo real. Logo essas validações NÃO provam origem/binding: uma variável direta
com segredo bruto também poderia passar e exporia esse valor ao processo.
Teste real segue BLOQUEADO até configurar com segurança o HTTP network secret
e conferir, com autorização, somente metadados de binding/nome/destino/estado e
compatibilidade do placeholder. Não inferir a origem de booleano, regex ou formato
Base64. Não configurar segredo agora. Os marcadores dos testes offline são
explicitamente sintéticos, não uma gramática inventada de placeholder oficial.

## Falhas de transporte e prazo do diagnóstico

O caminho isolado emite `ixc.directTransportFailure` v1 para rejeições da
Promise da requisição, antes de o provider classificar a falha. Recusas de
política ou sinal já abortado anteriores à criação dessa Promise não passam
por esse observador; não há garantia de evento para toda falha possível. O único dado variável é uma categoria de catálogo fechado:
`timeout`, `proxy-tunnel`, `tls-hostname`, `tls-trust`, `connection`,
`response-limit`, `response-incomplete`, `response-invalid`, `policy` ou `other`.
Não são publicados mensagem/stack/código arbitrário da exceção, endereço,
headers ou corpo. A categoria não comprova origem do segredo nem causa de negócio.
O observador é best-effort e não substitui a exceção original.

O prazo de 3500 ms rejeita a operação mesmo durante CONNECT/TLS pendente.
O Agent exclusivo deste CLI acompanha os sockets retornados pelo runtime Node
suportado antes de o túnel concluir e os destrói no `finally`, inclusive quando
a requisição ainda não recebeu seu socket. Não é uma política nova do provider
normal nem garantia de prazo do processo sob suspensão ou exaustão do host.
Os ensaios de processo usam margem de escalonamento de 2000 ms além do prazo,
incluindo lançamento e encerramento; não medem latência do IXC real.

## Marcos de transporte

`ixc.directTransportMilestone` v1 contém somente `sequence` (1–3),
`milestone`, `phase`, `elapsedMs` e `timeoutOrigin`. O tempo é relativo ao início
da requisição, usa relógio monotônico, é inteiro e limitado a 0–60000 ms.
É cumulativo por requisição, não um timestamp ou tempo de fase já subtraído.

Marcos: `request-start`, `socket-assigned`, `tls-secure`, `headers-received`,
`body-first-chunk`, `body-complete`, `timeout`. Fases: `connect-or-tls-pending`,
`headers-pending`, `body-pending`, `complete`. Origens de timeout: `none`,
`request-signal`, `transport-deadline`. A primeira origem efetivamente observada
vence a corrida dos dois mecanismos; `request-signal` não explica a causa do sinal.

Não há marco público separado de conclusão de CONNECT ou início de TLS.
`socket-assigned` não prova túnel ou handshake concluído. `tls-secure` observa
`secureConnect` ou o socket já autorizado; até essa confirmação a fase permanece
combinada. Não se infere conectividade de proxy só pela configuração.
`headers-received` corresponde ao callback HTTP com cabeçalhos analisados,
não ao primeiro byte físico nem à publicação dos valores/status dos cabeçalhos.
`body-first-chunk` e `body-complete` não validam JSON, propriedade ou pagamentos.
Os marcos são best-effort e não contêm conteúdo de rede ou exceções.
