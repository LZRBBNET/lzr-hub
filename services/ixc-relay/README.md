# IXC fixed-egress relay

Serviço interno somente leitura entre o LZR HUB/Cloudflare Workers e o IXC. Ele não aceita URL, recurso, método, headers ou corpo IXC escolhidos pelo cliente. Cada operação é mapeada internamente para um único recurso e para o comando `listar`.

## Endpoints

- `GET /healthz`: processo vivo; não consulta IXC.
- `GET /readyz`: configuração local válida; não consulta IXC.
- `POST /v1/ixc/test-connection`: teste protegido.
- `POST /v1/ixc/read`: operação de leitura allowlisted.

O serviço deve escutar apenas em `127.0.0.1:8788`, atrás de Cloudflare Tunnel e Access. A autenticação exige os headers do Service Token e uma assinatura HMAC com timestamp, nonce e correlation ID.

## Desenvolvimento

Use somente valores sintéticos:

```bash
npm test
npm run typecheck
```

O token IXC real deve existir somente no arquivo de secrets do servidor, fora do repositório.
