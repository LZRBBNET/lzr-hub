# Resposta a incidentes do relay IXC

## Regra principal

Falhe fechado. Em qualquer dúvida, configure `IXC_TRANSPORT=disabled` e `IXC_MODE=disabled`. Nunca use acesso direto ao IXC como contingência em produção e nunca habilite escrita.

## Relay indisponível

1. confirme health/ready local;
2. confira container, recurso e relógio;
3. confira Tunnel e Access;
4. mantenha o HUB em modo degradado;
5. se a recuperação não for imediata, aplique rollback para `disabled`.

## Timeout ou circuit breaker

1. correlacione pelo ID sanitizado;
2. confirme rota IPv4 e disponibilidade IXC;
3. não aumente retries do Worker;
4. preserve o limite máximo de duas tentativas no relay;
5. aguarde cooldown após corrigir a causa.

## Token IXC revogado

1. mantenha integração desabilitada;
2. gere token novo no IXC por canal seguro;
3. atualize somente `/etc/lzr/ixc-relay.env`;
4. reinicie o relay;
5. execute `testConnection`;
6. revogue definitivamente o anterior.

## Assinatura inválida ou replay

1. não registre assinatura, nonce bruto ou secret;
2. confirme relógio/NTP;
3. confira se Worker e relay usam a mesma versão canônica;
4. em volume anormal, desabilite o transporte e rotacione HMAC;
5. investigue possível repetição, cópia de requisição ou segredo exposto.

## Access bloqueando

1. confirme aplicação/hostname e policy `Service Auth`;
2. confirme Service Token exclusivo;
3. rotacione o token se houver suspeita;
4. não crie bypass público.

## IP removido da allowlist

1. repita as duas consultas IPv4 no servidor;
2. exija resultado exato `168.181.31.250`;
3. confirme rota/NAT;
4. restaure a allowlist somente após aprovação;
5. confirme origem nos logs IXC quando possível.

## Suspeita de vazamento

1. desabilite `IXC_TRANSPORT`;
2. revogue o segredo afetado;
3. se a abrangência for incerta, rotacione IXC, Access, HMAC e Tunnel separadamente;
4. verifique Git, imagens, logs e histórico do shell sem copiar segredos;
5. preserve evidências sanitizadas;
6. confirme que não houve escrita — o relay não possui operações de escrita.

## Excesso de requisições

1. confirme `relay_rate_limit` e contadores;
2. identifique correlation IDs e operação, sem PII;
3. bloqueie o chamador na Access se necessário;
4. mantenha circuit breaker e limites;
5. não desligue HMAC/allowlist para recuperar capacidade.

## Rotação emergencial

1. `IXC_TRANSPORT=disabled`;
2. revogue secret comprometido;
3. gere substituto independente;
4. atualize o componente correto;
5. teste em staging;
6. reative `relay`;
7. confirme zero fallback direto e zero escrita.

## Rollback completo

1. Worker em `disabled`;
2. pare `cloudflared`;
3. pare o relay;
4. remova o IP do IXC quando o serviço não for mais usado;
5. revogue tokens;
6. mantenha o produto em modo degradado até uma nova homologação.
