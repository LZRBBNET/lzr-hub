# Runbook de implantação do relay IXC

## Estado desta entrega

- Código e testes: prontos para revisão.
- Acesso ao servidor `168.181.31.250`: **BLOQUEADO POR INFRAESTRUTURA**.
- Egress IPv4 confirmado: **BLOQUEADO POR INFRAESTRUTURA**.
- IP liberado no IXC: **BLOQUEADO POR INFRAESTRUTURA**.
- Tunnel/Access implantados: **BLOQUEADO POR INFRAESTRUTURA**.
- Smoke real: **BLOQUEADO POR INFRAESTRUTURA**.

Não avance para produção enquanto esses cinco itens não estiverem comprovados.

## Pré-requisitos

- servidor Linux exclusivo/controlado pela BBNET;
- rota estável com egress público planejado em `168.181.31.250`;
- Docker Engine e Compose Plugin suportados;
- usuário administrativo via VPN/rede de gestão;
- DNS gerenciado na Cloudflare;
- permissão para criar Tunnel, Access Application, Service Token e policy;
- usuário IXC dedicado somente leitura;
- janela de mudança e rollback;
- relógio sincronizado por NTP.

Não instale no servidor do próprio IXC. Não envie SSH, token ou senha pelo chat/GitHub.

## 1. Validar servidor, conflito e egress

Execute no próprio servidor, antes de instalar:

```bash
ip -4 addr show
ip -4 route show
ss -lntup
systemctl --failed
docker version
docker compose version
timedatectl status
curl -4 --fail --silent --show-error https://api.ipify.org
curl -4 --fail --silent --show-error https://ifconfig.co/ip
```

Os dois últimos resultados devem ser exatamente:

```text
168.181.31.250
```

Falhe a mudança se:

- o IP observado for diferente;
- as duas fontes divergirem;
- o IP alternar entre execuções;
- houver CGNAT/NAT intermediário não documentado;
- a rota de retorno for assimétrica;
- a porta `8788` ou o hostname planejado conflitarem;
- o host já executar serviço crítico incompatível.

Registre somente:

```text
data=<ISO-8601>
ambiente=production-relay
ip_observado=168.181.31.250
resultado=APROVADO|REPROVADO
```

Nunca registre credenciais.

## 2. Confirmar acesso ao IXC

Do servidor:

```bash
curl -4 --fail --silent --show-error --head https://<HOST_IXC>/
```

Esse teste só confirma rota/TLS, sem token. O endpoint e certificado devem corresponder ao IXC autorizado. Não desabilite verificação TLS.

## 3. Preparar arquivos e secrets

Instale o repositório em `/opt/lzr-hub`. Crie:

```text
/etc/lzr/ixc-relay.env
/etc/lzr/secrets/cloudflared-token
```

O env deve ser de `root`, modo `0600`. O token do Tunnel deve pertencer ao usuário `cloudflared`, modo `0600`. Baseie o env em `services/ixc-relay/.env.example`, preenchendo os valores pelo cofre/console seguro. Confirme:

```text
RELAY_HOST=127.0.0.1
IXC_WRITE_ENABLED=false
FEATURE_IXC_WRITE=false
```

O token IXC fica apenas no relay. Use HMAC aleatório com pelo menos 32 bytes. Não reutilize o token IXC, Access secret ou Tunnel token como HMAC.

## 4. Firewall e host

- permita SSH somente pela VPN/rede administrativa;
- negue entrada pública TCP/8788;
- remova serviços desnecessários;
- permita saída DNS/NTP/HTTPS;
- quando operacionalmente viável, restrinja HTTPS de saída ao IXC e Cloudflare;
- não monte `/var/run/docker.sock` no container.

Valide externamente que `168.181.31.250:8788` não responde.

## 5. Implantar relay

```bash
cd /opt/lzr-hub/deploy/ixc-relay
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8788/healthz
curl --fail http://127.0.0.1:8788/readyz
```

Health e ready não consultam o IXC e devem retornar apenas `{"status":"ok"}`.

Opcionalmente instale a unidade:

```bash
install -m 0644 systemd/lzr-ixc-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lzr-ixc-relay.service
```

## 6. Criar Cloudflare Tunnel

No Zero Trust:

