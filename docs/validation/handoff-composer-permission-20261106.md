# Disponibilidade do compositor conforme permissão

Base d72519e, mesma árvore do PR68 publicado2607984. Linear BBN-6 e PRs abertos consultados antes do trabalho; diagnóstico de pagamentos/conexões e homologaçãoPG18 não foram duplicados. Branch local fix/handoff-composer-permission-20261106.

Falha reproduzida: GET /api/conversations habilitava canReply apenas por flags/configuração, mesmo para Cobrança, Comercial, Analista, Somente leitura ou identidade ausente. O backend de envio já exigia support.write; não foi demonstrado bypass de envio, mas a UI oferecia uma ação proibida e a indicação de disponibilidade estava errada.

Correção: canReply exige identidade da sessão e support.write, além de autenticação, flag e configuração existentes. Lista, detalhe e resposta de banco indisponível usam a mesma decisão. Aviso visual agora diz que o envio não está disponível para o acesso atual, sem afirmar que todos no ambiente estão impedidos. Autorização do POST permanece obrigatória; GET não concede permissão duradoura e revogação posterior deve continuar sendo validada no envio.

Antes: cinco falhas em dez testes novos. Depois: 28 testes focados e npm test941/941 (build/artefato incluídos), lint/typecheck/diff-check aprovados. Handler GET e RBAC reais, guard e repositório sintéticos; oito perfis, lista/detalhe, falha deDB, identidade ausente, auth/flag desligadas, configuração ausente e sessão negada. Fixtures sem rede externa, mensagens reais ou IXC. Não houve novo teste de navegador ou PostgreSQL: esta alteração não muda persistência e o ensaio de HTTP é in-process.

Próxima ação: revisar esta correção incremental e incluí-la em próxima atualização autorizada da candidata, preservando o escopo de publicação. Nenhum push/PR/produção ou configuração real foi alterado nesta entrega. Limites operacionais anteriores do PR68 permanecem, inclusive PG18 não validado neste executor.

## Homologação integrada em navegador

Correção76b6b12 integrada à árvore equivalente ao head2607984 do PR68, base #41 mantida. PostgreSQL17.11 descartável/schema novo e Chromium com login real sintético: usuário Somente leitura consultou conversa, recebeu canReply=false e não teve compositor; POST com ator Administrador forjado recebeu403. Atendente teve compositor e envio ao stub200. Após revogar sua sessão no banco sintético, clique nativo de envio recebeu401, listagem401 e nenhuma chamada adicional ao transporte. Fluxo completo de reconciliação/contexto/responsável continuou aprovado; sete reservas sobreviveram ao restart.20 registros de evidência no runner.

Primeiras duas execuções pararam em navegação do harness: após resposta, a conversa sai da Fila e muda o preview. Corrigido seletor para telefone sintético na aba Abertas; execução final passou. Imagem de leitura inspecionada localmente; não integra publicação. Evidência bruta preservada fora do repositório; o procedimento é reproduzível por `tests/manual/handoff-browser.mjs`. Lint/diff-check do harness passaram; produto sem alteração posterior aos941 testes/build/typecheck anteriores.

Limites: PostgreSQL18, produção e transporte Meta real não validados. Revogação foi feita antes de nova requisição; isso não demonstra cancelamento de envio que já passou pela autenticação. UI pode conservar estado anterior até atualizar; segurança depende da autorização do POST. Atualização preparada somente com arquivos textuais; nenhuma imagem, configuração real ou deploy.
