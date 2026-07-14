# Plano do piloto interno

O piloto não atende clientes e não executa ações. Duração sugerida: 5 dias úteis.

## Participantes

1. Administrador: configura allowlist, acompanha saúde e auditoria.
2. Supervisor: valida Customer 360, falhas parciais e qualidade do atendimento.
3. Atendente: localiza apenas cadastros autorizados e registra feedback.

## Escopo

- Até 10 cadastros internos formalmente autorizados.
- Customer 360 IXC somente leitura.
- Atualização manual e cache.
- Simulação de indisponibilidade, timeout e retorno parcial.
- Verificação de bloqueios para escrita, cliente fora da allowlist e job não autenticado.

## Métricas

- tempo para localizar cadastro e abrir Customer 360;
- latência IXC por fonte e taxa de cache hit;
- falhas, circuit breaker, jobs e DLQ;
- erros, repetição e handoff da IA;
- satisfação do atendente de 1 a 5;
- ações bloqueadas e tentativas fora da allowlist.

Critério de saída: nenhuma escrita ou consulta não autorizada, 100% dos dados sensíveis mascarados, falha parcial funcional e satisfação média do operador igual ou superior a 4.
