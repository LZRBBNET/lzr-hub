# Checklist LGPD — staging

## Matriz de PII

| Dado | Classificação | Uso | Persistência | Log |
|---|---|---|---|---|
| ID IXC | restrito | allowlist e correlação | mascarado quando exibido | mascarado |
| nome | pessoal | identificação controlada | somente forma mascarada no cache | proibido completo |
| CPF/CNPJ | crítico | conferência visual | somente forma mascarada | proibido |
| telefone/e-mail | pessoal | fora do escopo 3A | não | proibido |
| endereço/bairro | pessoal | contexto controlado | marcador/prefixo mascarado | proibido |
| fatura/pagamento | financeiro sensível | Customer 360 | agregado mascarado | proibido bruto |
| login PPPoE | credencial operacional | estado de conexão | mascarado | proibido completo |

## Controles obrigatórios

- [x] Acesso custom, sem público ou clientes.
- [x] Allowlist limitada em código a 10 IDs.
- [x] IXC desativado por padrão e somente `staging-readonly` aceito.
- [x] Escrita rejeitada na configuração e no `ReadonlyIxcGuard`.
- [x] Payload bruto IXC não persistido.
- [x] Logs estruturados passam por sanitização.
- [x] Fixtures e seed são sintéticos.
- [x] Backup ignorado no Git e restore isolado.
- [x] Auditoria guarda ação, resultado e correlação sem PII completa.
- [x] Timeout, retry curto, rate limit e circuit breaker ativos.
- [ ] Cadastrar usuários e IDs internos autorizados antes de ligar IXC.
- [ ] Configurar rotação do token IXC antes do piloto.

## Retenção e resposta a incidente

- Cache IXC: 5 minutos por padrão; nunca contém payload bruto.
- Eventos de saúde: 30 dias no piloto.
- Auditoria: 180 dias, sujeita a revisão jurídica/operacional.
- Jobs/DLQ: 30 dias após resolução.
- Remover os dados do piloto até 7 dias após encerramento, preservando apenas métricas agregadas.

Em incidente: desligar `IXC_MODE`, revogar token, restringir acesso, preservar evidências sanitizadas, avaliar alcance, restaurar checkpoint seguro e registrar decisão. Não restaurar dump real em ambiente de desenvolvimento.
