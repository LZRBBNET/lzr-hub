# Pedido explícito de atendente — Meta

Base: 97db6a6. Atalho determinístico no POST Meta, após captura de geração e antes de carregar templates, iniciar triagem/identificação, consultar IXC, CRM, modelo/n8n ou autosserviço. Não é alteração do endpoint n8n separado.

Reconhece pedidos diretos como “quero falar com um atendente” e a opção interativa oficial `menu-9` definida em TRIAGE_MENU. O parser preserva o ID de list_reply; texto numérico sem menu não recebe essa autoridade. Reconhecimento textual conservador: negação, citação e mera menção a atendimento não bastam. Não é compreensão geral de linguagem; frases não reconhecidas continuam no fluxo anterior. Pedido explícito seguido de documento é tratado sem consulta ou divulgação de conta; a entrada permanece no histórico e a confirmação nunca repete documento.

Preserva inbound antes da transferência; abre/continua protocolo sem identificação. A transição durável mantém o setor corrente na própria instrução SQL e preenche Atendimento apenas quando nulo. Não altera responsável, ficha, autenticação ou dados IXC. Confirmação só depois de etapa e auditoria persistidas, com a autorização distinta de handoff e janela Meta já existentes. O texto confirma o registro, sem disponibilidade imediata ou prazo. Falha de notificação mantém o atendimento na fila; retry não cria autorização nova. Falha de persistência propaga ao isolamento do lote (503); não marca sucesso.

Validação local: 89 testes na seleção de regressão passaram; depois, os cinco testes específicos passaram, incluindo o novo caso do ID interativo versus número digitado. PostgreSQL 17.12 isolado, sem rede, com 25 migrações locais: 13 testes incluindo suíte passaram. Novo caso usa repositórios reais e sender com fetcher local para primeiro contato sem CPF, registro anterior ao aceite, geração de protocolo, duplicata sem reenvio e janela vencida sem transporte. Memória cobre preservação de setor/ficha/protocolo, falha da confirmação e da transição. TypeScript, ESLint direcionado e diff passaram.

Nenhuma consulta privada, credencial de produção, chamada de provedor, OS, mensagem real, migração externa, merge ou deploy. Não comprova disponibilidade da equipe ou entrega ao cliente. A integração real Meta/IA/IXC não foi exercitada; o atalho não tem dependências de lookup/modelo. Requisitos de ativação conjunta dos workers do fence continuam válidos.

## Ajuste focalizado de intake e saída

Pedidos curtos “quero atendente” e “quero um atendente” são aceitos. A avaliação por oração distingue negativas do pedido de problemas relatados em outra oração (“sem internet”, “não funciona”). Negativas diretas e cancelamento posterior do pedido continuam recusados; números soltos e citações não ganham significado de botão.

Estado aberto com responsável atribuído já é atendimento humano, mesmo sem stage=handoff: preserva o inbound e registra resultado idempotente sem tentar transição que exige geração IA, sem despacho, sem mudar setor ou protocolo. A leitura usa o repositório de estado local, sem identificar conta ou consultar integrações. Ausência de estado é normal no primeiro contato.

Confirmação deste atalho exige explicitamente FEATURE_N8N_AUTOREPLY=true, a flag existente de resposta automática. Sem ela, inclusive quando só o modo AI_AGENT está ligado, o pedido continua registrado e não recebe confirmação automática por este ramo. Isso é intencionalmente mais restrito e não depende de configurar n8n. Nenhuma flag real foi lida para diagnóstico ou alterada. O sender ainda aplica janela, idempotência e fence quando a confirmação está habilitada.

Validação: 92 testes da seleção de regressão passaram; os sete específicos passaram após o ajuste de negativas por oração. PostgreSQL isolado cobre também atribuição humana sem handoff, preservação de setor/protocolo e retry sem transporte. TypeScript detectou inicialmente a ausência normal do estado no primeiro contato; o acesso foi corrigido e a suíte PostgreSQL reexecutada. Sem validação operacional.
