# Paginação da fila — PR #110

Base: 0164aa8d. Corte funcional offline, sem consulta operacional, migração, escala fictícia ou mudança de envio.

## Caminho implementado

`GET /api/conversations` lista resumos paginados por `view` (fila, minhas, abertas, resolvidas), `sector`, busca e canal opcional. Mantém `authorize(customer.read)` antes do banco; Minhas deriva o usuário da sessão, nunca de parâmetro externo. A instalação atual não tem coluna ou filtro de tenant nesses repositórios: conserva-se o escopo da base/instância e a permissão existente, sem alegar isolamento multi-tenant novo. Cursor não concede acesso nem substitui autorização; todos os filtros são reaplicados em cada consulta.

Cursor usa o primeiro instante registrado da conversa, canal e ID externo como desempate. Última mensagem/idade da janela não movem a chave. É ordem estável de conversa, não promessa de prioridade pela idade da pendência. Nova pendência/reabertura anterior ao cursor aparece ao atualizar desde o início; não há snapshot congelado entre requisições. Inserções retroativas/remoções de histórico não são cobertas por essa estabilidade e requerem reinício da navegação.

Cada página tem no máximo 40 itens; uma sentinela adicional determina hasMore. `nextCursor`, total do filtro e agregados globais do canal (pendingCount, mineCount, oldestPendingAt) são retornados independentemente do tamanho da página. Cursor inválido ou de outros filtros/usuário retorna 400. SQL parametrizado, busca com curingas escapados. Não há limite de 24h no filtro de pendência. Resolução prevalece sobre handoff antigo; só novo inbound posterior pode reabrir. Atribuição e fila são aplicadas antes de paginar.

O banco agrega timestamps/contagens e recupera apenas uma prévia de até 500 caracteres por conversa da página. Nenhum histórico completo ou coleção de outcomes é enviado para montar a listagem. Abertura de conversa continua usando a rota de detalhe e seu limite de histórico anterior; janela de envio não foi alterada.

Atendimentos tem Anterior, Próxima, Atualizar desde o início e total filtrado. Filtros reiniciam o cursor e são executados no servidor. Poll atualiza a página atual; respostas de requisições superadas são descartadas. Falha de navegação preserva a página confirmada e exibe erro, sem anunciar fila vazia. Se todos os itens de uma página forem resolvidos durante navegação, Anterior/Atualizar continuam disponíveis. Conversa aberta permanece selecionada ao navegar. Os contadores globais usam agregados, não o array da página. O dashboard mostra uma amostra limitada da fila e acesso à fila completa. Navegar páginas não dispara aviso de “nova mensagem” de itens antigos.

## Validação e limites

Testes locais de contrato de página, sentinela, desempate entre canais, cursor e mudança de filtros/usuário, falha, página vazia, teto de volume, SQL parametrizado/escopo e wiring da UI. SQL compilado com Drizzle e respostas de banco simuladas; não é ensaio de execução PostgreSQL. Não há servidor PostgreSQL isolado disponível neste executor. UI verificada por código/testes de wiring, sem navegador autenticado ou contato com cliente.

O volume retornado e o conteúdo carregado em Node são limitados, mas os agregados ainda examinam metadados da base no PostgreSQL. Antes de carga operacional maior, medir EXPLAIN/latência com dados autorizados em ambiente isolado e decidir índices/materialização. Não alegar custo constante. A rotina legada listConversations permanece para compatibilidade/testes, mas nenhuma rota de produção a usa após este corte.

Continua separado o gate de turnos já em voo após handoff. Nada aqui o resolve, nem libera envio fora da janela, cria OS, acessa IXC/n8n ou autoriza deploy.
