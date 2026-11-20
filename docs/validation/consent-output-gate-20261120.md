# SAIR/VOLTAR — controle de confirmação

Base 6532fb8. Os comandos agora são tratados antes de captura do fence, triagem, lookup IXC e IA. Inbound, alteração de consentimento, auditoria de aplicação e recibo `consent:<inbound>` ficam na mesma transação. Não há mais catch que ignore falha de consentimento; falhas propagam ao lote e exigem retry (503).

A confirmação exige FEATURE_N8N_AUTOREPLY=true e passa pelo sender com fence, idempotência e janela existentes. Flag off não pausa ingresso nem invalida consentimento; audita `whatsapp.consent.confirmation` com resultado `suppressed`. A decisão de permitir confirmação fica no recibo: uma entrada originalmente suprimida não envia depois só porque houve retry e a flag mudou. O recibo também evita reaplicar comando antigo após comando posterior. Não apaga idempotência nem promete entrega. Não resolve ordenação de comandos diferentes que chegam fora de ordem pelo provedor.

Revisão dos demais caminhos (não alterados):
- Pedido explícito de humano: confirmação já usa FEATURE_N8N_AUTOREPLY.
- Respostas normais Meta: botSpeaks/doubtBotConfig permitem outros caminhos com FEATURE_OFF_HOURS_AUTOREPLY, FEATURE_AI_AGENT e FEATURE_N8N_BOT. FEATURE_N8N_AUTOREPLY isoladamente NÃO é interruptor global de toda automação.
- Envio manual: FEATURE_ATTENDANT_REPLY, categoria distinta.
- Jobs de templates em app/api/jobs/outbound/route.ts: FEATURE_BILLING_REMINDERS / FEATURE_NETWORK_NOTICES e dryRun, categoria distinta. Runtime de filas/campanhas e remetentes externos exigem inventário operacional próprio; não foram alterados ou certificados.

Validação offline: 39 testes passaram (5 novos de consentimento), TypeScript, ESLint direcionado e diff passaram. Casos: SAIR/VOLTAR com flag off, auditoria suprimida, duplicata, falha de consentimento, falha de envio, retry antigo após decisão posterior e supressão preservada após falha de auditoria. Os repositórios dos testes são em memória; esta revisão NÃO executou PostgreSQL nem prova rollback/concorrrência em banco real. A transação real da rota foi revisada e checada por tipos; sem migração nova.

Nenhuma flag real, produção, credencial, dado pessoal, envio, IXC/n8n, merge ou deploy foi acessado/alterado. A lacuna específica SAIR/VOLTAR foi corrigida; demais gates do piloto (topologia, workers uniformes, pausa integral, responsáveis e reconciliação) permanecem.
