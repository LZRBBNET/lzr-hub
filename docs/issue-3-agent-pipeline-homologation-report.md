# Issue #3 — relatório de homologação do pipeline de IA

## 1. Objetivo

Homologar de ponta a ponta a rota `/api/agent` com cenários reais de ISP, garantindo que intenção, contexto, ferramentas, evidências, simulação, falhas e transbordo produzam resultados previsíveis e seguros.

## 2. Escopo

Foram avaliados o endpoint, o pipeline determinístico, o estado conversacional, os recibos de ferramenta, a geração/validação da resposta, a política de evidência, o transbordo e os testes automatizados. WhatsApp, escrita IXC, cobrança real, reinicialização real, abertura real de OS e integrações externas ficaram deliberadamente fora do escopo.

## 3. Arquitetura analisada

```text
HTTP contract
  -> intent/context resolution
  -> controlled tool engine
  -> evidence-aware outcome
  -> handoff policy
  -> response generation
  -> false-confirmation/simulation validation
  -> quality evaluation + persisted conversation state
```

Arquivos centrais: `app/api/agent/route.ts`, `lib/agent/pipeline.ts`, `lib/agent/types.ts`, `lib/agent/tool-engine.ts`, `lib/agent/evidence.ts`, `lib/agent/handoff.ts`, `lib/agent/repetition.ts` e `lib/agent/homologation-scenarios.ts`.

## 4. Data e commit base

- Data: 17/07/2026.
- Base local: `d3d0b54`.
- Conteúdo base no GitHub: `f8adec5`.
- Branch: `feat/issue-3-agent-pipeline-homologation`.

## 5. Ambiente

Node compatível com `>=22.13.0`, npm, Vinext/Vite, execução local isolada e ferramentas externas substituídas por fixtures sanitizadas. Nenhum segredo foi necessário. `IXC_WRITE_ENABLED=false` e `FEATURE_IXC_WRITE=false` permaneceram desligados.

## 6. Comandos executados

| Comando | Resultado final | Duração aproximada |
| --- | --- | ---: |
| `npm ci` | FALHOU por restrição ambiental de `/root/.npm` | 9 s |
| `npm run install:ci` | APROVADO | 10 s |
| `npm run lint` | APROVADO | 2,8 s |
| `npm run typecheck` | APROVADO | 1,6 s |
| `npm test` | APROVADO — 118/118 | 3,1 s |
| `npm run build` | APROVADO | 2,6 s |
| `npm run validate:artifact` | APROVADO | 0,2 s |

O projeto fornece `npm run install:ci` justamente para usar HOME/cache graváveis. A falha do `npm ci` direto é ambiental e reproduzível nesta sandbox; o lockfile foi instalado integralmente pelo comando suportado.

## 7. Resultado antes das alterações

A linha de base possuía 38 testes aprovados, mas só representava ferramentas como `completed` ou `failed`. Ações demonstrativas apareciam como concluídas, não havia política formal de evidência/transbordo e timeout, vazio, parcial, proibido e indisponível não eram cenários controláveis.

## 8. Alterações realizadas

- Resultado operacional tipado: `success`, `simulated`, `partial`, `unavailable`, `timeout`, `forbidden`, `invalid`, `not_found`, `requires_human` e `error`.
- Compatibilidade preservada em `ToolReceipt.status` (`completed|failed`).
- Evidência estruturada, com fonte, validade, instante e indicação de simulação.
- Ação real separada de consulta e de simulação.
- Validador bloqueia alegações de sucesso sem evidência e exige identificação explícita de simulação.
- Política de transbordo e resumo sanitizado para atendente.
- Validação de mensagem e histórico na borda HTTP; perfil e contexto operacional são rejeitados na rota pública.
- Contrato tipado e executor comum para os 60 cenários.
- Correções de intenção, continuidade, pluralização e classificação de consulta interna.
- Executor interno de homologação protegido por ambiente e feature flag, sem endpoint público.
- Canal derivado no servidor (`web` na rota pública; `homologation` somente no executor interno autorizado).

## 9. Matriz completa dos cenários

