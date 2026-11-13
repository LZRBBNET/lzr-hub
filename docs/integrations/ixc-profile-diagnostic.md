# Diagnóstico local de cadastro/contratos — desativado por padrão

Superfície CLI independente, sem rota web, banco, sessão, cache, provider normal ou fallback sintético. Não libera acesso pela aplicação e não altera pagamentos. Base pública bb6413dbdac3bfcda48309ac56db19a307c8f9f1.

## Escopo

Entrada stdin JSON exata: `origin`, `customerId`, `scope`. Origem exclusivamente `https://ixc.bbnetup.com.br`; ID obrigatório como string decimal canônica positiva de até32 dígitos. `scope` admite `customer` (até1 GET) ou `customer-contracts` (até3 GETs). Sem IDs padrão e sem seleção automática de contas.

1. `/webservice/v1/cliente`, filtro `cliente.id`, page1/rp2: envelope, total1, exatamente uma linha e ID exato.
2. Somente no segundo escopo: `/webservice/v1/cliente_contrato`, filtro `cliente_contrato.id_cliente`, page1/rp20, ID desc. Cada linha precisa de ID canônico único e `id_cliente` idêntico ao solicitado. Não inventar aliases ou aceitar FK ausente. Cobertura é incompleta se total ausente ou maior que a página; nunca busca outra página. Contrato exige IDs string; outro formato é recusado até existir evidência/documentação para normalizá-lo.
3. Repete o passo1; só então confirma o cadastro e divulga contagem/cobertura dos contratos. Não é snapshot atômico.

Nenhuma chamada a cidade, plano, financeiro, pagamentos, OS, conexão ou busca ampla. Financeiro/pagamentos/OS/conexão permanecem `not-requested`, sem valores/contagens inventados. Contratos em falha permanecem `unconfirmed`. Não retorna cadastro, nomes, IDs, endereço, contrato ou conteúdo financeiro; apenas resultado, categoria fechada, número de chamadas e booleanos/contagem de cobertura. `accepted` significa somente escopo validado; contratos podem continuar incompletos. Não significa integração/UI pronta.

## Transporte e proveniência

`profile-diagnostic-http.ts`, `diagnostic-authorization.ts` e `ixc-diagnostic-agent.mjs` são cópias exatas da revisão pública33cdcfbb522f9321bcb4e18ba8d2ae1fab1c122c, sem mudança no http/provider normais. Arquivo de transporte mantém o helper legado por igualdade auditável, mas este CLI importa exclusivamente createIxcDiagnosticFetcher. `ixc-profile-managed-agent.mjs` extrai a função managedAgent daquela revisão, preservando verificações de Node24.5+, política oficial, HTTPS_PROXY, CA, TLS/hostname e cleanup. Nenhum fallback sem Agent no CLI. As opções HTTP locais da biblioteca servem aos testes, não são admitidas pelo contrato CLI.

Cada transporte:10s incluindo corpo, pedido4KiB/resposta1MiB, GET com JSON, ixcsoft:listar, Accept JSON/identity, sem retry/redirect. Máximo1/3 chamadas; limite de rede agregado até10/30s, além de configuração/processamento local. Somente application/json/text/x-json, sem compressão inesperada. A saída simplifica erros de transporte: não conclui causa a partir de `transport`.

Launcher Python-I limpa ambiente e preserva somente PATH/NODE_ENV, HTTPS_PROXY, CODEX_PROXY_CERT, placeholder IXC_DIRECT_AUTHORIZATION e opt-in específico IXC_PROFILE_READ_APPROVED. Flag antiga de diagnóstico financeiro não habilita este CLI. Credencial nunca em argv/stdin/arquivo; placeholder inteiro, sem Basic extra ou conversão. Validação sintática não prova binding/proveniência; isso exige metadados oficiais antes da futura execução. Não abrir valor real.

## Futuro uso: exige nova autorização

Nenhuma consulta real autorizada por este commit. Solicitação mínima: autorizar uma invocação para o próprio ID explicitamente informado, escolher customer (1GET) ou customer-contracts (até3GETs), e autorizar uso do binding existente exclusivamente nesse destino/classes. Confirmar por metadados transporte/política/binding e permissão de leitura; não presumir que diagnóstico de fatura conceda cliente/contratos. Se não comprovável, parar sem alterar configuração.

Com autorização e precondições confirmadas, usar Python-I com caminho absoluto do Node confiável:

`python3 -I scripts/launch-ixc-profile.py --node /caminho/absoluto/confiavel/node`

Opt-in específico fornecido ao processo; JSON de caso somente por stdin/memória, nunca argv ou arquivo persistente. Não há comando aqui com IDs/credenciais reais. Exit78 configuração recusada; exit1 escopo/leitura rejeitado; exit0 resultado aceito sob limites declarados. Não executar para testar configuração com credencial: utilizar testes fictícios. Não modifica a homologação sintética nem autoriza deploy/primeiro acesso.

## Validação

Testes fictícios de escopo1/3, IDs, propriedade inicial/final, FK ausente/divergente, duplicatas, envelope/JSON/HTTP/media type/encoding, paginação/total incompleto/inconsistente e launcher fechado. Transporte real somente loopback de laboratório: prazo/corpo pendente, limites de bytes e recusa antes da rede de endpoint/origem não autorizados. Sem segredo, IXC ou dados reais. Revisão independente corrigiu ambiguidade de customerConfirmed após falha final e unificou nome do evento; código normal preservado. Documentação API pública geral sustenta GET/listar, não comprova schema/permissões dessa instância.
