"""Opt-in disposable Redis/Node lab. No installation, remote target or worker bootstrap."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

IMAGES = {
    'redis': ('sha256:e7b0b929eb5b1e7b18f4662e190ceeac481b72e35dfede063b09a4ce8beac79f',
              'redis@sha256:c5d34a98396a4775e223c74e929162c35c5a2182901ba26b50ade939941ce14b'),
    'node': ('sha256:280af3207172947339cc2e8c9d2efac585716fd906af49f57d6fdf0dbb829a73',
             'node@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4'),
}
SOURCE_HASHES = {
    'services/queue-runtime/src/billing-reminders.mjs': '006c13c807283621aa53ba4fdd073588d0493ba316da76f223f934276c290c2e',
    'services/queue-runtime/src/promise-hold.mjs': 'e107f2c3ac7ff7e1a0b622a7921a7132868bd00dd2e50e6a5e4e725d1a02f609',
    'services/queue-runtime/src/processor.mjs': '452136ae0f1f77432db94074347b2b95f812769b207f402a994fe65e809fab9b',
    'services/queue-runtime/src/failed-job-handler.mjs': '7fb7014d8f491419e95c163b042c4d8950ff95110f535ccf92d0115cf2657420',
    'services/queue-runtime/src/config.mjs': '2a49aa6afc1acf4f3949d670d9bad202b27ba23579a306f32a7e2da243ffe780',
    'services/queue-runtime/package.json': 'f3fbcfcf14204cb85c81512d299b312c2ad46bbf54579fa032ee58c9de7091d8',
    'tests/manual/collection-observe-consumer-local.mjs': '2ad22a746c2b03946b209564a10872a8e5417a216369e6e568e3b5188224d6c1',
}

class LabError(Exception):
    pass

class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise LabError('arguments')

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def require(condition, reason):
    if not condition:
        raise LabError(reason)

def dependencies(path):
    require(path.is_dir() and path.name == 'node_modules', 'dependencies-unavailable')
    require(not any((path / name).exists() for name in ['.env', '.npmrc']), 'dependencies-config-refused')
    package = path / 'bullmq/package.json'
    require(package.is_file() and not package.is_symlink() and package.resolve().is_relative_to(path), 'dependencies-unavailable')
    try:
        require(json.loads(package.read_text()).get('version') == '5.81.2', 'dependencies-version')
    except (ValueError, OSError):
        raise LabError('dependencies-unavailable') from None

def safe_result(text):
    try:
        value = json.loads(text)
        require(value['passed'] is True and value['bullmqVersion'] == '5.81.2'
                and value['queue'] == 'real-local-redis' and value['deliveryTransport'] == 'absent'
                and value['workerConcurrency'] == 2, 'consumer-result')
        scenarios = ['paid', 'paid-reexecution', 'promise', 'expired-promise-old-schedule',
                     'zero-unconfirmed', 'source-unavailable', 'eligible-control']
        require([item['scenario'] for item in value['results']] == scenarios, 'consumer-result')
        result = []
        numeric = ['attempts', 'reads', 'extraReads', 'continuations', 'subsequentReminderEnqueued',
                   'duplicateProducers', 'uniqueJob', 'dlqDelta']
        for item in value['results']:
            require(item['state'] in ['failed', 'completed'] and item['delivered'] is False, 'consumer-result')
            row = {key: item[key] for key in ['scenario', 'state', 'delivered']}
            for key in numeric:
                if key in item:
                    require(type(item[key]) is int and 0 <= item[key] <= 100, 'consumer-result')
                    row[key] = item[key]
            result.append(row)
        counts = {key: value['counts'][key] for key in ['waiting', 'active', 'delayed', 'failed', 'completed', 'paused']}
        require(all(type(v) is int and 0 <= v <= 100 for v in counts.values()), 'consumer-result')
        require(type(value['dlq']) is int and 0 <= value['dlq'] <= 100, 'consumer-result')
        return {'passed': True, 'bullmqVersion': '5.81.2', 'workerConcurrency': 2,
                'queue': 'real-local-redis', 'deliveryTransport': 'absent', 'results': result,
                'counts': counts, 'dlq': value['dlq']}
    except (ValueError, KeyError, TypeError):
        raise LabError('consumer-result') from None

class Lab:
    def __init__(self, output, run_id, docker):
        self.output, self.run_id, self.docker = output, run_id, docker
        self.owner = uuid.uuid4().hex
        self.socket = output / 'socket'
        self.config = output / 'docker-config'
        self.attempted = []
        self.images = {}
        self.names = {role: 'lzr-billing-lab-' + run_id + '-' + role for role in IMAGES}
        self.environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(self.config)}

    def command(self, args, reason='docker-command', timeout=10):
        try:
            proc = subprocess.run([self.docker, '--config', str(self.config),
                                   '--host=unix:///var/run/docker.sock', *args],
                                  env=self.environment, capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            raise LabError(reason + '-uncertain') from None
        require(proc.returncode == 0, reason)
        return proc.stdout

    def inspect(self, target):
        try:
            return json.loads(self.command(['inspect', target], 'inspection'))[0]
        except (ValueError, IndexError, KeyError):
            raise LabError('inspection') from None

    def preflight(self):
        require(os.getuid() == 1000, 'uid-unsupported')
        sock = Path('/var/run/docker.sock')
        require(sock.exists() and stat.S_ISSOCK(sock.stat().st_mode), 'local-daemon-unavailable')
        self.config.mkdir(mode=0o700)
        (self.config / 'config.json').write_text('{}\n')
        security = json.loads(self.command(['info', '--format', '{{json .SecurityOptions}}'], 'daemon-unavailable'))
        require('name=rootless' in security and any(v.startswith('name=seccomp') for v in security), 'daemon-controls')
        for role, (image, digest) in IMAGES.items():
            try:
                meta = json.loads(self.command(['image', 'inspect', image], 'image-unavailable'))[0]
            except (ValueError, IndexError):
                raise LabError('image-unavailable') from None
            require(meta['Id'] == image and digest in meta.get('RepoDigests', [])
                    and meta['Architecture'] == 'amd64' and meta['Os'] == 'linux', 'image-identity')
            self.images[role] = meta
        for name in self.names.values():
            require(not self.command(['ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'], 'target-check').strip(), 'target-exists')

    def verify(self, obj, role, mounts):
        host, config = obj['HostConfig'], obj['Config']
        require(obj['Image'] == IMAGES[role][0] and config['Labels'].get('lzr.lab.owner') == self.owner, 'container-identity')
        require(host['NetworkMode'] == 'none' and host['ReadonlyRootfs'] and config['User'] == '1000:1000'
                and host['CapDrop'] == ['ALL'] and not host.get('CapAdd') and not host['Privileged']
                and 'no-new-privileges' in host['SecurityOpt'] and not host.get('Devices')
                and not host.get('PortBindings') and all(host.get(k) != 'host' for k in ['PidMode', 'IpcMode', 'UTSMode']), 'container-controls')
        require(config.get('Env') == self.images[role]['Config'].get('Env'), 'container-environment')
        require(len(obj['Mounts']) == len(mounts) and all(
            m['Type'] == 'bind' and m['Destination'] in mounts
            and (m['Source'], m['RW']) == mounts[m['Destination']] for m in obj['Mounts']), 'container-mounts')
        require(set(host.get('Tmpfs') or {}) == ({'/data'} if role == 'redis' else set()), 'container-tmpfs')
        require(not config.get('Volumes') if role == 'node' else set(config.get('Volumes') or {}) == {'/data'}, 'container-volumes')

    def create(self, role, mounts, command):
        args = ['create', '--name', self.names[role], '--pull=never', '--network', 'none', '--read-only',
                '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--label', 'lzr.lab.owner=' + self.owner]
        if role == 'redis':
            args += ['--tmpfs', '/data:rw,uid=1000,gid=1000,mode=0700', '--entrypoint', '/usr/local/bin/redis-server']
        else:
            args += ['--entrypoint', '/usr/bin/env', '--workdir', '/app']
        for destination, (source, writable) in mounts.items():
            args += ['--mount', 'type=bind,src=' + source + ',dst=' + destination + ('' if writable else ',readonly')]
        self.attempted.append(role)  # An uncertain create is inspected by ownership before cleanup.
        self.command([*args, IMAGES[role][0], *command], 'container-create')
        obj = self.inspect(self.names[role])
        self.verify(obj, role, mounts)
        require(obj['Config']['Cmd'] == command, 'container-arguments')
        return obj['Id']

    def run(self, staged, deps):
        self.socket.mkdir(mode=0o700)
        redis_mounts = {'/socket': (str(self.socket), True)}
        redis = self.create('redis', redis_mounts, ['--port', '0', '--unixsocket', '/socket/redis.sock',
                          '--unixsocketperm', '700', '--save', '', '--appendonly', 'no', '--dir', '/data'])
        self.command(['start', redis], 'redis-start')
        ready = False
        for _ in range(30):
            try:
                ready = self.command(['exec', redis, '/usr/local/bin/redis-cli', '-s', '/socket/redis.sock', 'PING'], 'redis-readiness', 2).strip() == 'PONG'
            except LabError:
                pass
            if ready:
                break
            time.sleep(0.1)
        require(ready, 'redis-readiness')
        current = self.inspect(redis)
        self.verify(current, 'redis', redis_mounts)
        require(current['State']['Running'], 'redis-not-running')
        node_mounts = {'/app': (str(staged), False), '/app/services/queue-runtime/node_modules': (str(deps), False),
                       '/socket': (str(self.socket), False)}
        node = self.create('node', node_mounts, ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=test', 'node',
                           '/app/tests/manual/collection-observe-consumer-local.mjs', '--local-synthetic-consumer-approved'])
        print(json.dumps({'event': 'collection.lab', 'phase': 'consumer-created'}), flush=True)
        text = self.command(['start', '-a', node], 'consumer-exit', 30)
        require(self.inspect(node)['State']['ExitCode'] == 0, 'consumer-exit')
        return safe_result(text)

    def cleanup(self):
        results = {}
        for role in reversed(self.attempted):
            record = {'absent': None, 'owned': None}
            try:
                ids = self.command(['ps', '-a', '--filter', 'name=^/' + self.names[role] + '$', '--format', '{{.ID}}'], 'cleanup-check', 6).strip()
                if not ids:
                    record['absent'] = True
                else:
                    obj = self.inspect(self.names[role])
                    owned = (obj.get('Config', {}).get('Labels') or {}).get('lzr.lab.owner') == self.owner and obj.get('Image') == IMAGES[role][0]
                    record['owned'] = owned
                    if owned:
                        self.command(['rm', '-f', obj['Id']], 'cleanup-remove', 6)
                        record['absent'] = not self.command(['ps', '-a', '--filter', 'id=' + obj['Id'], '--format', '{{.ID}}'], 'cleanup-check', 6).strip()
                    else:
                        record['foreignUntouched'] = True
            except (LabError, OSError, ValueError, KeyError, TypeError, AttributeError):
                record['outcome'] = 'uncertain'
            results[role] = record
        redis_absent = 'redis' not in self.attempted or results.get('redis', {}).get('absent') is True
        if redis_absent and self.socket.exists():
            try:
                shutil.rmtree(self.socket)
            except OSError:
                pass
        confirmed = all(v['absent'] is True for v in results.values()) and not self.socket.exists()
        return {'resources': results, 'socketRemoved': not self.socket.exists(), 'confirmed': confirmed}

def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument('--approve-local-synthetic', action='store_true')
    parser.add_argument('--output', required=True)
    parser.add_argument('--queue-dependencies')
    parser.add_argument('--run-id', default=None, help='Optional 32 hex characters; existing names are refused.')
    output, lab, reason, code = None, None, 'arguments', 78
    previous = {}
    try:
        args = parser.parse_args(argv)
        require(sys.flags.isolated == 1 and sys.flags.no_site == 1, 'isolated-python-required')
        require(args.approve_local_synthetic, 'approval-required')
        require(args.run_id is None or re.fullmatch('[a-f0-9]{32}', args.run_id), 'arguments')
        path = Path(args.output)
        require(path.is_absolute() and path.parent.is_dir() and not path.exists() and not path.is_symlink(), 'output-exists-or-invalid')
        candidate = path.resolve()
        candidate.mkdir(mode=0o700)
        output = candidate
        root = Path(__file__).resolve().parents[1]
        deps = Path(args.queue_dependencies).resolve() if args.queue_dependencies else root / 'services/queue-runtime/node_modules'
        dependencies(deps)
        staged = output / 'source'
        for name, expected in SOURCE_HASHES.items():
            source = root / name
            require(source.is_file() and not source.is_symlink(), 'source-identity')
            content = source.read_bytes()
            require(hashlib.sha256(content).hexdigest() == expected, 'source-identity')
            target = staged / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        (staged / 'services/queue-runtime/node_modules').mkdir()
        docker = shutil.which('docker', path='/usr/local/bin:/usr/bin:/bin')
        require(docker is not None, 'docker-unavailable')
        lab = Lab(output, args.run_id or uuid.uuid4().hex, docker)
        def cancelled(_number, _frame):
            raise LabError('cancelled')
        for name in [signal.SIGTERM, signal.SIGINT]:
            previous[name] = signal.signal(name, cancelled)
        lab.preflight()
        write_json(output / 'identity.json', {'sourceBase': '6653fa1a01e1af1d8d1585f39c89fbbcd94ed751',
                   'sourceHashes': SOURCE_HASHES, 'runId': lab.run_id, 'ownershipLabel': lab.owner, 'resources': lab.names, 'images': {k: v[0] for k, v in IMAGES.items()}})
        write_json(output / 'results.json', lab.run(staged, deps))
        reason, code = 'passed', 0
    except LabError as error:
        reason = str(error)
        code = 143 if reason == 'cancelled' else 78 if reason not in ['consumer-exit', 'consumer-result'] else 1
    except (OSError, ValueError, KeyError, TypeError):
        reason, code = 'local-operation-failed', 1
    finally:
        for name in previous:
            signal.signal(name, signal.SIG_IGN)
        cleanup = lab.cleanup() if lab else {'resources': {}, 'socketRemoved': True, 'confirmed': True}
        if not cleanup['confirmed'] and code == 0:
            reason, code = 'cleanup-unconfirmed', 73
        if output:
            write_json(output / 'cleanup.json', cleanup)
            write_json(output / 'status.json', {'reason': reason, 'exitCode': code, 'cleanupConfirmed': cleanup['confirmed']})
        for name, handler in previous.items():
            signal.signal(name, handler)
    print(json.dumps({'event': 'collection.lab', 'reason': reason, 'exitCode': code,
                      'cleanupConfirmed': cleanup['confirmed']}), flush=True)
    return code

if __name__ == '__main__':
    sys.exit(main())
