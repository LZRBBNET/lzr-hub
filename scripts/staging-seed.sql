-- Seed idempotente e exclusivamente sintético para a demonstração protegida.
-- IDs, documentos, contatos, contratos e estados abaixo não representam pessoas reais.

INSERT OR REPLACE INTO customers
  (id, external_id, masked_document, name, city, neighborhood, created_at, updated_at)
VALUES
  ('DEMO-CLI-001', 'DEMO-EXTERNAL-001', 'DOC-DEMO-001-INVALIDO', 'João Pereira', 'Itabaiana', 'Centro Demo', '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z'),
  ('DEMO-CLI-002', 'DEMO-EXTERNAL-002', 'DOC-DEMO-002-INVALIDO', 'Maria Souza', 'Lagarto', 'Boa Vista Demo', '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z'),
  ('DEMO-CLI-003', 'DEMO-EXTERNAL-003', 'DOC-DEMO-003-INVALIDO', 'Rafael Costa', 'Campo do Brito', 'Centro Demo', '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z'),
  ('DEMO-CLI-004', 'DEMO-EXTERNAL-004', 'DOC-DEMO-004-INVALIDO', 'Ana Carvalho', 'São Domingos', 'Centro Demo', '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z');

INSERT OR REPLACE INTO network_incidents
  (id, title, severity, status, city, neighborhood, equipment, affected_customers, started_at, ended_at, created_at, updated_at)
VALUES
  ('DEMO-INC-001', 'Perda óptica fictícia', 'critical', 'investigating-demo', 'Itabaiana', 'Queimadas Demo', 'OLT-DEMO-01 / PON-DEMO-07', 184, '2026-07-24T07:18:00Z', NULL, '2026-07-24T07:18:00Z', '2026-07-24T08:00:00Z'),
  ('DEMO-INC-002', 'PPPoE offline fictício', 'medium', 'monitoring-demo', 'São Domingos', 'Centro Demo', 'BRAS-DEMO-01', 31, '2026-07-24T07:40:00Z', NULL, '2026-07-24T07:40:00Z', '2026-07-24T08:00:00Z');

INSERT OR REPLACE INTO collection_rules
  (id, name, status, version, author_id, created_at, updated_at)
VALUES ('DEMO-RULE-001', 'Régua demonstrativa — nenhum envio real', 'demo-only', 1, 'DEMO-ADMIN', '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z');

INSERT OR REPLACE INTO collection_rule_steps
  (id, rule_id, offset_days, channel, template_id, attempts, active, created_at, updated_at)
VALUES
  ('DEMO-STEP-001', 'DEMO-RULE-001', -3, 'mock', 'DEMO-TEMPLATE-PREVENTIVO', 1, 1, '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z'),
  ('DEMO-STEP-002', 'DEMO-RULE-001', 5, 'mock', 'DEMO-TEMPLATE-ATRASO', 1, 1, '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z');

INSERT OR REPLACE INTO collection_campaigns
  (id, name, segment, status, audience, recovered_cents, created_at, updated_at)
VALUES ('DEMO-CAM-001', 'Campanha fictícia de cobrança', 'Atraso sintético', 'queued-demo', 42, 0, '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z');

INSERT OR REPLACE INTO leads
  (id, name, masked_phone, city, neighborhood, source, stage, score, owner_id, created_at, updated_at)
VALUES ('DEMO-LEAD-001', 'Comércio Exemplo', '(79) 9DEMO-0001', 'Itabaiana', 'Centro Demo', 'Formulário demo', 'Qualificado fictício', 88, 'DEMO-ADMIN', '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z');

INSERT OR REPLACE INTO knowledge_documents
  (id, title, category, content, status, version, metadata, valid_until, created_at, updated_at)
VALUES ('DEMO-KB-001', 'Diagnóstico fictício de ONU offline', 'Suporte demo', 'Conteúdo sintético para navegação; não executar em produção.', 'published-demo', 1, '{"synthetic":true,"contact":"suporte@example.invalid"}', '2026-12-31', '2026-07-24T08:00:00Z', '2026-07-24T08:00:00Z');

INSERT OR REPLACE INTO audit_events
  (id, actor_id, role, action, entity, reason, correlation_id, result, origin, created_at)
VALUES
  ('DEMO-AUD-001', 'DEMO-SYSTEM', 'system', 'staging.seed', 'synthetic-demo-data', 'Seed exclusivamente sintético', 'demo-seed-001', 'simulated', 'system', '2026-07-24T08:00:00Z'),
  ('DEMO-AUD-002', 'DEMO-AGENT', 'ai', 'billing.prepare_pix_demo', 'DEMO-INVOICE-001', 'Nenhum PIX real foi gerado', 'demo-pix-002', 'simulated', 'ai', '2026-07-24T08:05:00Z'),
  ('DEMO-AUD-003', 'DEMO-AGENT', 'ai', 'ixc.unlock', 'DEMO-CONTRACT-001', 'IXC e escrita externa desativados', 'demo-blocked-003', 'blocked', 'ai', '2026-07-24T08:06:00Z');
