# Resumo de encaminhamento humano

Base: `a0f7048a771222e495ffccaecd00c9635539e23b`, branch `fix/customer360-readonly-20261103`. Os 380 blobs da base foram conferidos contra o GitHub antes da alteração. Este incremento é isolado; não incorpora os demais candidatos de homologação.

## Correção

- O resumo existente do Copiloto passa a ler motivo, contexto e responsável no servidor, preservando `customer.read` e o filtro por canal/conversa.
- O motivo é uma recomendação registrada de encaminhamento, não prova de que alguém recebeu ou assumiu o caso.
- O responsável vem do estado persistido. Sem atribuição, isso fica explícito. Uma mensagem posterior à resolução reabre o caso sem herdar o responsável antigo.
- Mensagens de atendentes, da IA, de autoria desconhecida e sugestões não enviadas ficam distintas. Registro de resposta não é apresentado como recibo de entrega.
- A consulta busca até 201 mensagens, resume no máximo 200 e avisa quando o histórico é parcial.
- Os quatro motivos recentes do pipeline passam a ser aceitos pelo cadastro de equipes e exibidos com rótulos legíveis.

## Evidências de 05/11/2026

- Regressão antes da correção: 9 testes novos falharam por ausência de motivo/responsável, autoria incorreta, contexto parcial e motivos não cadastráveis.
- 68 testes focados passaram, incluindo o fluxo simulado: cliente pede humano, motivo é gravado em memória, resumo exibe pendência, atendente fictício assume e novo resumo mostra o responsável. Repetição da mesma entrada não duplica o caso. Zero chamadas externas ou envios nesse teste.
- Typecheck e lint de toda a aplicação passaram.
- Build verificado e validação do artefato passaram.
- `npm run test:staging`: 25/25 testes passaram com build mock de staging, sem publicação de ambiente.
- Suíte agregada sem sockets: 897 testes passaram, zero falhas ou skips. Os cinco testes de `tests/ixc-http.test.mjs` foram excluídos desta rodada porque abrem um servidor/socket local. Isso não equivale à execução integral de `npm test`.
- Revisão independente: corrigida uma frase que sugeria obrigação humana sem evidência; nenhum bloqueio remanescente identificado. Cobertura inclui falhas de cada leitura, histórico vazio, 200/201 mensagens e reabertura.

## Limites

Não implementa roteamento automático, escolha de equipe ou atribuição automática. As equipes continuam sendo cadastro de responsabilidade e relatório. A tomada de responsabilidade usa a ação humana já existente.

Não houve teste HTTP autenticado com PostgreSQL nem validação visual em navegador. As leituras do resumo não constituem snapshot transacional: o estado pode mudar depois de ser consultado. A integração e a revisão visual em ambiente isolado seguem necessárias antes de considerar publicação em produção.

Sem migração, alteração de dependências, flags, autenticação, envio WhatsApp ou escrita no IXC. Nenhum merge ou deploy faz parte desta entrega. Exemplos e testes adicionados usam dados fictícios.
