# Criação de promessa com evidência fresca

O `POST /api/billing/promises`, com `action: "create"`, registra uma promessa apenas no HUB. A autorização `billing.write-demo` e a validação da data prometida permanecem obrigatórias conforme o fluxo existente. Nenhuma negociação, baixa, mensagem ou escrita no IXC é realizada.

## Evidência exigida

- IDs canônicos de cliente e fatura: strings decimais positivas, sem zeros iniciais, espaços ou notação alternativa, com até 32 dígitos. Referências inválidas são recusadas antes de obter o runtime IXC.
- Uma consulta pontual fresca por tentativa, usando `getInvoiceForCustomer`, com filtros simultâneos de fatura e cliente e no máximo duas linhas para detectar duplicidade. O adaptador mantém seus limites de timeout/retry e a allowlist de clientes.
- Cobertura completa, exatamente uma linha e identidade correspondente, exigidas pelo adaptador. O handler revalida o par cliente/fatura retornado.
- Apenas o status IXC literal `A` permite criar. Não há normalização de código desconhecido nem fallback para snapshot.
- A consulta não lê contratos, conexão ou pagamentos auxiliares, não percorre a base e não depende das primeiras 20 faturas ou do cache do Customer360.

O banco de promessas só é acessado depois dessas verificações. A auditoria de sucesso só é emitida depois da criação. Nenhuma recusa de evidência gera promessa ou auditoria de sucesso.

## Respostas de recusa

- `400`: campos, IDs ou data prometida inválidos.
- `404`: ausência confirmada da fatura no cadastro informado.
- `409`: fatura recebida (`R`) ou cancelada (`C`), portanto não aberta.
- `503`: runtime indisponível, erro de consulta, cobertura parcial, duplicidade, vínculo divergente ou status desconhecido/malformado. A indisponibilidade da fonte não é apresentada como fatura inexistente.

As respostas não incluem conteúdo bruto do IXC, detalhes de erro de transporte ou dados de outro cadastro.

## Limites

A leitura do IXC e a gravação no HUB não formam uma transação atômica. A fatura pode ser recebida ou alterada entre a consulta e a criação. A promessa registra o estado verificado naquela tentativa; não garante que a dívida permaneça aberta depois disso.

A criação não autoriza envio, não cancela trabalhos enfileirados, não pausa a régua e não substitui a conferência posterior. Qualquer consumidor de um job precisa revalidar pagamento e elegibilidade com evidência fresca imediatamente antes de um futuro envio real.

A semântica de autenticação de demonstração foi preservada: com `FEATURE_AUTH=false`, o guard permite criar sem usuário autenticado e a auditoria usa o identificador não identificado. Esta entrega não adiciona a exigência explícita de sessão da ação de revisão à ação de criação. Homologação com dados reais exige `FEATURE_AUTH=true` e permissões adequadas.

Não há mudança de configuração, dependência, esquema, produção ou integração de escrita. A validação automatizada executa o handler real com autorização, banco e auditoria falsos; o adaptador IXC real recebe somente respostas sintéticas em memória. Isso não substitui homologação autenticada com banco real.