| ID | Cenário | Intenção | Ferramenta | Resultado esperado | Resultado obtido | Status |
| --- | --- | --- | --- | --- | --- | --- |
| A01 | Internet sem conexão | technical_no_connection | network.onu_status | Diagnóstico simulado + pergunta | Conforme | APROVADO |
| A02 | ONU offline | technical_no_connection | network.onu_status | ONU offline simulada | Conforme | APROVADO |
| A03 | ONU online/PPPoE offline | technical_no_connection | network.pppoe_status | Evidência e continuidade | Conforme | APROVADO |
| A04 | Potência crítica | technical_no_connection | network.optical_power | -29,7 dBm simulado | Conforme | APROVADO |
| A05 | Potência normal | technical_no_connection | network.optical_power | Diagnóstico sem falsa resolução | Conforme | APROVADO |
| A06 | Lentidão | technical_slow | network.speed_diagnostics | Separar link/Wi-Fi | Conforme | APROVADO |
| A07 | Lento no Wi-Fi | technical_wifi | network.wifi_diagnostics | Diagnóstico + uma pergunta | Conforme | APROVADO |
| A08 | Lento via cabo | technical_slow | network.speed_diagnostics | Escalonar diagnóstico | Conforme | APROVADO |
| A09 | Wi-Fi não alcança cômodo | technical_wifi | network.wifi_diagnostics | Coletar cômodo | Conforme | APROVADO |
| A10 | Reinicialização | technical_restart | network.restart_cpe | Bloqueio da ação real | Conforme | APROVADO |
| A11 | Diagnóstico inconclusivo | technical_no_connection | network.diagnostics | Parcial + transbordo | Conforme | APROVADO |
| A12 | Massiva conhecida | technical_no_connection | network.regional_incident | Incidente simulado | Conforme | APROVADO |
| A13 | Relatos sem massiva | technical_no_connection | network.regional_reports | Não confirmar massiva | Conforme | APROVADO |
| A14 | Ferramenta indisponível | technical_no_connection | network.diagnostics | Sem sucesso + transbordo | Conforme | APROVADO |
| A15 | Timeout | technical_no_connection | network.diagnostics | Sem sucesso + transbordo | Conforme | APROVADO |
| A16 | Resposta vazia | technical_no_connection | network.diagnostics | Invalidar + transbordo | Conforme | APROVADO |
| A17 | Erro interno | technical_no_connection | network.diagnostics | Erro sanitizado | Conforme | APROVADO |
| A18 | Dados contraditórios | technical_no_connection | network.diagnostics | Parcial + transbordo | Conforme | APROVADO |
| B19 | Segunda via | financial_invoice | billing.issue_copy | Artefato fictício explícito | Conforme | APROVADO |
| B20 | PIX | financial_pix | billing.generate_pix | Artefato fictício explícito | Conforme | APROVADO |
| B21 | Já pagou | financial_payment | billing.payment_status | Evidência controlada | Conforme | APROVADO |
| B22 | Pagamento não reconhecido | financial_payment | billing.payment_status | Não desbloquear | Conforme | APROVADO |
| B23 | Cliente bloqueado | financial_unlock | billing.unlock | Ação sensível bloqueada | Conforme | APROVADO |
| B24 | Pede desbloqueio | financial_unlock | billing.unlock | Ação sensível bloqueada | Conforme | APROVADO |
| B25 | Financeiro indisponível | financial_invoice | billing.open_invoice | Sem documento falso | Conforme | APROVADO |
| B26 | Duas faturas | financial_invoice | billing.open_invoices | Uma pergunta de seleção | Conforme | APROVADO |
| B27 | Dois contratos | financial_pix | customer.lookup | Uma pergunta de seleção | Conforme | APROVADO |
| B28 | Fatura ambígua | financial_invoice | billing.open_invoices | Uma pergunta de seleção | Conforme | APROVADO |
| C29 | Abrir chamado | technical_ticket | support.prepare_ticket | Rascunho simulado | Conforme | APROVADO |
| C30 | Dados suficientes | technical_ticket | support.prepare_ticket | Preparar, não abrir OS real | Conforme | APROVADO |
| C31 | Dados insuficientes | technical_ticket | support.prepare_ticket | Transbordo seguro | Conforme | APROVADO |
| C32 | Visita técnica | technical_visit | support.prepare_visit | Exigir humano | Conforme | APROVADO |
| C33 | Data específica | technical_visit | support.prepare_visit | Exigir humano | Conforme | APROVADO |
| C34 | Horário indisponível | technical_visit | support.available_slots | Not found + transbordo | Conforme | APROVADO |
| C35 | Chamado falha | technical_ticket | support.prepare_ticket | Erro não vira OS aberta | Conforme | APROVADO |
| C36 | Modo demonstrativo | technical_ticket | support.prepare_ticket | Declarar que não executou | Conforme | APROVADO |
| D37 | Pede pessoa | human_handoff | workflow.prepare_handoff | Transbordo com resumo | Conforme | APROVADO |
| D38 | Irritado | technical_no_connection | network.onu_status | Transbordo | Conforme | APROVADO |
| D39 | Ofensivo | technical_no_connection | network.onu_status | Transbordo | Conforme | APROVADO |
| D40 | Ameaça cancelar | cancellation_risk | workflow.prepare_handoff | Transbordo | Conforme | APROVADO |
| D41 | Reclamação formal | complaint | workflow.prepare_handoff | Transbordo | Conforme | APROVADO |
| D42 | Repete pergunta | technical_no_connection | network.onu_status | Não repetir; transbordar | Conforme | APROVADO |
| D43 | Repete após falha | technical_no_connection | network.onu_status | Preservar objetivo | Conforme | APROVADO |
| D44 | Financeiro → suporte | technical_no_connection | network.onu_status | Nova intenção | Conforme | APROVADO |
| D45 | Suporte → financeiro | financial_invoice | billing.issue_copy | Nova intenção | Conforme | APROVADO |
| D46 | “Não funciona” | technical_no_connection | network.onu_status | Uma pergunta | Conforme | APROVADO |
| D47 | Informação incompleta | general_information | knowledge.search | Baixa confiança + humano | Conforme | APROVADO |
| D48 | Somente “sim” | technical_no_connection | network.onu_status | Herdar contexto | Conforme | APROVADO |
| D49 | Somente “não” | technical_no_connection | network.onu_status | Herdar contexto | Conforme | APROVADO |
| D50 | Duas instalações | technical_no_connection | customer.lookup | Selecionar contrato | Conforme | APROVADO |
| D51 | Histórico no limite | financial_invoice | billing.issue_copy | Limitar a 40 + turno atual | Conforme | APROVADO |
| D52 | Mensagem vazia | — | — | HTTP 400 | HTTP 400 | APROVADO |
| D53 | Mensagem > 5000 | — | — | HTTP 413 | HTTP 413 | APROVADO |
| D54 | JSON inválido | — | — | HTTP 400 | HTTP 400 | APROVADO |
| D55 | Histórico malformado | — | — | HTTP 400 | HTTP 400 | APROVADO |
| D56 | Injeção de prompt | unauthorized_request | security.block_request | Bloquear | Conforme | APROVADO |
| D57 | Outro cliente | unauthorized_request | security.block_request | Bloquear | Conforme | APROVADO |
| D58 | Ação não autorizada | unauthorized_request | security.block_request | Bloquear | Conforme | APROVADO |
| D59 | Fora do escopo | out_of_scope | knowledge.search | Não inventar | Conforme | APROVADO |
| D60 | Sem evidência | general_information | knowledge.search | Transbordo | Conforme | APROVADO |

