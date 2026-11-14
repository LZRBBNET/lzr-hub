#!/usr/bin/env python3
"""Create ephemeral server leaves with OpenSSL only; no trust changes or output."""
import datetime
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def create_leaf(directory: Path, cert_name: str, key_name: str, seconds: int) -> None:
    now = datetime.datetime.now(datetime.timezone.utc)
    start = (now - datetime.timedelta(seconds=5)).strftime('%Y%m%d%H%M%SZ')
    end = (now + datetime.timedelta(seconds=seconds)).strftime('%Y%m%d%H%M%SZ')
    key = directory / key_name
    cert = directory / cert_name
    with tempfile.TemporaryDirectory(prefix='certificate-', dir=directory) as tmp:
        temp = Path(tmp)
        (temp / 'index').touch(mode=0o600)
        (temp / 'serial').write_text('01\n')
        (temp / 'openssl.cnf').write_text('''[ca]
default_ca=local
[local]
database=index
serial=serial
new_certs_dir=.
default_md=sha256
policy=subject
x509_extensions=server
unique_subject=no
[subject]
commonName=supplied
[server]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1
''')
        common = dict(cwd=temp, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL, check=True, timeout=15)
        subprocess.run(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(key), '-out', 'request.pem', '-subj', '/CN=127.0.0.1'], **common)
        subprocess.run(['openssl', 'ca', '-selfsign', '-batch', '-notext',
                        '-config', 'openssl.cnf', '-keyfile', str(key), '-in', 'request.pem',
                        '-out', str(cert), '-startdate', start, '-enddate', end], **common)
        os.chmod(key, 0o600)
        os.chmod(cert, 0o600)


def main() -> None:
    if os.geteuid() == 0:
        raise RuntimeError('Disposable unprivileged user required')
    if len(sys.argv) != 2:
        raise RuntimeError('Exactly one private destination required')
    directory = Path(sys.argv[1]).resolve(strict=True)
    stat = directory.stat()
    if stat.st_uid != os.geteuid() or stat.st_mode & 0o077:
        raise RuntimeError('Private owned directory required')
    os.umask(0o077)
    # Only cert.pem is eligible for P,, trust. The other is a negative fixture.
    create_leaf(directory, 'cert.pem', 'key.pem', 480)
    create_leaf(directory, 'other-cert.pem', 'other-key.pem', 480)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('QA_CERTIFICATE_PREPARATION_FAILED', file=sys.stderr)
        sys.exit(1)
