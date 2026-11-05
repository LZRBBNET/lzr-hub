# Massa mínima dos três fluxos — preparo sem execução

PR #53 prepara contato/mensagem/desfecho fictícios; #48 prepara contas aditivas; #47 fornece cliente/fatura em memória. Falta régua em banco vazio: usar o fluxo existente da UI/API, sem criar seed SQL paralelo.

Após destino/banco/contas/migrações autorizados e gates da demo validados:

1. Conferir que o alvo é exclusivamente sintético e que não há régua existente a substituir como latest. Se houver, parar e revisar, sem criar versão automaticamente.
2. Usar conta fictícia Cobrança/Supervisor, com senha já trocada. Na UI de régua, salvar uma única vez o conteúdo de isolated-rule-recipe.json. Corpo é aceito pelo parser atual: nome DEMO, uma etapa 1 dia após vencimento, template fictício e canal lógico WhatsApp. Não é template Meta nem autorização de envio.
3. O salvamento cria versão nova; não é idempotente. Se resposta se perder, consultar GET antes de qualquer nova tentativa. Nunca repetir POST automaticamente. Não escrever diretamente nas tabelas para contornar esse fluxo.
4. Manter FEATURE_QUEUES=false e canais/credenciais externos desligados. O provedor #47 tem fatura 901 vencida ontem no momento de sua inicialização. A etapa +1 produz candidato hoje; o ledger só registra dentro de segunda–sexta, 08h–20h em São Paulo. Fora da janela, a recusa é esperada; não mudar relógio do ambiente para contorná-la.
5. Confirmar pagamento somente pela simulação autenticada; reconsulta fresca elimina candidato. Reset da fatura não limpa ledger/promessas; não afirmar que repetir a sessão é campanha nova.

Validação offline local passou: JSON → parseRuleInput real → MemoryCollectionRulesRepository → provider sintético real → candidatos/dispatch com ledger em memória → pagamento → zero candidato. Segunda execução da mesma rodada não duplica ledger; zero enqueue, com guard de rede. O teste respeita a janela comercial ao avaliar recorded. Lint e diff-check OK. Não executa UI/HTTP/login/SQL, não prova persistência real e não comprova idempotência do POST de salvar.

Incorporados #53 e esta receita à candidata privada validation/pr34-53-demo-recipe-20261105, com roteiro consolidado atualizado e pacote fc1a697 preservado. A jornada dos três módulos lê esta mesma receita pelo parser/repositório em memória reais. Próximo passo útil: destino/orçamento autorizados e revisão da aplicação deliberada da massa completa. Execução no banco e demonstração pelo navegador seguem dependentes de destino/custo autorizados. Nenhum banco/serviço/produção/envio/custo/deploy ocorreu nesta preparação.

O primeiro ensaio assumia vencimento no lookup pontual (que retorna só identidade/status); o teste foi corrigido para ler dueAt da fonte fresca da régua. Reexecução focada passou, sem mudança de produto por esse caso.
