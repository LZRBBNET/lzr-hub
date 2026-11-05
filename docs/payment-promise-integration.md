# Reconciliação de promessas sobre a base implantada

Integração seletiva do PR #33 sobre o PR #34, sem trazer a divergência de `main`, migrações ou o painel de Recuperação.

## Comportamento

- Apenas uma consulta fresca e completa da fatura e cliente exatos com status IXC `R` confirma pagamento.
- Ausência, erro, resposta parcial, duplicata, divergência de identidade, cancelamento e código desconhecido deixam a promessa sem confirmação. Nenhuma alteração de status ocorre nesses casos.
- A conferência é manual e limitada a 20 promessas por clique, com cursor por ID e até 21 registros lidos no banco. Promessas do mesmo cliente/fatura compartilham uma consulta apenas dentro do lote.
- Atualizações exigem que a promessa ainda esteja pendente, para não sobrescrever encerramento concorrente.
- A UI informa casos sem confirmação, oferece próximo lote/reinício e recarrega a lista após sucesso ou falha, sem repetir escritas automaticamente.
- A régua faz uma leitura fresca somente das faturas abertas de cada cliente autorizado, sem reaproveitar o cache do Customer360. Pagamento recebido depois de um snapshot aberto elimina a fatura da próxima rodada.
- A fonte de disparo exige cobertura completa, identidade e status aberto explícito. Falha de qualquer cliente bloqueia a rodada inteira antes do ledger. A API retorna indisponibilidade, nunca sucesso com carteira vazia por falha.

## Limites deliberados

- Até 20 faturas abertas por cliente na leitura da régua. Acima disso, o lote fica indisponível e exige futura paginação controlada; não processa um subconjunto silenciosamente.
- Uma leitura lógica por cliente na régua, com no máximo um retry do adaptador. Não consulta contratos, conexão ou pagamentos auxiliares. Duas rodadas com dois clientes e dez faturas cada usam quatro leituras, evitando esgotar o limite padrão de 30 por minuto.
- A revisão de promessa tem timeout/retry por chamada, mas não possui prazo global de lote.
- Não cancela trabalhos já enfileirados. Antes de qualquer futuro envio real, o consumidor precisa revalidar pagamento e elegibilidade imediatamente antes de enviar.
- Não altera a criação de promessas, não corrige históricos já classificados, não implementa envio, nem pausa automaticamente a régua por promessa pendente.
- Homologação de navegador autenticado e PostgreSQL real permanece pendente. Os testes usam dados fictícios, transporte falso e repositórios em memória.

## Origem e segurança

Base de produção: `a0f7048a771222e495ffccaecd00c9635539e23b`.
Base imediata: PR #34, `8d26b71127b6b30f727be88b35caf2bed7e1e5e8`.
Fonte seletiva: PR #33, `92dcc436dc53cb9146f281be8ca0ea1777885ca2`.

Preservadas as validações de cobertura e vínculo do Customer360 presentes na base implantada. Sem mudança de configuração, dependência ou esquema. IXC permanece somente leitura. Não houve envio, ação sobre cliente, merge ou deploy durante a preparação.

O PR #33 continua separado: o painel de Recuperação e demais mudanças não foram portados aqui. Esta entrega não declara aquele PR totalmente integrado.