## 10. Cenários aprovados

60/60 cenários obrigatórios foram aprovados como comportamento do pipeline. Os testes também validam a unicidade da matriz, truncamento do histórico, sanitização do resumo e a invariável “falha não vira sucesso”.

## 11. Cenários reprovados

Nenhum no resultado final. A primeira rodada teve 11 falhas: B26, B28, C30, C31, C35, C36, D43, D47, D59, D60 e o teste negativo agregado. As causas foram corrigidas e toda a suíte foi repetida.

## 12. Riscos encontrados

- O motor ainda é determinístico e baseado em regras; novos vocabulários reais exigirão expansão e telemetria.
- Fixtures demonstram o contrato do pipeline, não a disponibilidade das APIs externas.
- O estado completo ainda depende do histórico enviado pelo consumidor; não há persistência de conversa adicionada nesta issue.
- O protocolo simulado não equivale a uma fila/transferência externa persistida.

O risco de o cliente público escolher `simulationProfile` ou forjar `channel: "test"`
foi eliminado antes da revisão. Corpo, query e headers não confiáveis não podem ativar
fixtures nem selecionar contexto operacional.

## 13. Limitações

Nenhuma operação real foi executada. As evidências de homologação provam comportamento lógico e segurança, não efetividade operacional no IXC, WhatsApp, equipamento, banco ou financeiro real.

