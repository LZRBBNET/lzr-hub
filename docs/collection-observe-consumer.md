# Consumidor isolado de homologação de cobrança

Este recorte **não altera `src/worker.mjs`**, flags, bootstrap ou configuração de
produção. As fábricas puras portadas não são carregadas automaticamente. Não
execute `npm run worker` para este ensaio.

A base é `33cdcfbb522f9321bcb4e18ba8d2ae1fab1c122c`, verificada publicamente.
`billing-reminders.mjs` e `promise-hold.mjs` são cópias da candidata local
`a24de88b559c79b77841cd627c8b8351345b0b25`; `processor.mjs` e
`failed-job-handler.mjs` vêm da implementação histórica
`fd2dee706ad1e134831db19e795a888b76df34c2`. Não foram portados outros recursos
nem refeitas as correções de datas civis do PR 69.

## Execução somente no laboratório

`tests/manual/collection-observe-consumer-local.mjs` usa o `Worker` e as filas
reais de BullMQ 5.81.2, já declarado no subpacote. Exige argumento
`--local-synthetic-consumer-approved`, `NODE_ENV=test`, ambiente enumerado sem
credenciais e socket fixo `/socket/redis.sock`. **Essas condições sozinhas não
provam que um Redis arbitrário é descartável.** O launcher do ensaio deve criar
uma instância nova, sem rede/TCP ou volume persistente e inspecionar ao vivo seu
ID de imagem, labels, mounts e namespace ANTES de iniciar o processo consumidor.
Não aponte o script para um banco ou socket existente. Não há URL externa.

No laboratório validado, Redis 7 Alpine em cache usa `--port 0`, socket Unix
próprio e dados tmpfs. Node usa imagem oficial em cache, root filesystem e código
RO, UID não root, `network none`, sem portas, capabilities ou sockets do host.
O Redis é conferido vazio com `RedisConnection` antes de construir `Queue`, pois
as próprias filas criam metadados. Não há instalação ou migração de banco.

A fonte e as promessas são JSON exclusivamente sintéticos, persistidos em chave
separada no Redis do laboratório. **Não é DbPaymentPromiseRepository nem fonte
IXC real**. O adaptador lê essa chave durante o consumo e fornece evidência ao
guard real; alegações de status/pagamento no job não são autoridade. A intenção
é enfileirada antes de registrar promessa/pagamento no estado sintético.

O processador é ligado somente ao `Worker('billing-reminders', ...)` criado no
harness. Usa a fábrica real e o guard existente; `UnrecoverableError` e o handler
de falhas preservam os bloqueios terminais. Filas de outros fluxos não recebem
esse guard. Não há remetente: a continuação é estritamente sintética e retorna
`delivered:false`, `enqueued:0`.

## O que o ensaio prova

- Dois produtores com o mesmo jobId deixam uma intenção única; worker com
  concorrência 2 tenta consumi-la.
- Pagamento fictício R/0 ou promessa vigente antes do consumo: job permanece
  `failed`, uma tentativa, zero continuação, nenhum lembrete ou DLQ posterior.
- Reexecução deliberada só no laboratório de pagamento confirmado continua
  bloqueada; promessa expirada não reativa intenção com calendário obsoleto.
- Saldo zero com status aberto e fonte indisponível não confirmam pagamento:
  zero continuação, retries existentes e cópia diagnóstica à DLQ ao esgotar.
- Controle elegível chega uma vez à continuação fictícia. Não é envio/recibo.

`failed` retido não é remoção física do job. Deduplicação por jobId no Redis
retido não é exactly-once ou idempotência durável de transporte externo. Não
prescreve retry manual operacional, implantação mista ou liberação de canal.
Não cobre pagamento ocorrido entre a leitura e um efeito externo futuro.

## Reprodução opt-in a partir deste checkout

O launcher versionado `scripts/run-collection-observe-lab.py` dispensa a
orquestração privada da rodada inicial. Usa somente Python padrão, Docker local
rootless com seccomp e dependências previamente instaladas e confiáveis. Não
instala, baixa imagens, lê configuração Docker pessoal ou aceita destino remoto.
Exige Linux/amd64, usuário local UID 1000, socket Docker local em
`/var/run/docker.sock` e estas imagens oficiais já em cache:

