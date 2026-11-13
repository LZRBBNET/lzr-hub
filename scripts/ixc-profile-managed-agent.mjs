import {DiagnosticAgent} from './ixc-diagnostic-agent.mjs';
import {readFileSync,lstatSync} from 'node:fs';
import {rootCertificates} from 'node:tls';
import {X509Certificate} from 'node:crypto';
export function managedAgent() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const path = "/usr/local/share/ca-certificates/environment-proxy-ca.crt";
  const policy = JSON.parse(readFileSync("/etc/codex/network-policy.json", "utf8"));
  const proxy = new URL(policy.http_proxy);
  if (major !== 24 || minor < 5 || process.env.HTTPS_PROXY !== policy.http_proxy
    || proxy.protocol !== "http:" || proxy.username || proxy.password || proxy.search || proxy.hash
    || proxy.pathname !== "/" || policy.http_proxy === policy.tcp_connect_proxy
    || !policy.http_network_policy?.egress_rules?.some(rule => rule.host === "ixc.bbnetup.com.br")
    || process.env.CODEX_PROXY_CERT !== path) throw new Error("TRANSPORT_CONFIGURATION");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o022)) throw new Error("TRANSPORT_CONFIGURATION");
  const ca = readFileSync(path, "utf8");
  if (!new X509Certificate(ca).ca) throw new Error("TRANSPORT_CONFIGURATION");
  return new DiagnosticAgent({ proxyEnv: { HTTPS_PROXY: policy.http_proxy },
    ca: [...rootCertificates, ca], rejectUnauthorized: true, keepAlive: false, maxSockets: 1 });
}
