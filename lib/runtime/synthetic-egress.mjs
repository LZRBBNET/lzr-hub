import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

// Process-local application guard, not a replacement for the hosting firewall.
// Install before importing the web server. Only its declared database may connect.
export function installSyntheticEgress(databaseUrl) {
  const target = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname || target.search || target.hash) throw Error('SYNTHETIC_EGRESS_CONFIGURATION');
  const host = target.hostname, port = Number(target.port || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('SYNTHETIC_EGRESS_CONFIGURATION');
  const saved = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get };
  const blocked = () => { throw Error('SYNTHETIC_EXTERNAL_TRANSPORT_BLOCKED'); };
  globalThis.fetch = async () => blocked();
  http.request = http.get = https.request = https.get = blocked;
  net.Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const first = normalized[0];
    const options = first && typeof first === 'object' ? first : { port: first, host: typeof normalized[1] === 'string' ? normalized[1] : 'localhost' };
    if (options.path || options.host !== host || Number(options.port) !== port) return blocked();
    return saved.connect.apply(this, args);
  };
  syncBuiltinESMExports();
  return () => {
    globalThis.fetch = saved.fetch; net.Socket.prototype.connect = saved.connect;
    http.request = saved.httpRequest; http.get = saved.httpGet;
    https.request = saved.httpsRequest; https.get = saved.httpsGet;
    syncBuiltinESMExports();
  };
}