- Node: `node@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4`.
- Redis: `redis@sha256:c5d34a98396a4775e223c74e929162c35c5a2182901ba26b50ade939941ce14b`.

O código verifica também IDs locais imutáveis, arquitetura e sistema operacional.
Cache ausente ou diferente é recusa; não há pull automático. As dependências de
`services/queue-runtime/node_modules` devem existir, incluindo BullMQ 5.81.2 e
seu grafo declarado. Opcionalmente `--queue-dependencies` aceita o caminho
absoluto de outro diretório `node_modules` previamente preparado e confiável.
A versão conferida de BullMQ não comprova a integridade de todo esse grafo.
Não monte dependências com credenciais, configurações pessoais ou dados privados.

De uma cópia limpa, com esses pré-requisitos disponíveis, escolha um diretório
de saída absoluto NOVO cujo pai já exista:

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin python3 -I -S scripts/run-collection-observe-lab.py \
  --approve-local-synthetic --output /tmp/lzr-billing-lab-new
```

Não execute com sudo, não reutilize socket Redis e não ajuste o daemon para
satisfazer uma recusa. O Python exige `-I -S`; o launcher não torna seguro um
interpretador ou bootstrap nativo previamente comprometido. `env -i` limpa o
ambiente antes do Python, e cada subprocesso recebe ambiente enumerado. Não
herda URL Redis, banco, tokens ou configurações de conta. A seleção de Docker
usa caminho conhecido e um diretório de configuração vazio criado na saída.

Antes de iniciar o consumidor, o launcher confere root filesystem RO, UID/GID
1000, `network none`, ausência de portas publicadas, capabilities adicionais,
volumes anônimos e namespaces do host; código e dependências são mounts RO.
Apenas Redis recebe seu diretório de socket novo e tmpfs `/data`; não recebe
TCP nem volume persistente. Somente sete arquivos com hashes fixos são copiados
para o staging, sem `.env`, `.git` ou arquivos da aplicação restante. Os testes
usam somente os sete resultados sintéticos já descritos acima.

Nomes e label de propriedade são próprios de cada invocação. `--run-id` é apenas
um identificador técnico opcional de 32 caracteres hexadecimais; colisão com
contêiner existente causa recusa, sem renomear, adotar ou remover esse recurso.
SIGTERM/SIGINT acionam teardown limitado; encerramento abrupto do host/SIGKILL
não permite prometer cleanup. A remoção confere label, imagem e ID imutável e
alcança somente recursos criados pela invocação. Em dúvida preserva o socket e
registra cleanup não confirmado, para investigação manual dos IDs registrados.
Nunca execute uma limpeza global do Docker.

A saída preserva `identity.json`, `results.json`, `status.json` e `cleanup.json`
com hashes, contagens e categorias fixas; não preserva stdout/stderr brutos do
consumidor. Código 0 exige resultado válido e cleanup confirmado; 78 indica
recusa/pré-requisito, 1 falha do ensaio, 143 cancelamento e 73 sucesso do ensaio
com cleanup não confirmado. Outros erros locais são sanitizados; consulte sempre
`status.json`. Não publique o diretório inteiro de evidência automaticamente.

Os testes do launcher, sem Docker, podem ser executados com:

```sh
python3 -I -S tests/collection-observe-launcher.test.py
```

A execução completa continua sendo laboratório, sem remetente operacional,
Postgres, IXC ou garantia de integração real. Nenhuma credencial, alvo operacional
ou dado de cliente deve ser adicionado para reproduzi-la.

## Fronteiras das fábricas reutilizadas

Observe-only é propriedade desta composição e de sua continuação sintética, não
uma garantia universal da fábrica: o guard aceita uma continuação explicitamente
injetada e seu resultado objeto. Não injete um remetente nessa homologação.
O handler genérico preserva seu contrato antigo, inclusive mensagens de erro em
logs/DLQ fora dos bloqueios terminais. A prova desta rodada usa erros de fonte
mascarados pelo guard e valores sintéticos; não certifica sanitização universal
ou autorização de uso operacional dessas fábricas.
