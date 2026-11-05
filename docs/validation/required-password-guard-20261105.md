# Troca de senha provisória aplicada no guard

Trabalho local independente após compor #49; base isolada #45 (árvore c8e1243), sem publicação adicional. PRs abertos conferidos; nenhum tratava esta lacuna.

UI força troca quando mustChangePassword=true, mas resolveSession descartava essa marca. Reprodução em testes novos falhou por flag ausente na identidade. authorize não tinha como impor a troca, permitindo chamadas diretas fora da tela obrigatória.

Correção: AuthenticatedUser admite marca opcional; resolveSession preserva true vindo do repositório e authorize retorna 403 antes de permissão/acesso de negócio. currentUser continua resolvendo identidade para permitir troca da própria senha e logout; o endpoint password usa currentUser, não authorize. Após atualização confirmada no repositório, próxima resolução libera operações conforme RBAC. Demo sem auth/piloto mantém contrato anterior e não é adequada para dado real.

43/43 focados e 1064/1064 agregados permitidos passaram; build/artefato, lint, typecheck e diff-check OK; build staging e 25/25 testes mock passaram. Casos novos: usuário provisório não lê promessas/não cria/não assume; senha atual errada não libera; handler real de mudança correta persiste e libera criação/claim. Todos os repositórios, contas e senhas são fictícios em memória. Nenhum PostgreSQL, serviço, configuração real, produção, custo, merge ou deploy. Cinco testes HTTP com sockets excluídos.

Limites: só protege rotas que chamam authorize. Endpoints com currentUser diretamente precisam de política própria; esta entrega não alega cobertura global. SQL, concorrência, cookies no navegador e durabilidade não foram homologados. Logs /tmp/lzr-required-password-{before,focused,suite,build,lint,typecheck,staging}.log.

Próxima ação: revisar essa correção e matriz de endpoints fora de authorize; após revisão, preparar draft separado sobre #45 sem publicar composição inteira. Hospedagem segue aguardando alvo/custo autorizado, sem reaplicar patch diagnóstico antigo.

Revisão isolada posterior: 44/44 focados e 1065/1065 agregados passaram; build/artefato, lint, typecheck, diff-check e 25/25 staging OK. Conferidos Somente leitura e Supervisor na troca real de senha; identidade provisória não impede a própria troca, não amplia RBAC após a troca. Sem migração nova: must_change_password já existe no schema. Superfícies atuais com currentUser (auth/me/password e logout via token) permanecem políticas específicas; rotas de job com segredo têm autorização independente. Demo sem auth/piloto conserva o bypass anterior e não é adequada para dados reais. Revisão dos quatro arquivos sem segredo/dado privado novo identificado. Logs /tmp/lzr-password-review-{focused,suite,build,lint,typecheck,staging}.log.
