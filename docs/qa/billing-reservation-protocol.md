# Reserva, confirmação e reconciliação — especificação executável sintética

Base #97 `cf676c65570bca02e166aaaa554670d6bfb85294`. Somente fixture e testes; nenhum schema, migração, worker, fila, transporte ou política operacional alterado.

## Estados e transições propostas

| Estado | Significado | Transições permitidas |
| --- | --- | --- |
| `reserved` | Chave e tentativa registradas; efeito ainda não autorizado. | Evidência válida → `intent`; evidência inconclusiva/pagamento/promessa → `blocked`; lease vencido → `expired`. |
| `intent` | Intenção confirmada na transação antes de retornar permissão ao chamador. | Recibo aceito → `confirmed`; crash/resultado ambíguo → `unresolved`; prova final de ausência de efeito → `no-effect-confirmed`. |
| `unresolved` | Pode ter ocorrido efeito; lease expirado não esclarece resultado. | Somente reconciliação com evidência autoritativa compatível. |
| `confirmed` | Aceitação do efeito foi reconhecida pelo adaptador, não leitura pelo cliente. | Recibo idêntico é idempotente; conflito é recusado. |
| `blocked`, `expired`, `no-effect-confirmed` | Modelo não permite iniciar efeito automaticamente. | Nenhuma reabertura automática. Nova tentativa exige desenho/decisão posterior, não implementada. |

A chave segue fatura/etapa/data; o vínculo inclui também cliente, versão da regra e versão imutável do template. Reutilizar a chave com outro vínculo é recusado. Cada reserva recebe token de tentativa monotônico no armazenamento simulado; operações e recibos devem corresponder ao token exato.

## Invariantes

1. `intent` precisa concluir commit antes de retornar permissão para efeito. Rollback não retorna permissão. Efeito não ocorre dentro da transação.
2. Duplicação ou concorrência na mesma chave retorna no máximo uma permissão nessa instância do modelo. Não significa uma entrega externa exatamente uma vez.
3. Antes de `intent`, evidência deve ser completa, corretamente identificada, observada dentro de sua validade, com dívida aberta e sem promessa ativa. O modelo recebe esses fatos de fixture; não substitui os guards reais nem define novos horários comerciais.
4. Após `intent`, crash antes do efeito e crash depois do efeito são indistinguíveis sem reconciliação. Ambos impedem reenvio automático. Pagamento/promessa posterior não prova que o efeito anterior deixou de ocorrer.
5. Recibo exige chave, tentativa, tipo e identidade do efeito. Ausência/timeout/`not-found` não é prova de ausência de efeito. Confirmações conflitantes não alteram estado.
6. Leases não liberam `intent`, `unresolved` ou estados finais para retry. `no-effect-confirmed` também não autoriza retry neste modelo.
7. Transações, retornos e snapshots usam cópias profundas; falhas e referências retidas não modificam estado confirmado.

## Evidência necessária para uma implementação operacional futura

O adaptador de evidência precisa validar escopo, completude, idade, status/saldo, regra corrente e promessa pelo caminho confiável existente, não por alegações do payload. Versões de conteúdo devem ser realmente imutáveis. Há uma janela entre última leitura e efeito; o modelo não torna esse intervalo atômico.

Recibos exigem autenticação e correlação provenientes do provedor efetivo, validação de replay e uma definição de aceitação versus entrega. O literal `trusted-fixture-adapter` é **apenas uma marca de teste**, não autenticação. A semântica `no-effect-final` precisaria de garantia positiva do provedor; uma busca vazia não basta. Se isso não existir, a tentativa continua inconclusiva. Concluir um job/ACK na fila não comprova efeito.

Um banco real precisaria de unicidade, transação/compare-and-set, token persistente, reconciliação e validação de crash/recovery. Nenhuma escolha de banco ou transporte é feita aqui. Retries manuais, nova tentativa e recuperação de backlog não estão autorizados ou implementados por esta especificação.

## O que os testes comprovam e o que não comprovam

`node --test tests/billing-reservation-model.test.mjs`

20 testes usam `FakeTransactionalStore`: fila de transações síncronas serializadas, clone/commit/rollback e cópia de snapshot para outra instância. Interrupções são injetadas, não crashes de processos. O efeito é somente um contador fictício. Cobertura: concorrência, falha antes da reserva/intenção, crash antes/depois do efeito, commit de confirmação perdido, recibos repetidos/conflitantes, tokens/escopo, mudanças de pagamento/promessa, expiração e isolamento de referências.

Avanço sobre #97: a reserva simples em memória foi substituída no modelo por estados explícitos que diferenciam ausência de intenção, intenção incerta e confirmação reconciliada. Restaurar o snapshot preserva essa distinção na simulação. **Isso não prova persistência real, fsync, crash durability, BullMQ/Redis, idempotência do provedor ou exactly-once.**

Cleanup limpa os stores fictícios; não há arquivos de banco, processos externos, rede, segredos, containers ou dependência de PG. Bindings e snapshots são entradas controladas de fixture: o modelo não valida uma importação de produção, restauração de snapshot obsoleto, unicidade global de effectId ou saturação da sequência de tokens. O worker operacional continua sem a integração protegida. Próximo passo depende de avaliar esse protocolo e de selecionar uma fronteira de efeito verificável; não se deve ativar envio com base nestes testes.
