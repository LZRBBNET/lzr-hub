# Validade das fontes do Copiloto

## Problema e correção

Perguntar e sugerir citavam documentos publicados vencidos. A busca compartilhada agora exclui fontes vencidas ou com validade inválida antes de ranquear. Datas civis incluem o dia inteiro em America/Sao_Paulo; instantes ISO com timezone expiram no instante indicado; null significa sem prazo.

A revisão encontrou também a conversão de validade vazia em null no repositório. A conversão agora preserva o valor inválido, impedindo que ele seja tratado como ausência de prazo. O teste do mapper real falhou antes da correção e passou depois. Listagem administrativa sem busca continua exibindo os documentos para manutenção.

## Base e escopo

Entrega incremental sobre o head b8288f90fb25ebe03365713db8c5176181491122 do PR #35, que fornece react-test-renderer para os testes de UI. Não altera dependências, schema, configuração, handler ou componente. Não porta nem duplica o PR #32 e não publica a composição privada dos PRs #34–#40.

## Revisão e evidência local

- Revisão separada do diff, do fluxo do repositório e dos casos de limite: nenhum bloqueador remanescente identificado.
- 36/36 testes focados, incluindo handler real + Attendance/Copiloto real via React Test Renderer, erro de clipboard sem auditoria, cópia bem-sucedida com um registro, histórico vindo do servidor, negação de permissão sem leituras, fonte/versão e erro sanitizado sem cópia de resultado antigo.
- Validade civil testada em quatro fusos; ISO, bissextos, datas impossíveis, metadados inválidos e repositório real com transporte fictício.
- 913/913 testes agregados permitidos; build/artefato, lint e typecheck passaram.
- Build staging e 25/25 testes de aceitação sintética passaram; staging aqui é artefato local mock, sem deploy.
- Comando agregado: listar tests/*.test.mjs, excluir tests/ixc-http.test.mjs e executar node --import ./tests/helpers/offline-guard.mjs --experimental-strip-types --test com a lista.
- Todos os dados novos são sintéticos: nomes explicitamente sintéticos, endereços example.invalid, URLs synthetic.invalid, conteúdo procedural inventado e datas de teste. Inspeção de todos os arquivos do diff e varredura de padrões de credenciais sem segredo ou dado de cliente identificado. Nenhum arquivo de ambiente, log real ou dump é incluído.

## Limites

Os cinco testes HTTP que abrem sockets foram excluídos; não é execução integral de npm test. Nenhum servidor, PostgreSQL, Redis, integração de cliente ou LLM externo foi iniciado. Auth, persistência, auditoria e clipboard são substitutos sintéticos. O guard bloqueia transporte no processo de testes, sem alegar auditoria de rede do sistema inteiro. Não há prova de navegador/clipboard nativos nem CI remoto aprovado. O endpoint used continua recebendo relato do cliente; estes testes não criam recibo inviolável.

Rascunho para revisão, sem merge/deploy. Próxima validação independente: ciclo de rascunho/publicação/busca pelos handlers reais de conhecimento e repositório sintético, incluindo RBAC e falha de persistência; evita duplicar os PRs de conversa/cobrança já abertos.
