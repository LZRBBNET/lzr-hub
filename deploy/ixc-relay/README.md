# Deployment do relay IXC

Este diretório contém somente arquivos sem secrets. O arquivo real `/etc/lzr/ixc-relay.env`, o token do Tunnel e as credenciais do Cloudflare Access devem ser criados no servidor com permissão `0600`.

O Compose publica o relay apenas em `127.0.0.1:8788`. A rede Docker precisa de saída para o host do IXC; por isso ela não usa `internal: true`. A entrada externa continua bloqueada pelo bind de loopback e pelo firewall. O `cloudflared` executa no host e alcança apenas esse loopback.

Antes de iniciar, siga integralmente `docs/runbooks/ixc-relay-deployment.md`, inclusive a comprovação de que o IPv4 de saída é exatamente `168.181.31.250`.
