import '../scripts/ci-test-transport.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { once } from 'node:events';

test('CI refuses external sockets, HTTP, HTTPS, fetch, UDP and Unix sockets', async () => {
  for (const connect of [
    () => net.connect({ host: 'example.invalid', port: 443 }),
    () => net.connect({ host: '192.0.2.1', port: 5432 }),
    () => net.connect({ path: '/tmp/ci-forbidden.sock' }),
    () => http.get('http://example.invalid'),
    () => https.get('https://example.invalid'),
    () => dgram.createSocket('udp4'),
  ]) assert.throws(connect, /CI_EXTERNAL_TRANSPORT_BLOCKED/);
  await assert.rejects(fetch('https://example.invalid'), error =>
    error.cause?.message === 'CI_EXTERNAL_TRANSPORT_BLOCKED');
});

test('CI permits a disposable loopback HTTP fixture', async () => {
  const server = http.createServer((_request, response) => response.end('synthetic'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await response.text(), 'synthetic');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
