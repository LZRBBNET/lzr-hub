# Status de inicialização sintética

A rota permanece desativada por padrão. Nenhum bootstrap ocorre no build/start.

## Consulta manual autorizada

GET /api/demo/initialize?status=1&databaseOid=<OID aprovado>&attempt=<tentativa aprovada> exige capability no header x-synthetic-init-capability e os gates de demo/init. Nunca colocar capability na URL. OID e tentativa devem corresponder ao alvo previamente aprovado; a consulta não descobre nem autoriza um alvo novo.

Sem autenticação/configuração válida não há conexão. O status usa cliente dedicado em transação REPEATABLE READ READ ONLY, consultas fixas limitadas e timeouts. Não faz lock de escrita, DDL, seed, reset ou retry de escrita. Pode consultar após tentativa consumida e restart, mas nunca concede preflight para POST. Concorrência no controller é recusada enquanto outra operação está em andamento.

- absence-observed: catálogo vazio observado no snapshot; não autoriza replay.
- reservation-observed: marcador único da tentativa/manifesto esperado, sem objetos adicionais.
- completion-observed: reserva/conclusão consistentes e journal com hashes/timestamps das migrações pinadas.
- unknown/503: inconsistência ou falha de consulta, COMMIT ou descarte do cliente.

retryAllowed=false e credentialsVerified=false sempre. expectedManifestSha256 identifica o manifesto esperado, não contém SQL ou credenciais. O status não prova senha, origem do banco, integridade integral de dados/schema ou ausência de transação concorrente futura. Ausência observada pode preceder outro commit em andamento. Não repetir escrita após resultado incerto.

## Host interno sem expor conexão

No recurso PostgreSQL descartável previamente autorizado, conferir workspace/região e abrir Info → detalhes internos individuais → Hostname. Ler somente o hostname, sem copiar URL completa, senha ou DATABASE_URL. Não usar recuperação de connection-info sensível para essa tarefa.

Comparar o hostname independente com SYNTHETIC_INIT_DATABASE_HOST. O driver valida sua igualdade com o host da URI gerenciada antes de conectar e usa parâmetros explícitos, sem fallback PG*. O status retorna somente targetHostMatches=true após comparação local; não devolve hostname ou conexão. Isso não comprova rede/TLS nem isolamento real. Configuração futura pode usar fromDatabase/property:host; não é aplicada por este patch.

Referência: https://render.com/docs/postgresql-creating-connecting#internal-connections. A documentação apresenta detalhes individuais e URL na página Info; conexão interna exige mesma conta/região. O driver atual usa ssl=false para conexão interna, sujeito à revisão de rede/TLS antes da operação real.

## Sequência de aplicação

1. Revisar este patch sobre a candidata sintética; manter init desativado e integrações/envios desligados.
2. Confirmar fora do código o recurso descartável, hostname, OID e tentativa aprovados, acesso privado e estratégia TLS.
3. Publicar código somente em branch com deploy/previews automáticos desligados. Publicação de PR não autoriza implantação.
4. Mediante autorização separada, implantar manualmente a candidata revisada. Conferir configuração efetiva sem imprimir valores sensíveis.
5. Habilitar a janela privilegiada somente com capability/material individuais fornecidos por canal privado e aprovação específica. O patch não gera credenciais nem altera configuração.
6. Após resposta incerta, usar somente a consulta de status acima e reconciliar; nunca repetir POST automaticamente. Desabilitar janela privilegiada após a operação conforme aprovação.

## Validação e limites

30 testes focados e 1 smoke do artefato, build Node, typecheck, lint e diff-check passaram. Simuladores cobrem resposta de COMMIT perdida, restart, concorrência local, disposal incerto, reserva com objetos extras e marcadores/journal/catálogos inconsistentes. Sem PostgreSQL, navegador ou rede reais. Testes em memória não comprovam sintaxe/semântica SQL, snapshot, bloqueios, concorrência entre processos ou durabilidade reais. Homologação real exige autorização própria.
