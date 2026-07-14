# Secrets da homologação

Secrets obrigatórios para ativar `staging-readonly`:

- `IXC_BASE_URL`
- `IXC_API_TOKEN`
- `IXC_ALLOWLIST_IDS` — de 1 a 10 IDs autorizados
- `STAGING_JOB_SECRET` — autentica disparos administrativos

Nunca versionar valores. Use token IXC exclusivo, com menor privilégio e rotação programada. Depois de vazamento ou desligamento de usuário: revogar, gerar novo token, atualizar o ambiente, testar somente leitura e registrar auditoria sem copiar o segredo.
