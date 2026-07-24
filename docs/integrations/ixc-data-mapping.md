# Mapeamento IXC → LZR HUB

Os campos externos entram apenas pelos mappers. Payload bruto, token, CPF, telefone, login e endereço não são persistidos nem registrados em telemetria.

| Origem IXC | Destino interno | Tipo | Transformação/mascaramento | Nullable | Atualização | Precedência | Risco |
|---|---|---|---|---|---|---|---|
| cliente.id | customer.id | string | allowlist obrigatória | não | sob demanda | IXC | identificador |
| cliente.razao/nome | nameMasked | string | primeiro nome + iniciais | não | cache 5 min | IXC | PII alta |
| cliente.cnpj_cpf | documentMasked | string | somente 2 finais | sim | cache 5 min | IXC | PII crítica |
| cliente.cidade | city | string | texto validado | sim | cache 5 min | IXC | localização |
| cliente.bairro | neighborhoodMasked | string | prefixo curto | sim | cache 5 min | IXC | localização |
| cliente_contrato.id | contract.id | string | texto | não | sob demanda | IXC | baixo |
| cliente_contrato.contrato/plano | contract.planName | string | texto validado | sim | sob demanda | IXC | comercial |
| cliente_contrato.valor_plano | monthlyValue | number | decimal | sim | sob demanda | IXC | financeiro |
| fn_areceber.valor/data_vencimento | invoice | number/date | sem linha digitável completa | sim | sob demanda | IXC | financeiro alto |
| fn_movim_finan.valor/data | payment | number/date | forma normalizada | sim | sob demanda | IXC | financeiro alto |
| su_oss_chamado.status/assunto | serviceOrder | string | sem mensagem livre persistida | sim | sob demanda | IXC | suporte |
| radusuarios.login | connection.loginMasked | string | prefixo + asteriscos | sim | sob demanda | IXC | credencial |
| radusuarios.endereco | addressMasked | string | marcador fixo | sim | sob demanda | IXC | PII crítica |

Todos os campos inesperados são ignorados. IDs ausentes em entidades obrigatórias causam erro de contrato e falha parcial, nunca coerção silenciosa.

## Operações do relay

O relay de egress fixo mantém o mesmo catálogo do provider e não aceita `resource`, `qtype`, `oper`, URL ou headers informados pelo Worker.

| Operação | Recurso fixo | Filtro fixo |
| --- | --- | --- |
| `testConnection` | `cliente` | `id = 0` |
| `getCustomer` | `cliente` | `id = customerId` |
| `listContracts` | `cliente_contrato` | `id_cliente = customerId` |
| `getPlan` | `vd_contratos` | `id = planId` |
| `listInvoices` | `fn_areceber` | `id_cliente = customerId` |
| `listPayments` | `fn_movim_finan` | `id_cliente = customerId` |
| `listServiceOrders` | `su_oss_chamado` | `id_cliente = customerId` |
| `getConnection` | `radusuarios` | `id_cliente = customerId` |

Este mapeamento foi confirmado em `readonly-provider.ts`, nos mappers e nos testes automatizados. A Collection Postman da Issue #23 ainda não está presente na `main`; a validação cruzada com ela permanece pendente e não foi simulada.
