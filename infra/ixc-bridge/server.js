import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const PORT = process.env.PORT || 3000;
// URL raiz do IXC, SEM o /webservice/v1 no final. Ex.: https://ixc.bbnetup.com.br
const IXC_UPSTREAM_BASE_URL = process.env.IXC_UPSTREAM_BASE_URL;
// Token real do IXC, formato "id:hash"
const IXC_API_TOKEN = process.env.IXC_API_TOKEN;
// Senha inventada por vocês, combinada só entre o Worker do LZR HUB e esta ponte
const BRIDGE_SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET;
// IP fixo desta VM (bloco 168.181.31.248/30), usado como origem de toda chamada de saída
const EGRESS_LOCAL_ADDRESS = process.env.EGRESS_LOCAL_ADDRESS;

for (const [key, value] of Object.entries({ IXC_UPSTREAM_BASE_URL, IXC_API_TOKEN, BRIDGE_SHARED_SECRET })) {
  if (!value) throw new Error(`Falta a variável de ambiente ${key}`);
}

const IXC_AUTH_HEADER = "Basic " + Buffer.from(IXC_API_TOKEN).toString("base64");
const expectedAuth = `Basic ${Buffer.from(BRIDGE_SHARED_SECRET).toString("base64")}`;

function upstreamRequest(targetUrl, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers,
        localAddress: EGRESS_LOCAL_ADDRESS || undefined,
        family: EGRESS_LOCAL_ADDRESS ? 4 : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Rota de apoio: mostra o IP de saída atual desta ponte.
  if (req.url === "/debug/my-ip") {
    const upstream = await upstreamRequest("https://api.ipify.org?format=json", { method: "GET" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(upstream.body);
    return;
  }

  if (req.headers.authorization !== expectedAuth) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  let rawBody = "";
  for await (const chunk of req) rawBody += chunk;

  try {
    // O IXC exige GET com corpo para listagens (fora do padrão HTTP comum). Listagem é o que
    // chega com `ixcsoft: listar` (o LZR sempre manda nas consultas) ou já como GET.
    // O resto — abrir OS, cadastrar cliente, renegociar, segunda via, PIX — segue com o método
    // que chegou e SEM o cabeçalho de listagem. Até 18/11/2026 tudo virava listagem: nenhuma
    // escrita criava nada no IXC, e a abertura de OS devolvia uma lista de OS de outros clientes.
    const listing = String(req.headers.ixcsoft ?? "").toLowerCase() === "listar" || req.method === "GET";
    const upstream = await upstreamRequest(IXC_UPSTREAM_BASE_URL.replace(/\/$/, "") + req.url, {
      method: listing ? "GET" : req.method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(listing ? { ixcsoft: "listar" } : {}),
        authorization: IXC_AUTH_HEADER,
        "content-length": Buffer.byteLength(rawBody),
      },
      body: rawBody || undefined,
    });

    res.writeHead(upstream.statusCode, {
      "content-type": upstream.headers["content-type"] || "application/json",
    });
    res.end(upstream.body);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bridge_upstream_failed", detail: String(err) }));
  }
});

server.listen(PORT, () => console.log(`Ponte IXC ouvindo na porta ${PORT}`));
