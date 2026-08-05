/**
 * Ponte para conseguir exercitar a aplicação **em modo produção** na máquina.
 *
 * Por que existe: `npm run dev` sobe o Vite sobre o runtime do Cloudflare
 * Workers, onde o driver `pg` trava e toda tela de banco morre. `npm start` roda
 * Node de verdade e as rotas de banco funcionam — mas o `vinext start` local
 * devolve 404 para tudo em `/assets/*`, então a página chega sem CSS nem JS.
 *
 * Esta ponte serve os arquivos de `dist/client` e repassa o resto para o
 * `vinext start`. Com ela dá para abrir qualquer tela, com dado real, no mesmo
 * runtime que o Railway usa.
 *
 *   npm run build
 *   npm start                          # em um terminal (porta 3000)
 *   node scripts/dev-static-bridge.mjs # em outro (porta 3100)
 *
 * É ferramenta de desenvolvimento. Não entra em nenhum caminho de produção —
 * no Railway o próprio `vinext start` serve os estáticos corretamente.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const ORIGIN = process.env.BRIDGE_ORIGIN ?? "http://localhost:3000";
const PORT = Number(process.env.BRIDGE_PORT ?? 3100);
const ROOT = resolve("dist/client");

const TYPES = {
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon", ".map": "application/json",
};

if (!existsSync(ROOT)) {
  console.error(`Não encontrei ${ROOT}. Rode "npm run build" antes.`);
  process.exit(1);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  // `normalize` + prefixo obrigatório impedem sair de dist/client com "../".
  const candidate = join(ROOT, normalize(decodeURIComponent(url.pathname)));

  if (candidate.startsWith(ROOT) && existsSync(candidate) && statSync(candidate).isFile()) {
    response.writeHead(200, {
      "content-type": TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(candidate).pipe(response);
    return;
  }

  try {
    // Sem tirar `accept-encoding` o upstream responde comprimido, a ponte
    // repassa os bytes e o navegador recebe binário sem saber descomprimir.
    const forwarded = { ...request.headers, host: new URL(ORIGIN).host };
    delete forwarded["accept-encoding"];
    const upstream = await fetch(`${ORIGIN}${request.url}`, {
      method: request.method,
      headers: forwarded,
      body: ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : request,
      duplex: "half",
      redirect: "manual",
    });
    const headers = Object.fromEntries(upstream.headers.entries());
    delete headers["content-encoding"];
    delete headers["content-length"];
    response.writeHead(upstream.status, headers);
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Ponte não alcançou ${ORIGIN}: ${error.message}\nO "npm start" está rodando?`);
  }
});

server.listen(PORT, () => {
  console.log(`Ponte em http://localhost:${PORT}`);
  console.log(`  estáticos de ${ROOT}`);
  console.log(`  resto para   ${ORIGIN}`);
});
