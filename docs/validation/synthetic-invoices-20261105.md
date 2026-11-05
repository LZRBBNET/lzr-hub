# Fonte de faturas para demonstração isolada

Incremental sobre #45, sem deploy, configuração real, migração ou credencial nova. Fonte totalmente em memória com o adaptador readonly existente e transporte fixo que apenas devolve fixtures locais. Nenhum fallback HTTP. Cliente 10/fatura 901/contrato 501 são inventados e não são selecionáveis pelo usuário.

## Ativação estrita

Exige simultaneamente FEATURE_SYNTHETIC_INVOICES=true, DEMO_DATASET=isolated-invoices-v1, LZR_ENV=staging, NEXT_PUBLIC_LZR_ENV=staging, LZR_RUNTIME_MODE=mock, FEATURE_AUTH=true, PILOT_MODE=disabled, IXC_MODE=disabled, IXC_TRANSPORT=disabled e FEATURE_IXC_FULL_BASE=false.

Exige false explícito em FEATURE_IXC_WRITE, IXC_WRITE_ENABLED, FEATURE_QUEUES, FEATURE_META_WHATSAPP, FEATURE_N8N_CHANNEL, FEATURE_N8N_AUTOREPLY, FEATURE_ATTENDANT_REPLY, FEATURE_EVOLUTION, FEATURE_CHATWOOT, FEATURE_LANGFUSE, FEATURE_LLM_INTENT, FEATURE_COPILOT_LLM e FEATURE_TELEGRAM_ALERTS. Recusa as credenciais externas conhecidas enumeradas no módulo. A lista não é detector universal de secrets; o transporte em memória não usa credenciais.

Valor ausente/inválido, produção ou runtime divergente bloqueiam a criação. Referências já obtidas revalidam o gate antes de cada método, incluindo leitura de snapshot em cache e simulação de pagamento. O gate é explícito mesmo em chamada direta ao endpoint de demo. Nenhuma variável foi configurada nesta entrega.

## Jornada

getIxcRuntime seleciona a fonte sintética antes de qualquer criação de transporte real e fixa allowlist em 10, sem base inteira. Customer 360 usa a mesma fonte, com mode=demo e rótulos “Fonte sintética”/“DEMO sintética”, sem declarar dados reais de IXC.

A fatura nasce aberta, valor fictício 50, vencida ontem no dia de negócio. O handler existente de promessa pode consultar essa fatura fresca e persistir a promessa no PostgreSQL sintético configurado pela equipe. POST /api/demo/invoices exige sessão e billing.write-demo; aceita somente {"action":"simulate_payment","invoiceId":"901"}. Marca R apenas em memória, invalida snapshot e é idempotente. Não recebe destinatário, token ou valor e não produz recibo financeiro real. A próxima consulta da régua exclui a fatura; a conferência existente pode cumprir a promessa. Sem botão novo na UI nesta entrega; o endpoint é um controle de homologação autenticado.

## Revisão e testes

Revisão separada do diff de segurança/dados: verificados ativação em produção, flags ausentes, instância cacheada, identidade exata, superfície do endpoint, rótulos e ausência de transporte real/credenciais privadas. O teste inicial corrigiu uma expectativa de undefined versus null e o typecheck corrigiu tratamento de RequestInfo; não são falhas de produto pré-existente. Nenhum bloqueador de segurança remanescente identificado no escopo testado.

32 cenários novos cobrem gates, produção, credenciais fictícias, pagamento idempotente, snapshot invalidado, fatura inexistente/cliente fora de escopo, promessa/reconciliação/régua, endpoint recusado antes de auth fora do modo e negação sem pagamento, Customer 360 rotulado e gate após troca para produção. Guard de transporte offline em todos os testes. Testes de papel/sessão do #45 e criação real do #39 complementam a fonte; o teste de endpoint injeta autorização sintética, não cookie/SQL reais.

## Limites antes de disponibilizar

Estado da fatura é por processo, perdido no restart e não compartilhado entre réplicas. Não alegar persistência durável/atômica nem simulação consistente multi-instância. Começar a demo requer processo isolado único e reset por restart deliberado; não há endpoint para reabrir dívida. Não há Redis ou envio; jobs já enfileirados continuam exigindo o guard do #40 na composição.

Sessão, promessas e demais tabelas continuam exigindo PostgreSQL exclusivamente sintético, migrações compatíveis e contas fictícias. Este código não cria banco/login e não executa o seed D1 legado. Nenhum ambiente Railway pendente é aplicado. O Customer 360 mantém os outros módulos sintéticos disponíveis/indisponíveis conforme fixtures, sem diagnóstico real.

Próxima ação: compor este PR com #40/#41/#42/#43/#44, repetir a jornada com guard/resolver reais e validar login e persistência no candidato isolado autorizado. Publicação/provisionamento, múltiplas réplicas, navegador, PostgreSQL real e integração externa continuam fora desta entrega. Manter draft, sem merge/deploy.

Resultados finais: 1094/1094 agregados e 102/102 focados; build/artefato, lint, typecheck, diff-check e build staging com 25/25 passaram. Agregada permitida exclui cinco testes ixc-http que abrem sockets. Logs locais /tmp/lzr-synthetic-demo-{focused,suite,build,lint,typecheck,staging}.log. Resultados locais, sem afirmar CI remoto aprovado.
