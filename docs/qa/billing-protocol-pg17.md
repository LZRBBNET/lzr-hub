# Protocolo sintético em PostgreSQL 17 descartável

Base #98 `2b431a58e3232b4f32d12841c3173bec8962302c`. Esta validação usa tabelas exclusivas de fixture em um banco novo. Não há migração, integração com o LZR, worker, Redis, transporte ou dados reais.

## Diferença em relação ao modelo #98

O modelo anterior serializava operações em memória e copiava snapshots. O novo harness verifica unicidade, concorrência, commit/rollback e estado conservado entre processos de teste usando conexões PostgreSQL reais. Uma sequência PostgreSQL pode consumir valores em uma transação abortada: o requisito é identidade monotônica e ausência de reutilização, não numeração sem lacunas.

A intenção deve ser confirmada em transação antes de autorizar qualquer fronteira de efeito fictício. Uma intenção sem recibo permanece ambígua na retomada; nem tempo decorrido nem processo novo autorizam replay. Recibo repetido idêntico pode ser reconhecido; conflito de recibo ou tentativa não deve mudar o estado confirmado.

## Isolamento

Somente imagem oficial PG17 fixada por digest já disponível em cache; execução com `--pull=never`, rede `none` e sem portas publicadas. Banco/credencial novos, arquivos privados temporários, scripts/dependências montados somente para leitura. O harness recusa execução sem `--run`. Não utiliza URL ou credenciais herdadas do ambiente.

Apenas processos, conexões e recursos criados por esta execução podem ser encerrados ou removidos. Perda de conexão é injetada em backend exclusivo do fixture, nunca em banco compartilhado. A retomada usa outro processo Node com o mesmo banco descartável.

## Limites e decisões pendentes

- PostgreSQL está em armazenamento temporário: não há prova de fsync, crash físico, desligamento do host ou durabilidade após perda de tmpfs. Reiniciar processo de teste não é reiniciar banco nem comprovar crash durability.
- Nenhum efeito externo ou entrega é produzido; não há prova de exactly-once ou atomicidade com provedor.
- Recibos são fixtures, não mensagens autenticadas. Identidade global do efeito, autenticação e replay de recibos dependem de contrato operacional posterior.
- Restauração de snapshot antigo pode exigir uma época externa de execução e reconciliação; não foi resolvida por esta rodada.
- Regras de cobrança, evidência de pagamento/promessa e tratamento comercial de tentativas bloqueadas continuam conforme os limites do #98. Este harness não ativa retomada ou contato.
- O worker operacional permanece sem conexão ao consumidor protegido. Esta entrega valida somente propriedades do protocolo em um banco isolado.

## Execução e cobertura delimitada

`node tests/manual/billing-protocol-pg17.mjs --run`

Driver `pg` 8.22.0 conferido contra o lockfile; servidor confirma versão 17 em ambos os processos. O harness exige dependências locais já instaladas; não instala pacotes nem busca imagens. Evidência sanitizada inclui SHA/árvore, hashes dos dois scripts e resultados fechados.

Esta rodada porta somente `reserved`, `intent`, `unresolved` e `confirmed`, com unicidade, comparação de token/vínculo, bloqueio de linha na confirmação, rollback, término de conexão própria e retomada em segundo processo. Expiração, validação de pagamento/promessa e `no-effect-confirmed` continuam cobertos somente pelo modelo fictício #98; não foram novamente implementados ou comprovados em SQL. A tabela e as funções deste harness não são uma migração nem um repositório pronto para uso pelo app.

A primeira execução pré-commit passou e removeu container/arquivos. A evidência final identificada pelo SHA publicado deve prevalecer sobre essa execução preliminar. As confirmações concorrentes e a leitura independente após conflito conferem que o estado aceito não foi sobrescrito.
