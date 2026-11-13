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

Os comandos, hashes, inspeções e resultados da rodada estão no artefato local
`lzr-collection-consumer-observe-20261113`. Nenhuma credencial, alvo operacional
ou dado de cliente deve ser adicionado para reproduzir o laboratório.

## Fronteiras das fábricas reutilizadas

Observe-only é propriedade desta composição e de sua continuação sintética, não
uma garantia universal da fábrica: o guard aceita uma continuação explicitamente
injetada e seu resultado objeto. Não injete um remetente nessa homologação.
O handler genérico preserva seu contrato antigo, inclusive mensagens de erro em
logs/DLQ fora dos bloqueios terminais. A prova desta rodada usa erros de fonte
mascarados pelo guard e valores sintéticos; não certifica sanitização universal
ou autorização de uso operacional dessas fábricas.
