# Resposta manual com resultado incerto

Hotfix baseado em `57ad19b52cc99fb248005050f0b9d653aae2ec71`.

O transporte pode aceitar a mensagem antes de a resposta HTTP chegar. Antes do hotfix, falha de conexão liberava a reserva; a reprodução com fetch injetado enviou duas vezes usando a mesma chave. A interface também gerava outra chave a cada clique.

Agora a reserva existente permanece bloqueada em timeout, erro de conexão e resposta ambígua. A interface grava apenas um UUID sob identificador derivado da conversa no armazenamento local antes do POST (sem texto ou telefone em claro), impede clique simultâneo e usa Web Locks sem enfileirar uma segunda ação. Navegador sem Web Locks/armazenamento disponível recusa iniciar envio. Durante incerteza, clique subsequente consulta a tentativa; não envia novamente. Após recarregar, “Verificar envio anterior” funciona sem reconstituir o texto.

`GET /api/conversations/reply?conversationId=...&idempotencyKey=...` exige sessão e `support.write`, usa `no-store` e consulta a reserva por chave, canal e conversa. Não libera reserva nem chama a Meta. `absent`, `pending` e `unknown` não autorizam novo envio. `sent` comprova somente aceitação registrada; não comprova histórico completo nem entrega. A consulta não repara atribuição ao atendente nem histórico interrompido. Esses casos exigem reconciliação operacional antes de seguir o fluxo real.

Recusa comprovada antes do envio ou rejeição definitiva com liberação confirmada permite corrigir o rascunho. Resultados incertos não são apresentados como “Nada foi enviado”. Não limpar o armazenamento para destravar: isso elimina a referência de recuperação. Não há garantia de exactly-once entre dispositivos, outros perfis, armazenamento apagado ou abas com rascunho antigo após uma tentativa já resolvida. Não há nova restrição de destinatário piloto; a flag de respostas continua global.

## Publicação e piloto

Sem migrações, novas variáveis, alteração de flags, transporte ou schema. Publicar exige revisão do SHA final e do delta contra a versão vigente. O launcher atual executa migrador: confirmar que não há migrações novas ou pendentes antes do deploy; não executar migração às cegas. Preservar versão anterior para rollback, sem apagar reservas existentes. Rollback da aplicação remove as proteções novas: não retomar envios incertos com cliente antigo.

Pré-condições ainda externas: acesso oficial ao hostname, identidade exata cliente/contrato/telefone e escopo de envio do piloto; nenhum desses é provado por fixtures. Homologar HTTPS autenticado com envio delimitado somente depois dessas confirmações. Não associar telefone legado por normalização. Testes locais usam fetch e persistência em memória; não comprovam banco real, navegador real ou entrega Meta.
