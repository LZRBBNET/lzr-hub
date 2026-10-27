import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecoveryTestTarget } from '../scripts/test-recovery-cases-postgres.mjs';

test('Postgres recovery gate never inherits production DATABASE_URL', () => {
  assert.throws(() => validateRecoveryTestTarget({ DATABASE_URL: 'postgres://production/db' }), /NOT RUN/);
});
test('Postgres recovery gate requires literal loopback, disposable name and exact opt-in', () => {
  const good = { RECOVERY_CASE_TEST_DATABASE_URL: 'postgres://test:local@127.0.0.1:55432/lzr_recovery_test_cases', RECOVERY_CASE_TEST_ALLOW_MIGRATION: 'lzr_recovery_test_cases' };
  assert.equal(validateRecoveryTestTarget(good).database, 'lzr_recovery_test_cases');
  for (const url of ['postgres://test@localhost/lzr_recovery_test_cases', 'postgres://test@db.internal/lzr_recovery_test_cases', 'postgres://test@127.0.0.1/production', 'postgres://test@127.0.0.1/lzr_recovery_test_cases?host=production', 'file:///lzr_recovery_test_cases']) {
    assert.throws(() => validateRecoveryTestTarget({ ...good, RECOVERY_CASE_TEST_DATABASE_URL: url }), /Refused/);
  }
  assert.throws(() => validateRecoveryTestTarget({ ...good, RECOVERY_CASE_TEST_ALLOW_MIGRATION: 'yes' }), /Refused/);
});
