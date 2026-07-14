INSERT OR IGNORE INTO customers (id, external_id, masked_document, name, city, neighborhood, created_at, updated_at)
VALUES
  ('STG-001', 'IXC-AUTH-001', '***.***.***-01', 'Cliente Interno 01', 'Itabaiana', 'Bairro mascarado', datetime('now'), datetime('now')),
  ('STG-002', 'IXC-AUTH-002', '***.***.***-02', 'Cliente Interno 02', 'Ribeirópolis', 'Bairro mascarado', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO audit_events (id, actor_id, role, action, entity, reason, correlation_id, result, origin, created_at)
VALUES ('AUD-STG-SEED-001', 'system', 'system', 'staging.seed', 'customers', 'Seed sintético da homologação', 'corr-staging-seed', 'success', 'human', datetime('now'));
