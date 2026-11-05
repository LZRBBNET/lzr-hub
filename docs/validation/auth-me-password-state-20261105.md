# Estado de senha consistente em auth/me

Continuação local separada sobre versão revisada do #50. Dois dos três cenários novos falharam antes da correção: a rota fazia segunda consulta e convertia erro em mustChangePassword=false, mesmo com identidade provisória já resolvida.

Agora a resposta usa user.mustChangePassword da resolução de sessão feita pelo servidor; não consulta novamente usuário/DB. Preserva authRequired, permissions e resposta não autenticada. Não aceita marca do navegador, não libera authorize e não concede papel adicional. Identidade provisória continua sendo tratada pelo #50; essa base é dependência explícita.

47/47 focados passaram, incluindo três casos de auth/me, guard/handler de senha e auth. Lint, typecheck e diff-check OK. Teste de rota usa identidade sintética; resolver real está coberto pela suíte do guard. Não prova concorrência/SQL/navegador e não elimina troca de estado após resolução da sessão. Log /tmp/lzr-auth-me-{before,focused,typecheck,lint}.log.

Sem conta real, configuração, produção, serviço, custo, merge/deploy ou alteração do PR #50. Próxima ação: revisar e compor esse ajuste somente após #50; homologar a navegação de troca obrigatória no candidato isolado quando autorizado, sem contornar bloqueio de hospedagem/orçamento.

Revisão posterior com guard/resolver reais e persistência fictícia: oito casos adicionais cobrem sessão válida provisória/normal, cookie ausente/malformado/desconhecido, expiração, usuário inativo e falha de lookup. Indisponibilidade resulta em authenticated=false sem permissões/erro bruto. 55/55 focados, 1076/1076 agregados permitidos e 25/25 staging passaram; build/artefato, lint, typecheck e diff-check OK. Não significa uma única query SQL: a resolução normal continua consultando sessão e usuário; remove-se somente a consulta redundante da rota. Sem schema/migração novo. Três arquivos revisados sem segredo/dado privado novo. Logs /tmp/lzr-auth-me-review-{focused,suite,build,lint,typecheck,staging}.log.
