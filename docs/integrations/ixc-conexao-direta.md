# Conexão direta com o IXC (aposentando a ponte)

## Por que mudar

A ponte na VM (`ixc-bridge.bbnetup.com.br`) foi construída para resolver um problema que **não existe mais**: o Cloudflare Workers, onde a aplicação rodava antes, não tem IP de saída fixo, e o IXC exige IP liberado.

Hoje a aplicação roda no **Railway**, que oferece IPs de saída fixos. E o **SeeNet — outro sistema da BBNET, no mesmo Railway e no mesmo IXC — já funciona assim, sem ponte nenhuma.** Está registrado na coleção do Postman dele:

> "O Railway já tem IP liberado no IXC, então testamos pelo SeeNet como proxy."

Adotar o mesmo desenho elimina de uma vez:

- O firewall da ponte bloqueando o Railway (hoje ele libera só faixas da Cloudflare)
- O `BRIDGE_SHARED_SECRET`, que deixa de existir
- A VM, o Caddy, o certificado Let's Encrypt e o serviço systemd — manutenção que ninguém precisa fazer

## O detalhe técnico que a ponte escondia

O IXC exige **GET com corpo JSON** nas listagens. É um padrão incomum, e a API `fetch` do Node **proíbe** corpo em GET (`Request with GET/HEAD method cannot have body`).

Enquanto falávamos com a ponte isso não aparecia: ela recebia POST e convertia para GET antes de repassar ao IXC. Falando direto, o problema volta para a aplicação.

Resolvido em [`lib/integrations/ixc/http.ts`](../../lib/integrations/ixc/http.ts): um transporte baseado no módulo `https` nativo, compatível com a interface do `fetch` (então o provider continua recebendo um `fetcher` injetável e os testes seguem com dublês).

Controlado por `IXC_HTTP_METHOD`:

| Valor | Quando usar |
|---|---|
| `GET` (padrão) | Falando **direto** com o IXC |
| `POST` | Falando com a **ponte** antiga, que fazia a conversão |

## Passo a passo da migração

**1. Descobrir o que o SeeNet usa.** No projeto do SeeNet no Railway → serviço → **Settings → Networking** → verificar se "Static IPs" está ligado e quais são os três IPs.

**2. Ligar Static Outbound IPs** no serviço `lzr-hub`, na mesma tela. O Railway atribui três IPs e faz balanceamento entre eles. Requer plano Pro.

**3. Liberar os três IPs no IXC**, no mesmo lugar onde o IP da ponte já está liberado (Redes Permitidas do usuário de webservice).

**4. Trocar as variáveis no Railway:**

```
IXC_BASE_URL=https://ixc.bbnetup.com.br
IXC_API_TOKEN=<token real do IXC, formato id:hash>
IXC_HTTP_METHOD=GET
IXC_MODE=staging-readonly
```

⚠️ O `IXC_API_TOKEN` volta a ser o **token real do IXC**, não mais o segredo da ponte em base64. O código detecta o formato `id:hash` e faz o base64 sozinho (`basicCredential`).

**5. Validar** antes de desligar qualquer coisa:

```
GET /api/health
POST /api/integrations/ixc/smoke   (exige STAGING_JOB_SECRET)
```

**6. Só então** desligar a VM da ponte. Enquanto ela estiver de pé, dá para voltar atrás trocando `IXC_BASE_URL` e `IXC_HTTP_METHOD=POST`.

## Ressalva sobre os IPs do Railway

Os IPs de saída fixos do Railway são **compartilhados com outros clientes**, não dedicados. Liberá-los no IXC significa que, em teoria, outro cliente do Railway estaria dentro da faixa permitida — embora ainda precisasse do token do IXC para qualquer coisa.

É o mesmo nível de exposição que o SeeNet já aceita hoje. Se um dia isso incomodar, o caminho é um proxy com IP dedicado (QuotaGuard, Fixie) ou voltar a um relay próprio.
