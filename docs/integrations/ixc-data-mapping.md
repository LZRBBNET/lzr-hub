# Mapeamento IXC → LZR HUB

Os campos externos entram apenas pelos mappers. Payload bruto, token e senha (o IXC devolve até hash de senha em `usuarios` -- ver `docs/security/ixc-user-provisioning.md`) nunca são persistidos nem registrados em telemetria (`sanitizeTelemetry`).

## Mascaramento de PII (decisão revista em 2026-08-04)

Até aqui, nome, CPF, bairro, login PPPoE e endereço saíam mascarados do Customer 360 -- decisão da fase de homologação inicial. **Revisto a pedido do Breno**: o Customer 360 precisa mostrar dado completo pra quem atende de verdade (não dá pra ajudar um cliente sem saber telefone/endereço). A proteção agora é **sessão + RBAC** (login obrigatório, ver issue #30), não mais texto truncado -- e só se aplica a quem tem uma conta autenticada no LZR HUB.

`sanitizeTelemetry` continua mascarando esses mesmos campos em **logs e telemetria** -- a mudança é só na tela, não no rastro técnico.

**Fora do escopo desse desmascaramento, de propósito**: a senha PPPoE (`radusuarios.senha`) não é exposta em nenhum lugar -- é uma credencial ativa, não um dado cadastral, e mostrar isso na tela é uma decisão maior que não foi tomada ainda.

| Origem IXC | Destino interno | Tipo | Nullable | Atualização | Precedência | Risco |
|---|---|---|---|---|---|---|
| cliente.id | customer.id | string | não | sob demanda | IXC | identificador |
| cliente.razao/nome | customer.name | string | não | cache 5 min | IXC | PII alta |
| cliente.cnpj_cpf | customer.document | string | sim | cache 5 min | IXC | PII crítica |
| cliente.telefone_celular/whatsapp/telefone_comercial/fone | customer.phone | string | sim | cache 5 min | IXC | PII alta |
| cliente.email | customer.email | string | sim | cache 5 min | IXC | PII alta |
| cliente.cidade | customer.city | string | sim | cache 5 min | IXC | localização |
| cliente.bairro | customer.neighborhood | string | sim | cache 5 min | IXC | localização |
| cliente.endereco+numero+complemento+cep | customer.address | string | sim | cache 5 min | IXC | PII crítica |
| cliente.data_cadastro | customer.customerSince | string | sim | cache 5 min | IXC | baixo |
| cliente_contrato.id | contract.id | string | não | sob demanda | IXC | baixo |
| cliente_contrato.contrato/plano | contract.planName | string | sim | sob demanda | IXC | comercial |
| cliente_contrato.valor_plano | monthlyValue | number | sim | sob demanda | IXC | financeiro |
| fn_areceber.valor/data_vencimento | invoice | number/date | sim | sob demanda | IXC | financeiro alto |
| fn_movim_finan.valor/data | payment | number/date | sim | sob demanda | IXC | financeiro alto |
| su_oss_chamado.status/assunto | serviceOrder | string | sim | sob demanda | IXC | suporte |
| radusuarios.login | connection.login | string | sim | sob demanda | IXC | credencial |
| radusuarios.endereco+numero+bairro+cep | connection.address | string | sim | sob demanda | IXC | PII crítica |
| radusuarios.conexao | connection.equipmentDescriptor | string | sim | sob demanda | IXC | rede |
| radusuarios.tipo_conexao | connection.connectionType | string | sim | sob demanda | IXC | rede |

Todos os campos inesperados são ignorados. IDs ausentes em entidades obrigatórias causam erro de contrato e falha parcial, nunca coerção silenciosa.

## A base inteira é acessível (verificado em 2026-08-04)

A doc afirmava que "o ERP não expõe busca aberta da base". **Estava errado** — nunca tinha sido testado. `scripts/ixc-probe-listing.mjs` perguntou ao IXC de homologação e confirmou:

| Consulta | Resultado |
|---|---|
| `cliente.id > 0` | `total: 27538` |
| `cliente.ativo = S` | `total: 14212` |
| `rp: 100` | devolveu 100 registros — paginação respeitada |
| `cliente.razao LIKE 'MARIA'` | `total: 2886` |
| `cliente.razao = 'MARIA'` | `total: 0` — por isso a busca por nome usa `L`, não `=` |
| `cliente_contrato.status = A` | `total: 14955` |

A limitação a um cadastro era a **allowlist de homologação**, decisão nossa. Liberar depende de `FEATURE_IXC_FULL_BASE=true`, que por sua vez exige `FEATURE_AUTH=true` (o carregamento da configuração recusa a combinação sem login).

⚠️ Antes de ligar, considere o `IXC_RATE_LIMIT_PER_MINUTE` (padrão 30). Uma tela de lista paginada consome 1 chamada por página mais as consultas de cidade ainda não cacheadas.

## Situação do contrato: "I", não "C" (verificado em 2026-08-04)

O IXC marca contrato encerrado com **`status = "I"`**. `"C"` não existe e devolve `total: 0` — em silêncio, parecendo "nenhum cancelamento". Confirmado por amostra de 400 contratos: só aparecem `A` e `I`, e todos os que têm `data_cancelamento` preenchida são `I`.

| Status | Total na base |
|---|---|
| `A` (ativo) | 14.955 |
| `I` (encerrado) | 21.949 |
| `P` | 7 |
| `C`, `D`, `N`, `B` | não existem |

⚠️ **Nunca combine `status = "A"` com `data_cancelamento`** — são condições contraditórias e o resultado é sempre zero. Esse erro já foi cometido aqui e produziu a conclusão errada de que não havia cancelamentos.

Cancelamentos filtrando só por `data_cancelamento`: 242 em 30 dias, 545 em 90, 1.345 em 2026.

**`motivo_cancelamento` é um código numérico e a API não expõe a tradução.** Foram testados `cliente_contrato_motivo`, `motivo_cancelamento`, `su_motivo`, `cliente_contrato_cancelamento` e `vd_contrato_motivo_cancel` — todos respondem "Recurso não está disponível". A tela mostra o código cru; o significado precisa vir do painel do IXC ou do suporte.

## Filtros compostos: `grid_param`

O trio `qtype`/`query`/`oper` só aceita **uma** condição. Para combinar, o webservice usa `grid_param`, um JSON de filtros:

```json
[{"TB":"fn_areceber.status","OP":"=","P":"A"},{"TB":"fn_areceber.data_vencimento","OP":"<","P":"2026-08-04"}]
```

Validado: `status=A` sozinho dá 73.870 faturas; combinado com o vencimento cai para 3.541; e um valor inválido zera — o que prova que a combinação é aplicada, e não ignorada em silêncio.

O IXC **não agrega**: `total` dá a contagem, mas somar valores exige varrer os registros. Por isso a Cobrança soma as vencidas (poucos milhares) e declara que não soma o total em aberto (74 mil).

## O que o IXC genuinamente não disponibiliza (não inventamos valor no lugar)

Testado com um cliente real: `radusuarios` (conexão) **não tem** modelo de ONU, potência óptica (dBm) nem contagem de dispositivos conectados. O Customer 360 mostra "Não disponibilizado pelo IXC" nesses campos -- frase deliberadamente diferente de "não consultado", que sugeriria que só não perguntamos.

## Validado contra o IXC real (homologação, 2026-07-24)

- `cliente` — validado com cadastro real (allowlist). Confirma todos os campos usados pelo `IxcCustomerMapper`, com uma ressalva:
  - **`cliente.cidade` vem como código numérico** (ex.: `"1759"`), não como nome da cidade. Resolvido (issue #28): `IxcReadonlyProvider.resolveCityName` consulta o endpoint `cidade` (`qtype: cidade.id`) e substitui o código pelo nome real no `customer.city`, com cache de 24h e sem quebrar o cadastro se a consulta falhar.
- `cidade` — validado com o código real do cliente 21857 (`1759` → `"Campo do Brito"`, campo `nome`). Endpoint e nome de campo confirmados batendo com a suposição inicial.
- `cliente_contrato` — validado com o contrato real do cliente 21857 (id `48882`, `id_vd_contrato` `404`, `contrato: "FIBRA 1,2GB "`, `status: "A"`, `data_ativacao: "2016-04-27"`). Todos os campos usados pelo `IxcContractMapper` confirmados.
  - **Atenção**: o nome do endpoint é `cliente_contrato`, **não** `contrato` (`/webservice/v1/contrato` retorna `"Recurso contrato não está disponível!"`). A collection do Postman tinha esse nome errado desde a criação — corrigido.
- `fn_areceber` — validado: cliente 21857 retornou `total: 0` (sem faturas em aberto no momento). Resposta vazia é o comportamento esperado, não erro — bate com o `openInvoices: 0` já visto no Customer 360.
- `su_oss_chamado` — validado com 48 ordens de serviço reais do cliente 21857, filtrando por **`id_cliente`** (não `id_assunto`, que era o que a collection usava antes — corrigido). Campos batem com o `IxcServiceOrderMapper`. O campo `mensagem_resposta`/`mensagem` traz texto livre do atendimento (às vezes com detalhes operacionais) — o mapper não persiste esse campo, só usa `assunto`/`mensagem` para o campo `subject`, mascarando quando ausente.

## Bug real corrigido: pagamentos sempre falhavam (2026-08-04)

`fn_movim_finan` (pagamentos) sempre retornou erro na consulta do Customer 360 desde que a integração foi ligada -- o painel mostrava "Fonte indisponível; restante preservado" e parecia instabilidade do IXC. Não era.

**Causa raiz**: o código filtrava por `id_cliente`, mas **`fn_movim_finan` não tem essa coluna**. Confirmado testando direto contra o IXC: a mesma consulta com `id_cliente` devolve uma página de erro HTML (`"Ocorreu um erro ao processar. Contate o suporte IXC Soft."`) com **HTTP 200** -- por isso nunca foi tratado como erro de rede de verdade, e o parse de JSON falhando é o que acabava virando `IXC_NETWORK_ERROR` (nome enganoso pro que realmente aconteceu).

**Correção**: pagamentos agora são buscados por **fatura** (`fn_movim_finan.id_receber`), não por cliente direto -- busca-se as faturas do cliente primeiro (isso já funciona, filtra por `id_cliente` normalmente), e para cada fatura (até 10, pra não disparar uma rajada de chamadas) busca-se os pagamentos vinculados a ela.

⚠️ **Ressalva honesta**: o único cliente liberado na allowlist de homologação (`21857`) tem **zero faturas**, então não foi possível validar de ponta a ponta que `id_receber` retorna pagamentos reais quando existem. Confirmado apenas que a consulta não gera mais erro (antes, gerava sempre). Validar com um cliente que tenha fatura E pagamento assim que possível.

## Conectividade real do webservice IXC (descoberta em homologação)

- O IXC exige **método GET com corpo JSON** para listagens (`qtype`/`query`/`oper`/...), não `POST` com `form-urlencoded`. Fora desse formato, a API responde com um erro genérico HTML ("Ocorreu um erro ao processar"), sem pista do motivo real.
- O ambiente do IXC é restrito por IP (**"Redes Permitidas"**), e a Cloudflare Workers não tem IP de saída fixo — por isso o acesso real ao IXC passa por uma ponte própria (servidor Node com IP fixo dedicado), não por chamada direta do Worker. Ver `docs/integrations/ixc-staging-secrets.md` e a issue de ativação do IXC para a arquitetura da ponte.
