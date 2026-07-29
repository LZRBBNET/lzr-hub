# Conexão com o IXC: por que a ponte existe e continua necessária

## A regra que define tudo

**O IXC bloqueia por IP.** A restrição é configurada por usuário de webservice ("Redes Permitidas"), e é aplicada de verdade — o IXC responde `"Seu IP não está liberado para efetuar login!"` para qualquer origem não autorizada.

Como a aplicação roda em nuvem sem IP de saída fixo, é obrigatório passar por algum ponto com IP fixo já liberado. É isso que a ponte faz.

## O que já foi investigado (para não repetir)

### Static Outbound IPs do Railway — não é o caminho

O recurso existe, mas exige o **plano Pro** (US$ 20/mês; o Hobby, de US$ 5, não tem). Chegamos a considerar comprar para eliminar a ponte.

**Não vale**: verificamos que o **SeeNet — outro sistema da BBNET, no mesmo Railway, com conta paga — não usa Static IPs.** Ele resolve o mesmo problema com uma ponte própria:

```
Railway → Cloudflare Tunnel → VM srv-bd-int-01 (Nginx) → IXC
```

Ou seja, comprar o Pro não removeria a necessidade de uma ponte; só trocaria uma solução que já funciona por outra paga. O histórico do SeeNet inclusive registra o IP do Railway mudando (`34.186.67.180` → `162.220.234.12`) e quebrando a sincronização — a prova de que sem IP fixo não há como manter allowlist.

### A pista enganosa da coleção do Postman

A coleção do SeeNet tem a frase *"O Railway já tem IP liberado no IXC"*. Ela sugere que não haveria bloqueio — mas é imprecisa: o que está liberado é o IP da **VM** do SeeNet, alcançada via Cloudflare Tunnel, não o do Railway. Não tire conclusões dela.

## A ponte do LZR HUB

```
Railway → https://ixc-bridge.bbnetup.com.br (Caddy + Let's Encrypt)
        → relay Node (localhost:3000) → https://ixc.bbnetup.com.br
```

VM `srv-ixc` (`168.181.28.74`, SSH na porta 27977), com IP de saída dedicado `168.181.31.250` já liberado no IXC. Serviço `lzr-hub-ixc-bridge` gerenciado por systemd.

Comparada à do SeeNet, tem duas vantagens: **URL fixa** (`ixc-bridge.bbnetup.com.br`, contra um `trycloudflare.com` que muda a cada reinício e obriga a atualizar o banco) e **certificado próprio**.

### O firewall — armadilha que já custou tempo

O `ufw` da VM foi configurado quando a aplicação rodava em **Cloudflare Workers**: a porta 443 só aceitava faixas de IP da Cloudflare. Ao migrar para o Railway, a ponte passou a bloquear a própria aplicação, com sintoma de **timeout genérico** — difícil de diagnosticar sem esse contexto.

Corrigido em 2026-07-29 com `sudo ufw allow 443/tcp`. As regras antigas específicas da Cloudflare continuam listadas, redundantes e inofensivas.

⚠️ **Consequência**: a porta 443 está aberta para qualquer origem. A única proteção da ponte passou a ser o `BRIDGE_SHARED_SECRET`. Esse segredo foi exposto em uma conversa de trabalho e a rotação foi deliberadamente dispensada pela equipe. Se um dia isso for revisto, rotacionar é trocar uma linha no `.env` da VM, reiniciar o serviço e atualizar `IXC_API_TOKEN` no Railway.

## Configuração

| Variável | Valor com a ponte | Valor em conexão direta |
|---|---|---|
| `IXC_BASE_URL` | `https://ixc-bridge.bbnetup.com.br` | `https://ixc.bbnetup.com.br` |
| `IXC_API_TOKEN` | base64 do `BRIDGE_SHARED_SECRET` | token real do IXC (`id:hash`) |
| `IXC_HTTP_METHOD` | `POST` | `GET` |

### Por que `IXC_HTTP_METHOD` existe

O IXC exige **GET com corpo JSON** nas listagens — padrão incomum que a API `fetch` do Node proíbe (`Request with GET/HEAD method cannot have body`).

A ponte esconde isso: recebe POST e converte para GET antes de repassar. Numa conexão direta o problema volta para a aplicação, e é resolvido em [`lib/integrations/ixc/http.ts`](../../lib/integrations/ixc/http.ts), com um transporte sobre o módulo `https` nativo compatível com a interface do `fetch` (o provider continua recebendo um `fetcher` injetável, e os testes seguem usando dublês).

**A conexão direta não está em uso.** O suporte existe caso um dia o IP do Railway seja liberado no IXC — e a troca é só de variáveis, sem deploy.

## Validado em 2026-07-29

Chamada real de fora da VM, através da ponte, retornando cadastro do IXC: **HTTP 200, 165 campos**. O caminho `aplicação → ponte → IXC` está funcional.

Falta apenas ligar a integração em produção, que hoje está com `IXC_MODE=disabled` no Railway.