1. crie um Tunnel exclusivo;
2. instale `cloudflared` no host;
3. guarde o token em `/etc/lzr/secrets/cloudflared-token`;
4. configure o hostname `ixc-relay.<domínio>` apontando para `http://127.0.0.1:8788`;
5. mantenha o catch-all 404;
6. habilite a unidade `cloudflared.service`.

O arquivo `cloudflared-config.example.yml` contém somente placeholders.

## 7. Criar Access Service Auth

1. crie aplicação Access self-hosted para o hostname exato;
2. crie Service Token exclusivo do LZR HUB;
3. crie policy `Service Auth` permitindo apenas esse token;
4. negue o restante;
5. guarde Client ID e Client Secret como secrets do Worker.

Ausência do Access ou do HMAC deve produzir bloqueio.

## 8. Configurar secrets do Worker

No gerenciador oficial do Worker/Sites, sem editar `wrangler.jsonc`:

```text
IXC_MODE=production-readonly
IXC_TRANSPORT=relay
IXC_RELAY_URL=https://ixc-relay.<domínio>
IXC_RELAY_HMAC_SECRET=<secret>
CF_ACCESS_CLIENT_ID=<secret>
CF_ACCESS_CLIENT_SECRET=<secret>
IXC_ALLOWED_CUSTOMER_IDS=<ids autorizados>
IXC_WRITE_ENABLED=false
FEATURE_IXC_WRITE=false
```

Remova `IXC_API_TOKEN` do Worker. Não use `NEXT_PUBLIC_`.

## 9. Liberar IP no IXC

Somente após o egress aprovado:

1. adicione `168.181.31.250` às redes permitidas do grupo `webservice`;
2. confirme usuário ativo, API habilitada e permissão apenas de leitura;
3. não libere faixas amplas;
4. registre quem aprovou e quando, sem token.

## 10. Smoke test protegido

Nesta ordem:

1. `testConnection` pelo Worker staging → Access → Tunnel → relay → IXC;
2. `getCustomer` para um único cliente da allowlist;
3. cliente fora da allowlist deve retornar bloqueio antes do IXC;
4. timeout controlado;
5. token inválido somente em ambiente controlado;
6. IP não liberado apenas em ambiente separado/simulado;
7. correlation ID idêntico em Worker, relay e IXC quando disponível;
8. confirmar nos logs do IXC origem `168.181.31.250`.

Não grave resposta real, PII ou token em evidência. Não teste escrita.

## 11. Validação final

```bash
npm run install:ci
npm run lint
npm run typecheck
npm test
npm run build
npm run validate:artifact
npm run test:relay
npm run typecheck:relay
```

Também verifique `docker inspect` para usuário não root, read-only, capabilities vazias e bind loopback.

## Rollback

1. defina `IXC_TRANSPORT=disabled` e `IXC_MODE=disabled` no Worker;
2. confirme modo degradado e ausência de chamada direta;
3. pare Tunnel e relay;
4. remova `168.181.31.250` da allowlist IXC;
5. revogue Service Token;
6. revogue/rotacione HMAC, Tunnel token e token IXC conforme o incidente;
7. preserve apenas logs sanitizados.

Nunca use `IXC_TRANSPORT=direct` como rollback de produção.

## Rotação

- IXC token: rotacione só no relay.
- Access Service Token: crie novo, atualize Worker, valide e revogue antigo.
- HMAC: janela coordenada; suporte a duas chaves deverá ser implementado antes de rotação sem interrupção.
- Tunnel token: rotacione no host e reinicie `cloudflared`.

## Solução de problemas

| Sintoma | Ação |
| --- | --- |
| `RELAY_UNAUTHORIZED` | revisar policy Access e headers do Service Token |
| `RELAY_SIGNATURE_INVALID` | revisar HMAC, corpo, path e versão |
| `RELAY_TIMESTAMP_INVALID` | corrigir NTP |
| `RELAY_REPLAY_DETECTED` | investigar duplicação/reuso de nonce |
| `IXC_IP_NOT_ALLOWED` | repetir egress IPv4 e revisar allowlist |
| `IXC_AUTHENTICATION_FAILED` | rotacionar/verificar token somente no relay |
| `IXC_TIMEOUT` | revisar rota, IXC e limites; não aumentar retries em cascata |
| `RELAY_CIRCUIT_OPEN` | tratar causa upstream e aguardar cooldown |
