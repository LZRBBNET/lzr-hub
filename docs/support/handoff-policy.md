# Política de transbordo (quando a IA passa para um humano)

Este documento descreve, por escrito, em que situações o atendimento sai da IA e vai para uma pessoa. A regra está implementada em [`lib/agent/handoff.ts`](../../lib/agent/handoff.ts) — este texto é a versão legível dela, e os dois devem andar juntos.

## Princípio

A IA resolve o N1 (dúvidas comuns: fatura, segunda via, sem conexão, lentidão). Ela **só continua** enquanto tiver evidência do que está afirmando. Na dúvida, transborda: é melhor passar para um humano do que responder errado sobre a conta ou a conexão de alguém.

## Os 4 casos da política

### 1. O cliente pediu para falar com uma pessoa
Motivo registrado: `customer_requested_human`

Pedido explícito é atendido na hora, sem insistir e sem tentar "resolver antes". Não se negocia com quem já pediu um humano.

### 2. A IA não tem evidência para responder
Motivos registrados: `low_intent_confidence`, `required_tool_failed`, `contradictory_or_partial_data`, `repetition_without_resolution`

Cobre quatro situações reais:
- **Não entendeu o pedido** — confiança na intenção abaixo de 0,6
- **A consulta falhou** — a ferramenta que traria o dado (IXC, diagnóstico) não respondeu, deu timeout ou erro
- **Os dados se contradizem** — resultado parcial ou inconsistente, onde responder seria chutar
- **Está repetindo sem avançar** — a conversa girou em círculos sem resolver nada

### 3. O cliente está irritado
Motivo registrado: `customer_irritated`

Detectado por sinais no texto (xingamentos, menção a processo ou Anatel, reclamação de incompetência). Cliente irritado escala rápido — a IA sai de cena antes de piorar.

### 4. O assunto é sensível
Motivos registrados: `formal_complaint`, `cancellation_risk`, `sensitive_action`, `unauthorized_request`

- **Reclamação formal** — tem consequência contratual/regulatória
- **Risco de cancelamento** — retenção é conversa de gente, não de robô
- **Ação sensível** — ex.: desbloqueio de contrato, que mexe no serviço do cliente
- **Pedido não autorizado** — tentativa de acessar algo que aquele cliente não pode

## O que o atendente recebe

Todo transbordo gera um resumo automático com: o problema relatado, a intenção detectada, quais consultas foram feitas e seus resultados, e o motivo do transbordo.

Esse resumo passa por **sanitização obrigatória** antes de ser gravado — e-mail, CPF/CNPJ e telefone são substituídos por marcadores (`[EMAIL REDACTED]`, `[DOCUMENTO REDACTED]`, `[TELEFONE REDACTED]`). O atendente recebe contexto, não dado pessoal solto.

## Como isso é medido

Cada conversa encerrada registra seu desfecho em `conversation_outcomes` (resolvida pela IA ou transbordada, e por qual motivo). Isso alimenta o indicador de **% resolvido sem humano** no painel de suporte.

O CSAT é coletado ao final da conversa pelo próprio canal (nota de 1 a 5) e guardado em `csat_ratings`. Ver [`lib/platform/support-metrics.ts`](../../lib/platform/support-metrics.ts).

## Limite conhecido

**Custo por atendimento ainda não é medido.** Depende da observabilidade via Langfuse (issue #6), que não está implementada. O painel mostra os outros indicadores e sinaliza esse como indisponível, em vez de exibir um número inventado.