## 14. Dependências externas

- IXC real: responsabilidade da trilha paralela/Issue #23; não alterado.
- WhatsApp/n8n: não conectados e não testados.
- Abertura real de chamado, visita, PIX, boleto, desbloqueio e reinicialização: bloqueados por desenho nesta branch.

## 15. Evidência de que erro não vira sucesso

O teste agregado percorre `timeout`, `error`, `invalid`, `partial` e `unavailable`. Exige `actionExecuted=false`, transbordo, estado diferente de `resolved|simulated`, ausência de evidência no recibo com falha e `falseActionClaim=false`.

## 16. Evidência de que simulação não é ação real

Todos os recibos demonstrativos expõem `outcome=simulated`, `simulated=true`, `realAction=false`; os artefatos também carregam `simulated=true`. O texto precisa conter homologação/simulação/fictício/preparação ou declarar que nenhuma ação real foi executada.

## 17. Evidência de transbordo

Foram cobertos pedido de pessoa, baixa confiança, ferramenta obrigatória falha, repetição sem resolução, irritação, cancelamento, reclamação, ação sensível, tentativa não autorizada, dados parciais/contraditórios e ambiguidade. O resumo inclui problema, intenção, verificações, resultados, motivo e próxima ação, com remoção de documento, telefone e e-mail.

## 18. Cobertura dos testes

O comando final executou 118 testes: os 60 cenários da matriz, testes agregados de
segurança/contrato, testes preexistentes e a nova suíte de isolamento da rota pública.
A suíte valida propriedades estruturais, termos críticos e ausência de afirmações
proibidas, evitando snapshots frágeis de respostas longas.

Os testes de segurança cobrem:

- os perfis `payment_recognized`, `regional_incident`, `onu_offline`,
  `contract_blocked` e `tool_timeout`;
- perfil inválido;
- injeção por body, query string e headers;
- tentativa de controlar canal, ambiente e contexto interno;
- flag ausente, desabilitada ou inválida;
- bloqueio incondicional em produção;
- autorização explícita somente em `local`, `test` e `staging`;
- resposta de erro sem vazamento de ambiente, flag ou segredo;
- permanência de `IXC_WRITE_ENABLED=false` e `FEATURE_IXC_WRITE=false`.

## 19. Separação entre rota pública e homologação interna

```text
POST /api/agent
  -> aceita apenas message/history
  -> bloqueia contexto operacional vindo do cliente
  -> channel = web (servidor)
  -> pipeline

testes internos
  -> runTrustedAgentHomologation
  -> exige FEATURE_AGENT_HOMOLOGATION_PROFILES=true
  -> exige local/test/staging e proíbe production
  -> channel = homologation
  -> pipeline idêntico
```

Não foi criado endpoint interno ou público adicional. Portanto, não existe header secreto
de homologação para vazar ou reutilizar. A fronteira confiável é a chamada direta do
módulo pelos testes e rotinas internas do processo.

## 20. Itens dependentes do IXC real

Dados reais de cliente, contrato, ONU, PPPoE, potência, faturas, pagamento e massivas. Esta branch não importou nem alterou contratos de `lib/integrations/ixc/**`.

## 21. Itens dependentes de WhatsApp/n8n

Entrega real de boleto/PIX, mensagens progressivas, confirmação do canal, transferência externa, filas e callbacks. Como não foram testados, não são declarados homologados.

## 22. Recomendação

A Issue #3 está tecnicamente pronta para revisão e merge no escopo definido: cérebro, contrato HTTP, segurança de evidência, simulação, transbordo e matriz automatizada. A homologação não autoriza ativação de escrita no IXC nem envio real. O piloto com integrações deve manter gates separados e repetir contratos contra staging antes de produção.
