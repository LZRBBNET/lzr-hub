# Casos supervisionados de recuperação

Esta fatia organiza trabalho humano no HUB. **Abrir, assumir, anotar, vincular ou encerrar um caso não envia mensagens, não registra negociação, não altera o IXC e não comprova recebimento.** A consulta financeira existente continua um recorte limitado, separado da fila operacional persistida.

## Escopo e acesso

- O servidor exige `RECOVERY_CASE_SCOPE_ID`: identificador estável e exclusivo da instalação. Valor ausente mantém a nova função indisponível; o navegador não escolhe o escopo.
- Login é obrigatório mesmo quando a demonstração deixa `FEATURE_AUTH=false`. Leitura usa `customer.read`; alterações usam a permissão já existente `billing.write-demo`. Nenhum papel ganha permissão de envio, negociação ou escrita no ERP.
- A aplicação legada é **single-tenant**: usuários, promessas e atendimentos não possuem `tenant_id`. O novo escopo separa os registros das tabelas de casos/eventos, mas não transforma o legado em infraestrutura multi-tenant. Cada instalação precisa de seu próprio contexto autorizado de banco/IXC. Banco legado compartilhado entre empresas continua fora do suporte desta fatia.
- Os campos estruturados guardam referências e autoria, sem duplicar CPF, telefone ou endereço. Observações devem conter apenas o necessário ao acompanhamento, sem credenciais ou documentos pessoais. O vínculo com Atendimento precisa de um atendimento identificado no mesmo cliente; não se aceita número arbitrário como prova de identidade.

## Fluxo mínimo

1. Conferir o cliente e abrir um caso de dívida, pedido de cancelamento ou ambos. A existência do cliente é validada na fonte.
2. Assumir o caso; se outro operador for responsável, uma tomada de responsabilidade precisa ser explícita. Isso não toma silenciosamente a conversa de outro atendente.
3. Marcar próxima data de retorno e registrar observações do operador. Data de retorno é de calendário, não um horário inferido.
4. Vincular fatura, promessa ou Atendimento: o servidor confere os identificadores e o vínculo ao mesmo cliente. Uma consulta ao IXC usa apenas o caminho de leitura.
5. Acessar o Atendimento existente quando o vínculo estiver confirmado. Os controles de resposta e passagem ao humano continuam com as suas próprias permissões e políticas.
6. Encerrar com motivo declarado ou reabrir. **Encerrado não significa dívida paga nem cancelamento evitado.** Se outro caso já estiver aberto para o cliente, a reabertura é recusada.

Limite de usabilidade desta fatia: faturas e promessas são referências por ID validadas, sem navegação para detalhe. Para vincular Atendimento, o operador copia o protocolo visível na tela existente; o servidor resolve somente o atendimento identificado no mesmo cliente. Não existe busca ampla de conversas nem se pede ID interno invisível. Depois de validado o vínculo, o botão abre a conversa existente sem enviar nada.

## Persistência e concorrência

Casos e eventos são tabelas novas e aditivas. Um índice único parcial limita a um caso não encerrado por cliente/escopo. Uma alteração exige a versão observada; atualização concorrente retorna conflito, não sobrescreve trabalho mais recente. A mudança e seu evento pertencem à mesma transação.

Cada mutação usa uma chave de idempotência com conteúdo/autor/escopo associados. Repetir a mesma operação não acrescenta um evento; reaproveitar a chave para outro conteúdo não é aceito. Um resultado incerto deve levar à consulta do caso/histórico, nunca a repetição automática de escrita com nova chave.

A tela preserva a solicitação incerta e sua chave em memória do navegador, por usuário/caso, durante a navegação local. Não grava relatos em armazenamento persistente. Recarregar ou fechar o navegador perde essa memória: o operador precisa consultar o histórico antes de repetir. A unicidade impede dois casos ativos, mas não deduplica relatos diferentes criados com novas chaves.

Eventos são anexados ao histórico; a API não oferece edição ou exclusão de eventos. Uma observação manual continua identificada como **relato do operador**, mesmo se seu texto disser “pago” ou “entregue”. Referência de fatura validada não é recibo financeiro; promessa vinculada é compromisso registrado, não dinheiro.

## Fronteiras deliberadas

- Sem campanha, envio automático, novo score, desconto, negociação, desbloqueio ou job financeiro.
- Sem contador de “dinheiro recuperado pela IA” ou “cancelamentos evitados”. Para dinheiro recebido é necessária evidência granular de pagamento, com ID, valor, data e deduplicação; efeito causal exige avaliação comparativa própria.
- A ligação a um Atendimento não inicia conversa e não contorna os controles de envio existentes.
- A fila de sinais de churn e os limites da consulta financeira continuam declarados; esta fatia não aumenta a cobertura do IXC.

## Validação e implantação

A migração deve ser revisada junto com o schema e snapshot novos; não se alteram migrações anteriores. **Não executar `npm start` como simples inspeção**: ele aplica migrações antes de iniciar o servidor.

Antes de publicar, é necessário testar a migração e transações em PostgreSQL isolado, incluindo unicidade concorrente, alteração+evento atômicos, replay idempotente e fechamento/reabertura. Testes em memória, captura de SQL ou componentes com fetch sintético não substituem esse ensaio. Nenhum banco real deve ser usado para esse teste sem autorização e confirmação do alvo.

O gate reproduzível é `scripts/test-recovery-cases-postgres.mjs`. Ele não lê `DATABASE_URL` nem arquivos `.env`, não cria/destroi bancos e recusa banco não vazio, host remoto, opções na URL ou nome fora de `lzr_recovery_test_*`. Depois de provisionar um PostgreSQL descartável local autorizado, execute com as duas variáveis explícitas (substitua somente credenciais locais):

```bash
RECOVERY_CASE_TEST_DATABASE_URL='postgres://test:local@127.0.0.1:55432/lzr_recovery_test_cases' \
RECOVERY_CASE_TEST_ALLOW_MIGRATION=lzr_recovery_test_cases \
node --experimental-strip-types scripts/test-recovery-cases-postgres.mjs
```

O script aplica a cadeia exata de migrações e exercita concorrência, idempotência, isolamento de escopo, rollback real após falha na inserção de evento e reabertura. Fontes IXC são sintéticas, sem conexão externa. O banco permanece para inspeção; uma nova execução exige outro banco vazio. **A presença desse script ou a aprovação dos seus testes de proteção não significa que o gate PostgreSQL foi executado.**

A publicação, configuração de escopo e aplicação de migração exigem revisão/autorização próprias. Esta documentação não autoriza contatos reais, migração de produção ou ativação de automação.
