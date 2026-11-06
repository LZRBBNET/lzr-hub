# Diagnóstico restrito de estrutura de pagamentos

Executor avulso, sem rota HTTP, dependência, migração ou mudança no provider/runtime.
Importar o módulo não executa consulta. Não é um teste de pagamento e não confirma que
fn_movim_finan equivale ao formulário Recebimentos. A implementação normal permanece
fail-closed quando não há vínculo de fatura. O executor só projeta estrutura, nunca
substitui a validação normal ou retorna um pagamento.

## Requisitos e operação (não executada)

O operador precisa de terminal privado já autorizado com acesso à origem IXC e às
credenciais existentes. Este pacote NÃO fornece esse acesso. A ferramenta Railway
atualmente disponível não oferece shell; não criar serviço, copiar tokens do painel,
ativar tracing de payload ou disponibilizar endpoint público para contornar isso.
Antes de executar, confirmar autorização do titular para a consulta diagnóstica e os
identificadores exatos do cliente e fatura; não adivinhar. Sem custo ou provisionamento.

1. Revisar código/testes e usar a árvore aprovada, Node compatível com o projeto.
2. Em ambiente administrativo privado, fornecer IXC_BASE_URL e IXC_API_TOKEN já
   existentes, sem argumentos de processo, chat, shell history, arquivo de configuração
   público ou logs. O executor não lê .env. Não executar sob shell tracing/APM que
   capture memória, env, headers ou corpos; o código não pode garantir a política de
   ferramentas externas do operador.
3. Definir configurações não secretas apenas no processo: IXC_HTTP_METHOD (GET ou
   POST, igual ao transporte efetivo confirmado), IXC_SCHEMA_APPROVED_ORIGIN (a
   origem HTTPS exata já aprovada), IXC_SCHEMA_CUSTOMER_ID e IXC_SCHEMA_INVOICE_ID,
   IXC_SCHEMA_DIAGNOSTIC_APPROVED=true e IXC_SCHEMA_DIAGNOSTIC_EXPIRES_AT (ISO UTC,
   no futuro e até 15 minutos). Não publicar os valores operacionais reais.
4. Definir IXC_SCHEMA_RESERVATION_PATH: caminho absoluto em diretório privado do
   operador, com armazenamento persistente e sem symlinks. Não usar /tmp ou /proc.
   O arquivo deve não existir. A criação exclusiva 0600 e fsync ANTES da rede é a
   reserva de uso; o conteúdo não inclui segredo ou identificadores. Todos os
   executores devem usar o MESMO arquivo. Não trocar/apagar a reserva para repetir.
5. Executar uma vez `node scripts/ixc-payment-schema-diagnostic.mjs`.
   No máximo três requisições sequenciais: prova exata de propriedade em fn_areceber,
   UMA linha de fn_movim_finan com o filtro atual id_receber, e nova prova de
   propriedade. Todas usam ixcsoft:listar; nunca inserir/alterar/excluir no IXC.
   Qualquer erro interrompe: zero retries/redirects, timeout 5s por requisição,
   limite 64KiB por resposta. A reserva é consumida mesmo se nada for enviado.
6. Capturar SOMENTE stdout projetado. Qualquer erro produz mensagem fixa sem
   causa/URL/payload. Não repetir após erro, expiração, falha de resposta ou saída
   incerta. Reconciliar com evidência antes de nova autorização de execução.
7. Remover as variáveis temporárias do processo e encerrar o terminal; preservar
   a reserva e somente a projeção aprovada. Não remover reserva automaticamente.

## Saída e limites

`fields` contém nomes estáticos revisados e tipos JS (string, number, boolean, null,
array ou object), sem valores, totais, IDs, hashes, tamanhos de strings ou nomes
aninhados. A lista de nomes é FECHADA: chaves desconhecidas são omitidas e apenas
`omittedFields:true` é emitido. Esse limite evita que uma chave dinâmica seja, ela
própria, dado pessoal. Pode impedir descobrir o campo novo: nesse caso é preciso
obter o esquema oficial e revisar a lista; nunca ecoar todas as chaves arbitrárias.
Nomes como historico/documento indicam apenas coluna e tipo, nunca conteúdo.

Ausência de uma chave não prova ausência no recurso inteiro; uma linha não comprova
cardinalidade, vínculo, valor pago, quitação, estorno ou recebimento composto. A dupla
prova de propriedade não é transação e não detecta alteração revertida entre leituras.
A resposta bruta necessariamente existe transitoriamente em memória para parse;
não é emitida/persistida pelo executor, nem é possível prometer apagamento seguro da
memória JavaScript. O token existente fica só no ambiente/memória e cabeçalho HTTPS.

A reserva só protege concorrência/restart se o mesmo arquivo persistente for mantido.
Não é um consumo central distribuído: múltiplas máquinas ou paths distintos não são
seguros para execução paralela. Se não houver armazenamento persistente e controle
operacional de execução única, NÃO executar. Não há rate limiter global novo: o teto
é três tentativas, sem retries; capacidade real do IXC não foi medida.

## Alternativa sem instrumentação e remoção

Preferir esquema oficial ou captura previamente disponível que possa ser projetada
localmente com a mesma lista fechada, sem outra consulta. As rotas existentes retornam
DTO/erro; smoke/sync não servem para isso. Nenhum navegador autenticado ou terminal
remoto está disponível ao executor cloud atual. Sem esse acesso, este código é uma
entrega preparada e testada offline, não coleta real concluída. Não é necessário
deploy de produção para executar o arquivo em terminal autorizado; se for preciso
implantar qualquer versão, obter autorização específica de alvo/SHA antes.

Por padrão, sem as configurações explícitas o executor para antes da rede. Expiração
encerra a janela, reserva impede reuso no mesmo armazenamento. Após o diagnóstico,
remover o script e seu teste numa mudança revisada ou manter desativado: nada no
servidor importa esse módulo e nenhuma rota foi adicionada.

Verificação offline: `node --test tests/ixc-payment-schema-diagnostic.test.mjs`.
Dublês de transporte e HTTPS, sem sockets externos, banco, login ou cliente real.
