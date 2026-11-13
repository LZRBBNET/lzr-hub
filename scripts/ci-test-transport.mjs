// Test-process guard against accidental external transport, not a security
// sandbox for hostile code. Child launcher tests install their own egress guard.
import net from 'node:net';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = first && typeof first === 'object' ? first : {
    port: first, host: typeof normalized[1] === 'string' ? normalized[1] : 'localhost',
  };
  if (options.path || !['127.0.0.1', '::1'].includes(options.host)) {
    throw new Error('CI_EXTERNAL_TRANSPORT_BLOCKED');
  }
  return connect.apply(this, args);
};
dgram.createSocket = () => { throw new Error('CI_EXTERNAL_TRANSPORT_BLOCKED'); };
syncBuiltinESMExports();
