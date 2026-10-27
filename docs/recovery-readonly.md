# Recuperação — primeira etapa somente leitura

A aba **Cobrança → Recuperação** reúne faturas vencidas e histórico de promessas para conferência humana. Não envia mensagens, não agenda contatos, não altera promessas e não escreve no IXC.

## Fontes e limites

- `GET /api/billing/recovery?page=1&pageSize=20`: exige sessão autenticada e `customer.read`, mesmo quando o login está desabilitado para a demonstração. Exige `FEATURE_IXC_FULL_BASE`; nenhuma flag é alterada pela tela.
- A consulta usa no máximo duas páginas de 500 faturas vencidas do IXC. A paginação HTTP devolve no máximo 50 clientes agrupados por resposta. Os totais de clientes e valores são **do recorte lido**, não da carteira inteira. Não há polling nem consulta de cadastro por linha.
- Valores são somados em centavos, usando `valor_aberto`. Quando o saldo não existe e só há `valor`, o retorno e a tela identificam o uso do valor nominal — ele pode incluir quantias já pagas. Valores inválidos ficam desconhecidos; não viram zero.
- Datas e status são validados. Somente faturas `A` com vencimento anterior à data de Brasília entram. Registros inválidos ou duplicados são excluídos com contagem explícita. Uma resposta parcial não vira posição completa.
- Para os clientes da página, são lidas até 20 promessas recentes de cada cliente, incluindo pendentes, cumpridas e quebradas. É histórico do HUB, **não confirmação fresca do pagamento**. Nada é reclassificado nesta consulta.
- `GET /api/billing/recovery/customer?customerId=123`: mesma sessão/permissão, consulta sob demanda o nome e até cinco contratos. Não devolve documento, telefone, endereço ou credenciais. Usa quatro leituras lógicas do adaptador existente (cadastro, logins, contratos e OS), com a política limitada de retries já existente.
- A constatação positiva de bloqueio exige contrato ativo, código conhecido de bloqueio e desbloqueio de confiança explicitamente inativo (`N` no IXC). Ausência ou código desconhecido desse campo permanece inconclusivo. Situação cadastral e desbloqueio de confiança acompanham o resultado. Não achar bloqueio em cinco contratos **não prova ausência de bloqueio em toda a conta**.
- Respostas HTTP são `private, no-store`; falha no IXC não é dívida zero, e falha no histórico de promessas não é ausência de promessas.

## O que não é inferido

- **Dias em atraso** vêm do vencimento; **dias bloqueado** e início do bloqueio permanecem desconhecidos.
- Não há evidência de contato da IA vinculada à carteira. Uma mensagem enfileirada não comprova envio ou entrega.
- A ordenação por atraso e os motivos de conferência não são score de risco ou previsão de cancelamento.
- Nenhum pagamento é atribuído à atuação da IA ou a uma campanha sem evidência.

## Reconciliação de promessas

O botão existente **Conferir no IXC** agora usa leituras frescas. Uma fatura ausente, erro, fonte parcial, cancelamento ou status desconhecido preserva a promessa e retorna `unverified`. Apenas `R` (recebida, código verificado na integração) cumpre a promessa; `A` vencida após a data prometida permite marcá-la quebrada. A tela e a auditoria mostram conferência incompleta.

A correção não altera retroativamente promessas antes marcadas incorretamente. Essas exigem conferência humana; por isso a nova aba descreve estados concluídos como registros históricos.

## Validação e próximos passos

- Regras, autorização, paginação, falhas, valores, datas, histórico, SQL parametrizado e adaptador IXC falso: `node --experimental-strip-types --test tests/recovery.test.mjs`.
- Reconciliação: `node --experimental-strip-types --test tests/payment-promise.test.mjs`.
- Antes de publicação: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:staging`.
- Próxima etapa de dados: consulta de faturas específicas para promessas fora da página do snapshot, cobertura completa por job controlado e evidência de bloqueio/contato com proveniência. Isso não autoriza disparos, reativação, renegociação ou alterações no ERP.

Publicar exige revisão e autorização próprias: push na `main` dispara deploy automático no Railway.
