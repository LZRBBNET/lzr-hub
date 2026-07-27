# Relatório de validação — staging demo

## Escopo

Issue #27, branch `feat/staging-demo-deployment`. Este trabalho não altera o relay do IXC, não habilita integrações e não executa escrita externa.

## Estado do ambiente

| Controle | Resultado |
|---|---|
| Ambiente | `staging` |
| Runtime | `mock` |
| IXC | `disabled` |
| Escritas externas | `false` |
| Perfis internos pela API pública | bloqueados |
| Dados | sintéticos |
| D1 remoto | não usado no primeiro deploy |
| Acesso Sites | `custom`, somente proprietário |
| Configuração runtime Sites | revisão 14, secrets IXC/piloto removidos |
| URL/versão de staging | não criada |

## Evidências concluídas

- Build de staging aprovado.
- Configuração fail-closed aprovada.
- Health sanitizado com cinco campos.
- Seed local aplicado duas vezes sem duplicar registros.
- Banco restaurado com 16 tabelas de aplicação/sistema e 15 registros sintéticos de demonstração.
- Backup local e restauração isolada aprovados.
- 15 jornadas HTTP do agente aprovadas com zero ação real.
- 4 ataques ao contexto operacional bloqueados com HTTP 403.
- Nenhum CPF formatado, telefone real ou secret incluído no seed.
- Suíte específica de staging: 25/25.
- Suíte completa inicial: 147/147.
- Lint, typecheck, build de staging e validação do artefato aprovados.

## APROVADO LOCALMENTE

- Instalação limpa, lint, typecheck, builds e artefato.
- 147/147 testes totais e 25/25 testes específicos de staging na validação inicial.
- Ciclo D1 local, seed idempotente, backup e restauração isolada.
- Health sanitizado e agente mock-only com zero ação real.
- Varredura de secrets e PII nos arquivos alterados.

## APROVADO EM PREVIEW

Nenhum item. A abertura da prévia pelo navegador automatizado foi bloqueada pela política do ambiente. Não houve contorno. A estrutura da página e o aviso de demonstração foram validados no artefato renderizado por teste HTTP.

## APROVADO NO D1 REMOTO

Nenhum item. O D1 remoto não é necessário para a primeira demo mock e não foi criado, migrado ou semeado.

## BLOQUEADO POR INFRAESTRUTURA

O projeto Sites correto foi confirmado com acesso `custom` restrito ao proprietário. Os secrets antigos de IXC e piloto foram removidos da configuração do projeto, e a revisão 14 contém somente o modo staging/mock e integrações desligadas.

O checkpoint não iniciou uma implantação: o repositório interno do Sites exige a branch `main`, mas o trabalho deve permanecer em `feat/staging-demo-deployment`. O fluxo não oferece seleção oficial de branch/preview. Não foi feito push, merge ou substituição da `main` para contornar essa proteção.

Consequentemente:

- nenhuma nova versão do staging foi salva;
- nenhum deployment foi iniciado;
- nenhuma URL foi declarada como staging;
- acesso autorizado e não autorizado da nova versão não puderam ser exercitados.

## Inspeção visual

Pendente para execução manual autenticada após existir um fluxo de preview de branch.

## Pendências antes da decisão humana

1. Revisar o PR draft da Issue #27.
2. Disponibilizar no Sites um projeto/branch de preview que aceite `feat/staging-demo-deployment`, sem publicar a `main`.
3. Gerar checkpoint, aguardar implantação terminal e registrar versão/URL.
4. Fazer inspeção visual manual autenticada e testar acesso autorizado/não autorizado.

## Decisão provisória

**CÓDIGO E PR PRONTOS, DEPLOY BLOQUEADO.**

## Revalidação para publicação — 2026-07-27

- A branch foi reconciliada com os quatro commits posteriores da `main`, sem incorporar o PR #26.
- `npm run install:ci`, lint, typecheck, build staging e validação do artefato foram aprovados.
- A suíte completa passou em 152/152 testes após a integração segura do canal n8n presente na `main`.
- O comando `test:staging` passou a construir seu próprio artefato, permitindo execução reproduzível após instalação limpa.
- `FEATURE_N8N_CHANNEL=false` é requisito fail-closed da demo.
- A rota n8n foi exercitada com a flag desligada e retornou HTTP 503, sem processar mensagem ou executar ação externa.
- O canal n8n permanece desativado porque a implementação atual ainda não comprova rate limiting e proteção temporal contra replay; nenhum `N8N_CHANNEL_SECRET` foi configurado.
- IXC, transporte IXC e todas as escritas externas permanecem desabilitados.
