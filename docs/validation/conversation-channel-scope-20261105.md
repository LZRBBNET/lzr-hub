# Isolamento do contexto de conversas por canal

## Escopo

Correção incremental sobre o PR #36, commit remoto `719252fdd8035cfbd797826119307566a6f33ddf`. Não modifica o head desse PR nem os PRs de cobrança #39/#40. Branch nova, sem merge ou deploy.

O repositório de conversas agrupava a lista inicial por canal e ID externo, mas recuperava e reduzia mensagens e desfechos somente por ID. Com o mesmo ID em dois canais, a fila podia exibir contexto, autoria e recomendação de humano de outro canal. Uma fala nova no outro canal também podia reabrir visualmente um caso já resolvido, removendo o responsável apresentado. A busca por perfil tinha a mesma lacuna na correlação do canal.

A correção aplica pares canal+ID às quatro consultas auxiliares e às reduções em memória. A busca por perfil usa EXISTS correlacionado por ambos os campos. As chaves internas usam tupla JSON para evitar colisões por separador. Não muda dados, atribuição persistida, autenticação, endpoints, schema, dependências, configuração ou regras de envio.

## Evidência em 2026-11-05

- Baseline do PR #36: os primeiros 12 testes novos produziram 9 falhas e 3 passes.
- Código corrigido: 18/18 testes novos; 82/82 focados; 915/915 agregados, sem falhas ou skips.
- A execução agregada exclui os cinco testes de `tests/ixc-http.test.mjs`, que abrem socket local. Não equivale à execução integral de `npm test`.
- Typecheck, lint, build e validação do artefato passaram.
- Revisão independente confirmou o escopo das consultas, a chave composta e os 12 testes iniciais verdes. A ressalva sobre falha isolada de estado foi atendida, e mais seis casos foram acrescentados.

Os testes usam `DbConversationsRepository` e geração SQL real do Drizzle, com cliente pg fictício. Todos os dados novos são sintéticos. A fronteira recusa escrita e chamadas de rede/socket. O build usa resolução sintética de localhost apenas para carregar a configuração do Vite; não inicia servidor.

Cobertura: mesmo ID em dois canais; contexto, desfecho, autoria e espera separados; ausência de estado/perfil/desfecho sem herança; reabertura somente por fala no próprio canal; página com um par; consultas com múltiplos pares sem produto cruzado; busca por nome com correlação e curingas escapados; busca numérica; chave com separador; dois IDs no mesmo canal; IA/sugestão sem apagar espera humana; lista vazia; falha isolada de leitura de estado.

## Limites

O fake não é um PostgreSQL. Ele fornece fixtures e aplica os pares nas consultas auxiliares; não executa filtros, agregações ou ORDER BY do banco. A busca por nome é verificada na estrutura SQL gerada, não no resultado de PostgreSQL. Ordenação real, plano de execução e concorrência continuam pendentes em homologação autenticada com banco isolado. As leituras seguem não transacionais.

A correção evita mistura na lista, sem implementar roteamento automático ou garantir entrega de mensagens. Não houve preview, publicação de Site, HTTP de produção, uso de clientes reais, mudança de credenciais ou envio real nesta rodada. Os resultados são locais; CI remoto precisa ser conferido no commit publicado. Permanecer draft até composição e homologação integrada.
