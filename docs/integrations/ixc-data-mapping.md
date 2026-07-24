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
  - **`cliente.cidade` vem como código numérico** (ex.: `"1759"`), não como nome da cidade. O mapper atual (`mappers.ts:8`) usa esse valor direto em `city`, então hoje o Customer 360 exibiria o código, não o nome. Resolver isso exige uma chamada adicional ao endpoint `cidade` (`qtype: cidade.id`) para traduzir o código — ainda não implementado. Acompanhar na issue de ativação do IXC.
- `contrato`, `fn_areceber`, `su_oss_chamado` — endpoints alcançáveis e formato de chamada confirmado (ver seção de conectividade abaixo), mas ainda sem uma amostra de dado real validada campo a campo.

## Conectividade real do webservice IXC (descoberta em homologação)

- O IXC exige **método GET com corpo JSON** para listagens (`qtype`/`query`/`oper`/...), não `POST` com `form-urlencoded`. Fora desse formato, a API responde com um erro genérico HTML ("Ocorreu um erro ao processar"), sem pista do motivo real.
- O ambiente do IXC é restrito por IP (**"Redes Permitidas"**), e a Cloudflare Workers não tem IP de saída fixo — por isso o acesso real ao IXC passa por uma ponte própria (servidor Node com IP fixo dedicado), não por chamada direta do Worker. Ver `docs/integrations/ixc-staging-secrets.md` e a issue de ativação do IXC para a arquitetura da ponte.
