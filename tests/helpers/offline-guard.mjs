// Explicit preload for synthetic validation only. Never imported by the app.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

let attempts = 0;
const deny = operation => function () {
  attempts++;
  throw new Error(`OFFLINE_VALIDATION_FORBIDS_${operation}`);
};
net.Socket.prototype.connect = deny('SOCKET_CONNECT');
net.Server.prototype.listen = deny('SERVER_LISTEN');
net.connect = deny('NET_CONNECT');
net.createConnection = deny('NET_CREATE_CONNECTION');
tls.connect = deny('TLS_CONNECT');
http.request = deny('HTTP_REQUEST');
http.get = deny('HTTP_GET');
https.request = deny('HTTPS_REQUEST');
https.get = deny('HTTPS_GET');
globalThis.fetch = deny('FETCH');
syncBuiltinESMExports();
process.on('exit', () => {
  if (attempts) {
    console.error(`OFFLINE_VALIDATION_BLOCKED_ATTEMPTS=${attempts}`);
    process.exitCode = 1;
  }
});
