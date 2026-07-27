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

## Validado contra o IXC real (homologação, 2026-07-24)

- `cliente` — validado com cadastro real (allowlist). Confirma todos os campos usados pelo `IxcCustomerMapper`, com uma ressalva:
  - **`cliente.cidade` vem como código numérico** (ex.: `"1759"`), não como nome da cidade. Resolvido (issue #28): `IxcReadonlyProvider.resolveCityName` consulta o endpoint `cidade` (`qtype: cidade.id`) e substitui o código pelo nome real no `customer.city`, com cache de 24h e sem quebrar o cadastro se a consulta falhar.
- `cidade` — validado com o código real do cliente 21857 (`1759` → `"Campo do Brito"`, campo `nome`). Endpoint e nome de campo confirmados batendo com a suposição inicial.
- `cliente_contrato` — validado com o contrato real do cliente 21857 (id `48882`, `id_vd_contrato` `404`, `contrato: "FIBRA 1,2GB "`, `status: "A"`, `data_ativacao: "2016-04-27"`). Todos os campos usados pelo `IxcContractMapper` confirmados.
  - **Atenção**: o nome do endpoint é `cliente_contrato`, **não** `contrato` (`/webservice/v1/contrato` retorna `"Recurso contrato não está disponível!"`). A collection do Postman tinha esse nome errado desde a criação — corrigido.
- `fn_areceber` — validado: cliente 21857 retornou `total: 0` (sem faturas em aberto no momento). Resposta vazia é o comportamento esperado, não erro — bate com o `openInvoices: 0` já visto no Customer 360.
- `su_oss_chamado` — validado com 48 ordens de serviço reais do cliente 21857, filtrando por **`id_cliente`** (não `id_assunto`, que era o que a collection usava antes — corrigido). Campos batem com o `IxcServiceOrderMapper`. O campo `mensagem_resposta`/`mensagem` traz texto livre do atendimento (às vezes com detalhes operacionais) — o mapper não persiste esse campo, só usa `assunto`/`mensagem` para o campo `subject`, mascarando quando ausente.

## Conectividade real do webservice IXC (descoberta em homologação)

- O IXC exige **método GET com corpo JSON** para listagens (`qtype`/`query`/`oper`/...), não `POST` com `form-urlencoded`. Fora desse formato, a API responde com um erro genérico HTML ("Ocorreu um erro ao processar"), sem pista do motivo real.
- O ambiente do IXC é restrito por IP (**"Redes Permitidas"**), e a Cloudflare Workers não tem IP de saída fixo — por isso o acesso real ao IXC passa por uma ponte própria (servidor Node com IP fixo dedicado), não por chamada direta do Worker. Ver `docs/integrations/ixc-staging-secrets.md` e a issue de ativação do IXC para a arquitetura da ponte.
