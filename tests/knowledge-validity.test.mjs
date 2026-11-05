import test from 'node:test';
import assert from 'node:assert/strict';
import { isKnowledgeCurrent, searchDocuments, DbKnowledgeRepository } from '../lib/platform/knowledge-service.ts';

const NOW = new Date('2026-11-06T02:59:59.999Z'); // Still Nov 5 in São Paulo.
const doc = (id, validUntil, status = 'published') => ({ id, validUntil, status, title: 'Lentidão fibra', category: 'Suporte', content: 'Faça teste cabeado de fibra.', version: 1, updatedAt: '2026-01-01T00:00:00Z' });

test('validade civil cobre o dia inteiro em São Paulo, independente do fuso do processo', () => {
  const before = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/Sao_Paulo', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      assert.equal(isKnowledgeCurrent('2026-11-05', NOW), true, zone);
      assert.equal(isKnowledgeCurrent('2026-11-05', new Date('2026-11-06T03:00:00Z')), false, zone);
      assert.equal(isKnowledgeCurrent('2026-11-04', NOW), false, zone);
      assert.equal(isKnowledgeCurrent('2026-11-06', NOW), true, zone);
    }
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
});

test('instante ISO vence exatamente no limite, com Z ou deslocamento explícito', () => {
  for (const until of ['2026-11-06T03:00:00Z', '2026-11-06T03:00:00.000Z', '2026-11-06T00:00:00-03:00']) {
    assert.equal(isKnowledgeCurrent(until, NOW), true, until);
    assert.equal(isKnowledgeCurrent(until, new Date('2026-11-06T03:00:00Z')), false, until);
  }
});

test('datas inexistentes e validade malformada falham fechadas', () => {
  for (const until of ['', '2026-11-31', '2027-02-29', '2100-02-29', '0000-01-01', '2026-13-01', '2026-1-01',
    ' 2099-01-01', '2099-01-01\n', '2099-02-30T12:00:00Z', '2099-01-01T24:00:00Z',
    '2099-01-01T12:60:00Z', '2099-01-01T12:00:60Z', '2099-01-01T12:00:00', '2099-01-01T12:00:00+25:00', undefined, {}, 20990101]) {
    assert.equal(isKnowledgeCurrent(until, NOW), false, String(until));
  }
  assert.equal(isKnowledgeCurrent('2099-01-01', new Date('invalid')), false);
});

test('ano bissexto e ausência explícita de prazo continuam válidos', () => {
  assert.equal(isKnowledgeCurrent(null, NOW), true);
  assert.equal(isKnowledgeCurrent('2028-02-29', new Date('2028-02-29T12:00:00Z')), true);
  assert.equal(isKnowledgeCurrent('2000-02-29', new Date('2000-02-29T12:00:00Z')), true);
});

test('busca remove fonte vencida antes de ranquear e preserva somente publicadas válidas', () => {
  const documents = [doc('expired', '2026-11-04'), doc('current', '2026-11-05'), doc('future', '2026-11-06'),
    doc('unbounded', null), doc('invalid', '2099-02-30'), doc('draft', null, 'draft')];
  assert.deepEqual(searchDocuments(documents, 'lentidão fibra', NOW).map(hit => hit.document.id), ['current', 'future', 'unbounded']);
  assert.deepEqual(searchDocuments(documents, 'assunto inexistente', NOW), []);
});


test('repositório real preserva metadados inválidos em vez de remover prazo', async () => {
  const rows = [doc('empty', ''), doc('zero', 0), doc('null', null), doc('valid', '2026-11-05')];
  const db = { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) };
  const documents = await new DbKnowledgeRepository(db).list(20);
  assert.equal(documents[0].validUntil, '');
  assert.equal(documents[1].validUntil, '0');
  assert.deepEqual(searchDocuments(documents, 'lentidão fibra', NOW).map(hit => hit.document.id), ['null', 'valid']);
});
