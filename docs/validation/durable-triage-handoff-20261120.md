# Encaminhamento humano durável — corte receptivo

Base revisada: main c064ed6. Railway informa deployment eaeef31f-7edb-4e33-be24-c5459e442630 SUCCESS, criado em 18/11/2026 às 17:52 UTC, no mesmo SHA. O histórico incorporou funcionalidade equivalente aos PRs antigos de OS/reply por outros commits: não reaplicamos #108. Nenhum AGENTS.md ou .agents/skills foi encontrado na árvore versionada/ancestrais deste checkout. Branch isolada fix/durable-triage-handoff; nenhuma implantação ou migração.

## Defeito e alteração

recordTriage condicionava stage=handoff à entrega da confirmação; triageHooks.record engolia falha de persistência. doubtBotTurn e triageTurn informavam handoff=false no resultado mesmo depois de decidir encaminhar. registerRequest publicava o intake em memória antes do banco e o chamador ignorava erro, permitindo dizer “registrado” sem registro. O modo autônomo seguia conversando após handoff.

Agora a fila/etapa é persistida e auditada antes da tentativa de confirmação e antes da abertura de OS nesse caminho. A falha de contexto/encaminhamento aborta antes dessas ações; não há resposta dizendo que foi encaminhado. O update de handoff exige atendimento aberto e RETURNING de exatamente uma linha. A memória do turno só muda após o banco confirmar. A entrega Meta não controla a etapa humana nem sua auditoria.

Entradas posteriores com handoff registrado são anexadas ao histórico e à idempotência sem chamar classificador, modelo n8n, autoatendimento, OS ou sender. Só a devolução explícita à IA existente retoma o robô. O turno que registra o pedido pode executar a abertura de OS já existente, depois de persistir o fallback humano; este patch não habilita flags nem muda assunto/setor/contrato. Não executamos esse caminho.

Auditoria distingue whatsapp.handoff.recorded, whatsapp.handoff.failed e whatsapp.handoff.waiting. Os eventos de entrega/erro do sender permanecem separados. Fila registrada não significa humano/técnico avisado ou que assumiu; OS retornada pelo IXC não significa despacho/entrega. Não há nova notificação de técnico.

## Evidência operacional limitada

Consulta delimitada dos logs HTTP de serviço encontrou 50 POST /api/channels/meta com status 200 em 18/11 entre 14:30 e 14:38 UTC (deploy anterior à instância atual). Isso prova aceite HTTP, não classificação correta, OS criada, transferência persistida ou recibo de entrega. Na amostra delimitada da instância atual (101 registros runtime e 101 HTTP), não apareceram eventos operacionais dos três endpoints examinados nem marcadores de handoff/n8n/ixc. Ausência na amostra não prova ausência de operações globais.

Nenhum payload de conversa, endereço, chave, variável secreta ou backup de atendentes foi acessado/exposto. O n8n não tem conector autorizado disponível neste executor; o workflow versionado e a configuração OpenAI relatada pelo proprietário não comprovam publicação/ativação do fluxo. Não chamamos o webhook/modelo para testar.

## Lacunas adicionais comprovadas, fora deste delta

- ai-service-order.ts escolhe um contrato ativo único dentro de data.contracts; getServiceDiagnosis lê no máximo 5 contratos e 5 logins, sem evidência de cobertura completa. Isso não prova unicidade no cadastro completo. Também há fallback para único login sem comprovar vínculo ao contrato. Necessita validação exata/seleção inequívoca antes de liberar OS autônoma para cadastros ambíguos.
- O mesmo diagnóstico lê 20 OS e retorna a primeira aberta, sem contrato no DTO retornado. Existente não é prova de OS pertinente ao contrato/assunto atual, e ausência em amostra não comprova inexistência.
- A fila humana não fornece recibo de aceite por técnico. Publicar uma fila não é notificar/atribuir técnico.
- A reserva permanente de cliente/assunto herdada ainda exige reconciliação auditada antes de futuras OS no mesmo escopo. Não limpar reservas nem repetir a OS antiga.
- Uma leitura de stage no começo do turno não serializa mensagens concorrentes já em andamento; não há garantia de transação distribuída banco/Meta/IXC. Confirmar comportamento de concorrência em revisão separada antes de broad rollout.

## Validação e gate da primeira entrada real

