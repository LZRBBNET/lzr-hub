# Revisão de promessas com evidência confirmada

Base: `2bb0e90b367f471e04500759a78915569b1450b1` (#95). A reprodução pela rota real, com provider fictício lançando erro, marcou promessas ativa e expirada como `fulfilled`; a regressão esperava ambas `pending` e falhou antes da correção.

A revisão agora força uma nova leitura pelo provider existente, exige snapshot sem cache, com instante observado durante a solicitação, cobertura completa/coerente de faturas e identidades sem duplicação dentro do cliente correto. A evidência é avaliada separadamente por cliente. Não foi adicionada operação IXC ou transporte.

- `R` e saldo explicitamente `open-balance` igual a zero: recebida confirmada, permite cumprir.
- `A` e saldo aberto confirmado positivo: preserva a regra existente; pendente inclusive no dia prometido, quebrada após esse dia.
- Ausência, erro, cache antigo, resposta parcial, saldo desconhecido, `C`, `P` ou código desconhecido: mantém pendente. Cancelamento não é confirmação de pagamento. Não há coerção de chave ausente/mapa vazio para quitação.

A rota revalida a autorização e a identidade do ator após as leituras e antes de persistir. Ela não implementa transação distribuída: leitura de fatura e atualização da promessa não são atômicas, nem há bloqueio de sessão cobrindo todas as escritas. A listagem completa pode ser inconclusiva para clientes além do limite do snapshot; nesse caso a revisão conserva o estado. O contrato de `fetchedAt` pertence ao provider confiável, não a dados enviados pelo cliente.

**Pendência não é pausa indefinida.** A pausa continua até o fim da data prometida em Brasília; promessa expirada mantida pendente por falta de evidência pode deixar de pausar pela regra já existente. Esta correção não cria uma nova régua ou retomada automática.

O teste usa a rota compilada, repositório em memória, autorização e provider injetados, sem rede. A suite de pausa compartilhada é executada para conferir que os dois estados de acesso e a expiração continuam iguais. Esses testes não comprovam banco real, autorização ponta a ponta ou entrega de mensagem.

O achado de promessa falsamente cumprida da matriz `collection-calendar-audit.md` fica corrigido nesta candidata. O worker padrão continuar sem usar o consumidor protegido permanece pendência distinta; não foi conectado ou ativado. A criação de promessas e a configuração comercial não foram alteradas.
