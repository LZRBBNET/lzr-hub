"""Stdlib-only launcher refusal, sanitization and cleanup fault tests; no Docker calls."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('observe_lab', Path(__file__).resolve().parents[1] / 'scripts/run-collection-observe-lab.py')
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)

class LauncherTests(unittest.TestCase):
    def invoke(self, args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = lab.main(args)
        return code, json.loads(output.getvalue().splitlines()[-1])

    def test_missing_opt_in_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'new'
            code, result = self.invoke(['--output', str(target)])
            self.assertEqual((code, result['reason']), (78, 'approval-required'))
            self.assertFalse(target.exists())

    def test_existing_output_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            marker = Path(temp) / 'marker'
            marker.write_text('SYNTHETIC-CANARY')
            code, result = self.invoke(['--approve-local-synthetic', '--output', temp])
            self.assertEqual((code, result['reason']), (78, 'output-exists-or-invalid'))
            self.assertEqual(marker.read_text(), 'SYNTHETIC-CANARY')
            self.assertEqual(sorted(p.name for p in Path(temp).iterdir()), ['marker'])

    def test_missing_dependencies_fail_before_docker(self):
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(lab.Lab, 'preflight', side_effect=AssertionError('MUST_NOT_START')):
            code, result = self.invoke(['--approve-local-synthetic', '--output', str(Path(temp) / 'new'),
                                        '--queue-dependencies', str(Path(temp) / 'missing/node_modules')])
            self.assertEqual((code, result['reason']), (78, 'dependencies-unavailable'))
            self.assertTrue(result['cleanupConfirmed'])

    def test_missing_cached_image_never_creates_or_pulls(self):
        with tempfile.TemporaryDirectory() as temp:
            obj = lab.Lab(Path(temp), '0' * 32, '/synthetic/docker')
            calls = []
            def command(args, reason='docker-command', timeout=10):
                calls.append(args)
                if args[0] == 'info':
                    return '["name=rootless","name=seccomp,profile=builtin"]'
                raise lab.LabError('image-unavailable')
            exists, pathstat = Path.exists, Path.stat
            def fake_exists(path):
                return True if str(path) == '/var/run/docker.sock' else exists(path)
            def fake_stat(path, *args, **kwargs):
                return type('SocketMetadata', (), {'st_mode': stat.S_IFSOCK})() if str(path) == '/var/run/docker.sock' else pathstat(path, *args, **kwargs)
            with mock.patch.object(obj, 'command', side_effect=command), mock.patch.object(lab.os, 'getuid', return_value=1000), mock.patch.object(Path, 'exists', fake_exists), mock.patch.object(Path, 'stat', fake_stat):
                with self.assertRaisesRegex(lab.LabError, '^image-unavailable$'):
                    obj.preflight()
            self.assertEqual([v[0] for v in calls], ['info', 'image'])
            self.assertEqual(obj.attempted, [])

    def test_cleanup_continues_after_failure_and_does_not_remove_foreign_container(self):
        with tempfile.TemporaryDirectory() as temp:
            obj = lab.Lab(Path(temp), '0' * 32, '/synthetic/docker')
            obj.socket.mkdir()
            obj.attempted = ['redis', 'node']
            calls = []
            def command(args, reason='docker-command', timeout=10):
                calls.append((args, timeout))
                if args[0] == 'ps':
                    return 'synthetic-id\n'
                raise lab.LabError('cleanup-remove-uncertain')
            def inspect(name):
                role = 'node' if name == obj.names['node'] else 'redis'
                return {'Id': 'synthetic-' + role, 'Image': lab.IMAGES[role][0],
                        'Config': {'Labels': {'lzr.lab.owner': obj.owner if role == 'node' else 'foreign'}}}
            with mock.patch.object(obj, 'command', side_effect=command), mock.patch.object(obj, 'inspect', side_effect=inspect):
                result = obj.cleanup()
            self.assertFalse(result['confirmed'])
            self.assertTrue(result['resources']['redis']['foreignUntouched'])
            self.assertTrue(obj.socket.exists())
            self.assertEqual([args for args, _ in calls if args[0] == 'rm'], [['rm', '-f', 'synthetic-node']])
            self.assertTrue(all(0 < timeout <= 10 for _, timeout in calls))

    def test_result_drops_unknown_fields_and_refuses_unknown_scenario(self):
        scenarios = ['paid', 'paid-reexecution', 'promise', 'expired-promise-old-schedule', 'zero-unconfirmed', 'source-unavailable', 'eligible-control']
        value = {'passed': True, 'bullmqVersion': '5.81.2', 'queue': 'real-local-redis', 'deliveryTransport': 'absent', 'workerConcurrency': 2,
                 'results': [{'scenario': s, 'state': 'failed', 'delivered': False, 'private': 'SYNTHETIC-MARKER'} for s in scenarios],
                 'counts': dict.fromkeys(['waiting', 'active', 'delayed', 'failed', 'completed', 'paused'], 0), 'dlq': 0, 'headers': 'SYNTHETIC-MARKER'}
        self.assertNotIn('SYNTHETIC-MARKER', json.dumps(lab.safe_result(json.dumps(value))))
        value['results'][0]['scenario'] = 'SYNTHETIC-MARKER'
        with self.assertRaisesRegex(lab.LabError, '^consumer-result$'):
            lab.safe_result(json.dumps(value))

if __name__ == '__main__':
    unittest.main()
