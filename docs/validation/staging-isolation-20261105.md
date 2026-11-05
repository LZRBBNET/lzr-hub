# Staging: neutralizar flags herdadas

## Problema e correção

Revisão de BBN-5 / Issue #27 sobre a base `a0f7048a771222e495ffccaecd00c9635539e23b`, árvore `b3964d6b8749bcf690b0944fc4d46383f51f915b`. A Issue #27 está fechada no GitHub, mas BBN-5 permanece em backlog; esta correção é preparação adicional, não comprovação de publicação.

O wrapper de staging preservava flags herdadas do canal n8n, resposta automática, envio de atendente, classificador LLM, redator do Copiloto e alertas Telegram. Parte desses caminhos também faltava no validador. `LZR_RUNTIME_MODE=mock` sozinho não desliga os configuradores LLM.

A correção:

- fixa as seis flags em `false` no processo filho do wrapper;
- exige as cinco flags faltantes no validador da demo;
- completa `.env.staging.example`;
- inclui os novos testes em `npm run test:staging`;
- corrige o runbook para separar diagnóstico de health, configuração de runtime e proteção de acesso.

Não altera a implementação de Copiloto, autenticação, credenciais, serviços de envio ou banco. Nenhuma variável de um ambiente implantado foi modificada.

## Evidência local

- Antes: 12 falhas em 14 testes novos.
- Depois: 14/14 novos; 39/39 em `test:staging`, incluindo build e validação do artefato; 890/890 agregados sem sockets; lint e typecheck passaram.
- A agregada exclui os cinco testes de `tests/ixc-http.test.mjs`, que abrem socket. Não é execução integral de `npm test`.
- Revisor independente repetiu 14/14 e não encontrou bloqueador. A recomendação de incluir os novos testes na suíte específica de staging foi atendida.
- Fixtures de ambiente explícitas e uma chave LLM fictícia, sem uso de secrets reais. Os subprocessos de teste recebem ambiente mínimo e apenas leem variáveis/produzem stdout. Não iniciam serviços, não conectam banco e não chamam provedores.
- O processo principal de teste/build usa barreira de rede/socket. Essa barreira não é herdada pelos subprocessos com ambiente limpo; esses executam somente os snippets fixos descritos acima. O build utiliza resolução fictícia de localhost para carregar o Vite, sem iniciar servidor.
- Nenhum preview, Site, deploy, HTTP de produção ou mensagem real foi executado.

## Riscos que permanecem antes de piloto

1. `FEATURE_AUTH` ausente ou diferente de `true` libera o guard sem identidade. Mock e `PILOT_MODE=internal` não comprovam login, RBAC ou restrição de acesso. A correção não altera essa escolha de autenticação.
2. O wrapper não remove secrets herdados nem comprova que o banco é sintético. Crie um ambiente isolado sem credenciais de serviços reais e verifique seu destino antes de qualquer teste integrado.
3. Executar `build:staging` não configura automaticamente o processo que servirá o artefato. O runtime precisa receber explicitamente as mesmas flags.
4. Health `degraded` é diagnóstico, não uma barreira global nem prova de ausência de saída de rede. Não exponha a demo em caso de configuração inválida.
5. Acesso autorizado/negado, cookies e sessão no navegador, PostgreSQL isolado e os controles externos do deployment ainda precisam de homologação própria. Esta rodada não verificou configuração atual de produção ou de um staging publicado.

Entrega deve permanecer em draft, sem merge/deploy. A publicação protegida de BBN-5 não está concluída por esta correção.
