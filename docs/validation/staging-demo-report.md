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
| Acesso Sites | confirmar antes do checkpoint |
| URL/versão | preencher após implantação verificada |

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
- Suíte completa: 147/147.
- Lint, typecheck, build de staging e validação do artefato aprovados.

## Inspeção visual

Pendente nesta execução: a política do navegador bloqueou o acesso à prévia local. Não foi utilizado contorno. A estrutura da página e o aviso de demonstração foram validados no artefato renderizado por teste HTTP.

## Pendências antes da decisão humana

1. Publicar commits na branch da Issue #27 e abrir PR draft.
2. Confirmar política `custom` do Sites.
3. Gerar checkpoint, aguardar implantação terminal e registrar versão/URL.
4. Fazer inspeção visual manual autenticada e registrar o resultado na Issue #27.

## Decisão provisória

Código local pronto para validação final. Ainda não declarar a demo pronta para uso até a implantação protegida terminar e a inspeção visual manual ser concluída.
