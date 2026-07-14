# Fase 2 profissional

## Escopo entregue

Navegação completa; Customer 360; suporte, monitoramento, mapa, massivas e chamados; cobrança, régua, campanhas e relatórios; comercial, leads, funil, Kanban, metas e relatórios; Customer Intelligence, saúde, churn operacional e upgrade; base de conhecimento; filas; integrações; RBAC; auditoria; avaliações e versionamento de prompts.

## Dados e persistência

O projeto preserva Drizzle/D1. A migration `drizzle/0000_flippant_doctor_strange.sql` cria oito tabelas sem apagar ou alterar dados existentes. Ela foi gerada e revisada, mas não aplicada porque o Site não possui binding D1 ativo. Dados funcionais continuam tipados e identificados como mock.

## Segurança

- Integrações reais desativadas.
- IXC sem escrita.
- Meta/Evolution sem envio.
- Documentos, telefone e entidades mascarados.
- Ações sensíveis exigem RBAC, confirmação e auditoria.
- Jobs usam IDs demonstrativos, idempotência e correlação sem payload sensível.

## Anti-repetição

Cada resposta gera fingerprint com texto normalizado, intenção, objetivo, ações e artefatos. O detector combina igualdade, trigramas, Jaccard e similaridade da abertura. Similaridade alta permite uma regeneração orientada a progresso; nova reprovação produz resposta segura/handoff.

O estado registra objetivo, etapa, dados coletados, pergunta pendente, informação fornecida, ações executadas, artefatos, bloqueio e próximo passo. O avaliador expõe repetição, novidade, progresso, resposta à pergunta, pergunta desnecessária, alegação falsa e continuidade.

## Rollback

1. Manter integrações desativadas.
2. Reverter o commit da fatia afetada.
3. Não aplicar/reverter migration sem backup e revisão.
4. Desligar o módulo pelo roteador de navegação se uma falha bloquear a operação.
5. Preservar eventos de auditoria e correlation IDs.

## Produção futura

Conectar PostgreSQL/D1 compatível, Redis/BullMQ, IXC leitura em homologação, Chatwoot e Meta somente após credenciais em cofre, testes de contrato, política LGPD, rate limit, DLQ e rollout gradual.