No commit inicial 272527b, somente checagens estáticas. Na revisão seguinte, autorizada para checagens isoladas, foram executados testes locais em memória e compilação de SQL, além de TypeScript, ESLint direcionado e diff. Nenhum seed, atendimento, mensagem ou OS foi criado em sistema conectado.

Antes de liberar uma entrada real: revisar/implantar este delta separadamente com aprovação; confirmar workflow n8n publicado e apontado para o endpoint de produção correto, fila humana e responsável efetivamente monitorando, política de OS/contrato/assunto/setor autorizada, e evidência de cobertura/vínculo para seleção automática. Observar uma entrada espontânea autorizada e reconciliar, por correlação, registro de fila, ID de OS (se houver), aceite de encaminhamento e recibo de entrega Meta separadamente. Não usar a OS antiga do ID 61585 como novo teste. Nada desta etapa altera flags ou libera broad rollout.

## Indisponibilidade de IA: segunda etapa

askDoubtBot faz uma única chamada com timeout; HTTP não 2xx vira falha com apenas o status, sem ler código estruturado do provedor. Resposta vazia/inválida também vira falha. doubtBotTurn audita whatsapp.doubtbot.failed e retorna ao pipeline determinístico existente. Não há retentativa interna nessa chamada, mas novas entradas podem tentar o modelo novamente enquanto não houver handoff. O contrato atual não comprova que o n8n propaga credit_balance_exhausted.

Próximo ajuste precisa definir e confirmar no workflow publicado um sinal sanitizado de indisponibilidade, distinguindo esgotamento de crédito de limite temporário. Esse sinal deve persistir contexto e encaminhamento humano, suspender novas tentativas automáticas até recuperação explícita e usar confirmação aprovada somente após persistência. O fallback existente não é prova de que toda falha de IA encaminha ao humano. Nenhuma chave, saldo ou configuração de cobrança foi consultada.

## Revisão das transições e recuperação

- updateTriage usa UPDATE condicional de atendimento aberto e, para decisões comuns, stage diferente de handoff. A condição é avaliada sobre a linha no PostgreSQL; snapshot antigo não pode substituir encaminhamento/queue por routed ou clarifying. A atualização recusada não é copiada para a memória. Handoff recusado falha antes de confirmação.
- Depois de um encaminhamento já registrado, a gravação pós-envio é deliveryOnly: pode guardar o instante de informação do protocolo, mas nunca etapa, assunto ou fila. Assim uma devolução humana durante o envio não é desfeita ao concluir o turno.
- A ação release faz CAS e auditoria mesmo se a conversa já estiver aberta/sem responsável. A rota executa conversa/auditoria e UPDATE condicional handoff → routed na mesma transação; erro de retomada/COMMIT propaga como 503 unconfirmed. Retry idempotente executa a retomada novamente. Reopen só retoma quando realmente altera a conversa. A trava existente de entrega continua rejeitando uma liberação enquanto houver envio reservado.
- O inbound passa a ser salvo antes da decisão de encaminhamento com ID determinístico por canal/conversa/evento e conflito ignorado na PK existente, sem migração. O duplo em memória segue a mesma deduplicação. Mensagens legadas com ID aleatório não são migradas por este patch.
- Se a auditoria falhar após salvar handoff, o retry suspenso preserva/deduplica inbound e grava whatsapp.handoff.waiting antes da idempotência. Esse evento comprova recuperação do estado persistido, não o instante, causa ou autoria da decisão original. Auditoria é ao menos uma vez e pode repetir se houver falha antes de salvar a idempotência; não alegamos atomicidade entre handoff e auditoria original. Sem retry, a lacuna de auditoria original permanece reconciliável pelo estado e inbound, mas não é preenchida automaticamente.

Validação focal cobre snapshots concorrentes de routed/clarifying, devolução durante sender local, release em conversa já livre, falha e retry de retomada, falha de auditoria após handoff, deduplicação de inbound e condições SQL reais compiladas com pg-proxy sem rede. Isso não substitui ensaio de concorrência em PostgreSQL: nenhum PostgreSQL isolado foi fornecido/usado. Mensagens já em voo antes da decisão inicial continuam sendo limite separado; não há serialização integral de turnos ou novo mecanismo de versão neste delta. A rota n8n de sugestões e contingência de IA continuam fora deste PR.
