# Provisionamento de usuários a partir do IXC

Quem já trabalha no provedor tem conta no IXC. Este mecanismo faz essas contas aparecerem no LZR HUB automaticamente, com o cargo certo, sem ninguém preencher formulário de cadastro.

## O que dá e o que não dá

| | |
|---|---|
| ✅ Reaproveitar a **conta** (quem existe no IXC aparece aqui, com o papel do grupo dele) | |
| ✅ Desativou no IXC → perde acesso aqui na próxima sincronização | |
| ❌ Reaproveitar a **senha** do IXC | |

### Por que a senha não dá

Investigamos a fundo. O endpoint `usuarios` do IXC **devolve o campo `senha`** com o hash de cada funcionário — a princípio isso permitiria validar a senha digitada. Mas o hash **não é SHA-256 do texto puro** (testado com uma senha conhecida: não bate). Há salt ou tratamento interno não documentado.

Reproduzir esse algoritmo seria reconstruir a implementação privada de um fornecedor: qualquer atualização do IXC quebraria o login de todos, sem aviso. Descartado deliberadamente.

Se um dia quiserem senha única de verdade, o caminho é Google Workspace ou Microsoft Entra — feitos para isso e sem expor o ERP.

## ⚠️ Sobre o campo `senha` exposto

O IXC devolve hashes de senha em um endpoint de listagem. Qualquer integração com token de leitura consegue baixar as credenciais dos 128 usuários. **Isso é uma falha de design do IXC** e foi reportada ao time.

Por isso, `lib/integrations/ixc/system-users.ts` **descarta esse campo explicitamente**: só cinco campos saem do módulo (`ixcId`, `name`, `email`, `groupId`, `active`). Há teste garantindo que o hash não vaza. Nunca remova essa proteção.

## Como funciona

1. Um administrador chama `POST /api/admin/ixc-users/sync` (exige permissão `users.manage`)
2. O sistema lê os usuários do IXC pela ponte
3. Para cada um: casa pelo e-mail, traduz `id_grupo` → papel, cria ou atualiza a conta
4. Devolve um resumo: criados, atualizados, desativados e **grupos ainda não mapeados**

Contas novas nascem com uma **senha impossível de acertar**. Provisionar não concede acesso sozinho — um administrador precisa definir a senha com `scripts/create-user.mjs`. Isso é proposital: sincronizar o cadastro não pode, por si só, abrir a porta para 128 pessoas.

## Configuração

### `IXC_GROUP_ROLE_MAP`

Mapa do grupo do IXC para o papel do LZR HUB, em JSON:

```
IXC_GROUP_ROLE_MAP={"13":"Administrador","4":"Atendente","5":"Suporte","7":"Cobrança"}
```

Papéis válidos: `Administrador`, `Supervisor`, `Atendente`, `Suporte`, `Cobrança`, `Comercial`, `Analista`, `Somente leitura`.

**Grupo não mapeado vira `Somente leitura`** — fail-closed, nunca algo permissivo por descuido. Papel escrito errado é ignorado (também vira `Somente leitura`), em vez de virar acesso amplo.

### Grupos em uso no IXC da BBNET (levantado em 2026-07-29)

| id_grupo | Usuários |
|---|---|
| 4 | 48 |
| 1 | 35 |
| 5 | 30 |
| 3 | 6 |
| 6 | 2 |
| 14 | 2 |
| 13 | 2 |
| 7 | 1 |
| 2 | 1 |
| 15 | 1 |

O IXC **não expõe endpoint de grupos** (testados: `grupos`, `usuarios_grupos`, `usuario_grupo`, `grupos_usuarios`, `su_grupo` — nenhum disponível). Descubra o nome de cada número na tela de cadastro de usuários do próprio IXC e preencha o mapa.

Enquanto o mapa estiver vazio, todo mundo entra como `Somente leitura`. Nada quebra, ninguém ganha acesso indevido.

### `IXC_SYNC_PROTECTED_EMAILS`

Contas que a sincronização **nunca altera**, separadas por vírgula:

```
IXC_SYNC_PROTECTED_EMAILS=admin@bbnet.com.br
```

Serve para evitar que o administrador local seja rebaixado caso o e-mail dele exista no IXC em um grupo de baixo privilégio — o que causaria perda de acesso administrativo.

## Limites conhecidos

- A sincronização é **manual** (chamada por rota). Não há agendamento automático ainda.
- Usuário do IXC **sem e-mail** é ignorado: sem e-mail não há como fazer login nem casar a conta.
- Não há tela para isso ainda — a sincronização é chamada pela API.
