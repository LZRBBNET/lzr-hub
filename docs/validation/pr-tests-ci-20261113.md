# CI de PR: candidata local, não publicada

Base verificada via fetch: `review/first-access-ro-composed-20261113`,
`ac4c4b09ae6fda175b0c77ed54100eb92c472e6b`.
Branch local: `ci/safe-pr-tests-20261113`. Não usar `main` como base equivalente.
O checkout inicial era `work` em `f1da47e95830d6a03c72d6faf9edda422c7e4a09`.
Não há `AGENTS.md` nem `.agents/skills` nesta árvore; `/workspace/.agents`
está vazio. Foram lidos README, scripts de instalação/build/staging e os
relatórios de validação da composição e da candidata sintética.

## Escopo e limites

- Somente `pull_request`; sem push, cron, dispatch ou `pull_request_target`.
- `contents: read`, checkout sem credencial persistida, ações fixadas por SHA
  completo e tags verificadas com `git ls-remote` nos repositórios oficiais:
  checkout v4.2.2 e setup-node v4.4.0.
- Um job `ubuntu-24.04`, Node 24.22.1 (mesmo runtime validado no Cloud), máximo
  de 25 minutos, limites por etapa e cancelamento da execução anterior do PR.
- Sem secrets, environments, services, cache de Actions, upload de artefatos,
  deploy, migração, seed, npm start, IXC ou disparo operacional.
- Instalação usa `install:ci` existente, lockfile íntegro e scripts npm
  desabilitados. Não altera package.json, lockfile ou versões de dependências.
  Rede na instalação é necessária para pacotes públicos; TLS permanece validado.
  `NODE_USE_SYSTEM_CA=1` permite as CAs já instaladas pelo ambiente.
- Checks descartam variáveis herdadas, inclusive credenciais/URLs/NODE_OPTIONS,
  e recusam dotenv local, inclusive symlinks. Instalação preserva apenas proxies
  HTTP(S) padrão do ambiente, além de PATH e flags técnicas enumeradas.
- Guarda de teste bloqueia TCP externo, sockets Unix e UDP; permite loopback
  literal para fixtures descartáveis. Testes validam HTTP/HTTPS/fetch bloqueados
  e HTTP loopback funcional. É prevenção de transporte acidental em Node, não
  sandbox de código hostil nem mudança na segurança de rede da infraestrutura.
  Os dois testes que iniciam subprocessos usam ambiente fictício explícito e a
  guarda de egress já existente nos launchers. Nenhum banco é provisionado.
- `contract-audit.yml` não foi alterado nem executado. Produção, hosting e
  configurações externas não foram acessados ou modificados por este trabalho.

## Validação no Cloud selecionado

Comandos executados na branch acima; logs preservados em `/tmp/lzr-ci-*.log`
no ambiente local, sem upload. Nenhum resultado abaixo é aprovação de CI remoto.

| Comando/check | Exit | Resultado |
| --- | --- | --- |
| `bash scripts/ci-check.sh install` | 0 | 534 pacotes do lock; lifecycle desabilitado |
| `bash scripts/ci-check.sh types` | 0 | `npm run typecheck` |
| `bash scripts/ci-check.sh lint` | 0 | `npm run lint` |
| `bash scripts/ci-check.sh tests` | 0 | Build Worker + validação ESM/manifest; 1259/1259 testes, zero skip/fail |
| `bash scripts/ci-check.sh synthetic` | 0 | Build Node isolado + 4/4 testes de artefato, zero skip/fail |
| `bash -n scripts/ci-check.sh` | 0 | Sintaxe shell |
| `node --check scripts/ci-test-transport.mjs` | 0 | Sintaxe do preload |
| PyYAML BaseLoader + assertions | 0 | YAML, evento, permissões, SHAs, runner, limites, ausência de secrets/cache/uploads |
| `git diff --check` | 0 | Sem whitespace inválido |
| Diff da base de package.json, package-lock.json, contract-audit.yml | 0 | Inalterados |

Os 1259 testes incluem os 1257 anteriores e dois novos testes da guarda.
Os quatro arquivos pós-build são explícitos, pois não pertencem ao glob
`tests/*.test.mjs`. O agregado levou cerca de 30 s, e os testes de artefato
cerca de 1 s, além dos builds. Há avisos existentes de bundler/chunks e de
depreciação de react-test-renderer; não foram ocultados.

Tentativas anteriores preservadas: instalação sem proxy terminou 6 por DNS;
com proxy, terminou 1 (npm `Exit handler never called`, download de renderer
com `SELF_SIGNED_CERT_IN_CHAIN`). A instalação final passou usando CAs do
sistema, sem desabilitar TLS. `unshare --user --map-root-user --net true`
e `bwrap --unshare-net --ro-bind / / true` terminaram 1: uid map somente leitura.
Não houve escalada nem alteração de namespace/firewall; a guarda de processo
foi validada como alternativa de escopo limitado. `actionlint` não está
instalado; parsing/assertions locais não substituem a validação do GitHub.

Os testes manuais de PostgreSQL/browser e o serviço queue-runtime com Redis
não fazem parte deste CI: exigem transporte/serviços fora deste escopo.
Não houve validação visual, banco remoto, reconciliação sintética nova,
cobrança, WhatsApp, OS real ou execução de workflow operacional.

## Publicação e consumo

Nenhum push, PR, workflow remoto ou recurso pago foi criado. A coordenação
confirmou a visibilidade pública do repositório. Runners GitHub-hosted padrão
em repositórios públicos são gratuitos conforme
[billing do Actions](https://docs.github.com/en/actions/concepts/billing-and-usage).
Não há runners maiores nem armazenamento adicional via Actions artifacts/cache.
Cada PR poderá consumir até 25 runner-minutos por execução; cancelamento reduz
trabalho obsoleto, mas não é quota global. Mudança futura de visibilidade ou
runner exige rever consumo. Build/instalação ainda dependem da disponibilidade
do registry e do runner; o resultado remoto continua não verificado.

O arquivo está pronto para revisão local. Publicar/abrir PR pode ativar o
workflow: aguardar autorização explícita para essa etapa conforme o pedido,
mesmo com o repositório público. Não requer confirmação adicional para manter
o patch local. Nenhum bloqueio de validação local permanece, além da ausência
de actionlint e do isolamento por namespace descritos acima.
