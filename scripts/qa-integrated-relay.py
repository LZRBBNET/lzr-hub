#!/usr/bin/env python3
"""Loopback-only fixed-destination relay; no proxy protocol or destination input."""
import ipaddress
import os
from pathlib import Path
import select
import signal
import socket
import sys
import tempfile
import threading

STOP = threading.Event()
NETWORKS = tuple(map(ipaddress.ip_network, ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')))


def private_target(value):
    address = ipaddress.ip_address(value)
    if address.version != 4 or not any(address in network for network in NETWORKS):
        raise ValueError('RFC1918 destination required')
    return str(address)


def forward(client, upstream):
    try:
        for connection in (client, upstream):
            connection.settimeout(10)
        while not STOP.is_set():
            readable, _, _ = select.select([client, upstream], [], [], 1)
            for source in readable:
                data = source.recv(65536)
                if not data:
                    return
                (upstream if source is client else client).sendall(data)
    except (OSError, ValueError):
        pass
    finally:
        client.close()
        upstream.close()


def main():
    if os.geteuid() == 0 or len(sys.argv) != 3:
        raise ValueError('Unprivileged user and fixed destination required')
    target = private_target(sys.argv[1])
    port_file = Path(sys.argv[2])
    parent = port_file.parent.resolve(strict=True)
    if parent.stat().st_uid != os.geteuid() or parent.stat().st_mode & 0o077:
        raise ValueError('Owned private directory required')
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    slots = threading.BoundedSemaphore(32)
    def accepted(client):
        try:
            upstream = socket.create_connection((target, 5432), timeout=5)
            forward(client, upstream)
        except OSError:
            client.close()
        finally:
            slots.release()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen(32)
        listener.settimeout(1)
        with tempfile.NamedTemporaryFile(mode='w', dir=parent, prefix='relay-ready-') as stream:
            stream.write(str(listener.getsockname()[1]))
            stream.flush()
            os.fsync(stream.fileno())
            os.link(stream.name, port_file)  # atomic publication, refuses an existing target
        while not STOP.is_set():
            try:
                client, _ = listener.accept()
            except socket.timeout:
                continue
            if not slots.acquire(blocking=False):
                client.close()
                continue
            threading.Thread(target=accepted, args=(client,), daemon=True).start()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('QA_LOCAL_RELAY_FAILED', file=sys.stderr)
        sys.exit(1)
