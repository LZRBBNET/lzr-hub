# Autenticação e sessão (issue #30)

Antes disto o LZR HUB não tinha login: nenhuma rota sabia quem estava chamando, então RBAC e auditoria não tinham como funcionar de verdade. Ver [`rbac-audit-review.md`](rbac-audit-review.md).

## Como funciona

**Login por e-mail e senha.** Foi escolhido em vez de Google/Microsoft porque OAuth exigiria configurar Google Workspace ou Azure antes de qualquer coisa funcionar — uma dependência externa a mais. A estrutura permite trocar depois sem mexer nas rotas.

**Senha**: derivada com `scrypt` (biblioteca nativa do Node — sem dependência compilada como bcrypt/argon2, que complicaria o build no Railway), com salt aleatório por usuário. A comparação é de tempo constante (`timingSafeEqual`), para não vazar informação por diferença de tempo de resposta.

**Sessão**: ao entrar, o servidor gera um token aleatório de 32 bytes e o envia num cookie `lzr_session` (`HttpOnly`, `SameSite=Lax`, `Secure` em produção), com validade de 12 horas. **No banco fica apenas o SHA-256 do token** — se o banco vazar, ninguém consegue reconstruir uma sessão válida a partir dele.

**Login que falha** sempre responde a mesma mensagem ("E-mail ou senha inválidos"), seja e-mail inexistente, senha errada ou conta desativada. Quando o e-mail não existe, o servidor ainda assim calcula um hash antes de responder, para não revelar por tempo de resposta quais e-mails estão cadastrados.

**Sessão é revalidada a cada requisição** contra o banco: desativar um usuário derruba a sessão dele imediatamente, sem esperar o token expirar.

## Onde o RBAC é aplicado

| Rota | Permissão exigida |
|---|---|
| `GET/POST /api/agent` | `customer.read` |
| `GET /api/customers` | `customer.read` |
| `POST /api/customers` (refresh) | `support.write` |
| `GET /api/knowledge` | `customer.read` |
| `POST /api/knowledge` (ingest/publish) | `knowledge.publish` |
| `GET /api/audit` | `audit.read` |

Sem sessão válida → `401`. Com sessão, mas papel sem a permissão → `403`.

Isso fecha o furo mais grave apontado na revisão anterior: `POST /api/knowledge` deixava qualquer pessoa com a URL publicar conteúdo que a IA passa a citar como evidência para o cliente.

## A flag `FEATURE_AUTH`

A exigência de login é controlada por `FEATURE_AUTH` e **nasce desligada**.

O motivo é concreto: o ambiente publicado hoje é uma demonstração mock-only, sem dado real, acessada sem login. Subir esta mudança com a exigência ligada faria toda a aplicação responder `401` no mesmo instante, sem que exista um único usuário cadastrado para entrar.

Com a flag desligada, o comportamento é exatamente o de antes (acesso liberado, auditoria registrando como não identificado). Com ela ligada, tudo acima passa a valer.

⚠️ **`FEATURE_AUTH=true` é obrigatório antes de qualquer dado real** — escrita no IXC, cobrança, funil comercial fechando venda (milestone M4). Enquanto estiver desligada, o sistema continua sem saber quem executa cada ação.

## Criando o primeiro usuário

Sem isso ninguém consegue entrar depois de ligar a flag:

```bash
node scripts/create-user.mjs "seu.email@bbnet.com" "Seu Nome" "Administrador"
```

O script gera uma senha aleatória e a imprime **uma única vez**. A senha não é passada por argumento de propósito: argumentos de linha de comando ficam no histórico do shell e visíveis na lista de processos do sistema.

Papéis válidos: `Administrador`, `Supervisor`, `Atendente`, `Suporte`, `Cobrança`, `Comercial`, `Analista`, `Somente leitura`.

## Auditoria

Com sessão ativa, o rastro passa a gravar o e-mail e o papel reais do usuário, e a origem vira `humano` em vez de `não verificado`. A tela de Auditoria do admin agora lê `audit_events` do banco; quando o banco não está disponível ela avisa e mostra os exemplos de demonstração claramente rotulados como tal.

## O que ainda falta

- **Não há tela de cadastro/gestão de usuários** pela interface — usuários são criados pelo script acima. A tela "Usuários e Permissões" do admin continua sendo apenas a matriz de papéis.
- **Não há troca de senha nem recuperação** pelo próprio usuário.
- **Não há limite de tentativas de login** (rate limit). Um atacante com a URL pode tentar senhas indefinidamente. Recomendado antes de expor a aplicação publicamente com a flag ligada.
