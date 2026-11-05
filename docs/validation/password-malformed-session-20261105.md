# Cookie ilegível na troca da própria senha

Continuação local separada do #51. Reprodução: lzr_session=%ZZ lançava URIError no handler antes de chamar currentUser; um dos três casos novos falhou. Sem sessão e sessão desconhecida já eram recusadas.

A rota agora resolve identidade pelo currentUser protegido antes de ler novamente o token. Cookie inválido é tratado pelo resolver/diagnóstico existente e produz 401 sanitizado antes de banco de negócio, senha ou auditoria. Não altera parser, política de senha, sessão válida, RBAC ou conta. Request real tem headers estáveis; não se alega comportamento de objetos Request adulterados por código interno.

58/58 focados passaram (auth/me, guard, auth e handlers de senha); lint, typecheck e diff-check OK. Guard/resolver reais, persistência em memória, cookies e senhas fictícios. Nenhum PostgreSQL/serviço/conta real/produção/custo/merge/deploy. Logs /tmp/lzr-password-malformed-{before,focused,typecheck,lint}.log.

Próxima ação: revisar este ajuste e, se aprovado, publicar incremento isolado; testar navegação e recuperação de sessão no candidato de homologação quando disponível e autorizado. O #51 continua sem essa alteração local.

Revisão isolada posterior sobre #51: 1079/1079 agregados permitidos e 25/25 staging passaram; build/artefato, lint, typecheck e diff-check OK. Fonte e dados dos três arquivos revisados sem outro bloqueador ou segredo real identificado. Sem migração/schema novo; guard/resolver preservam falha fechada e a própria troca continua acessível para sessão válida. Cinco testes HTTP com sockets excluídos. Logs /tmp/lzr-cookie-review-{build,suite,staging}.log; checks focados/estáticos nos logs anteriores indicados.
