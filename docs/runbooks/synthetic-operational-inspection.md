# Inspeção operacional somente leitura (preparação, desligada por padrão)

Este comando não é primeiro acesso e nunca autoriza inicialização. Não está ligado a
package scripts, builds, Start Command ou workflow. Nenhuma rota HTTP foi criada.
Publicação, configuração, deploy e leitura remota exigem autorização específica.

## Autoridade e alvo

A identidade do operador é a conta autenticada com permissão de configuração/deploy
na plataforma. Variáveis de ambiente e IDs de execução não provam identidade. Antes
da operação, o operador confere serviço, recurso de banco privado e vínculo entre
eles por metadados confiáveis da plataforma. O programa só verifica consistência do
binding com os parâmetros aprovados; não descobre nem comprova esse vínculo externo.
Não imprimir/copiar URL, usuário, senha ou conteúdo de tabelas. Parâmetros privados
não pertencem ao repositório, argv ou relatório.

Dois modos independentes (nunca sequência automática):

1. `identify`: requer host, banco e usuário aprovados; não aceita OID esperado. Em
   transação RO, consulta somente identidade, sem tabelas da aplicação. Retorna OID
   decimal como única exceção aos estados/booleanos sanitizados. O operador precisa
   conferir e aprovar esse OID para outra operação. Descoberta não é pin independente.
2. `inspect`: exige OID explicitamente aprovado, além do mesmo vínculo. Observa
   catálogo, marcadores limitados e journal fixo; não lê contas ou hashes de senha.
   Reserva/conclusão de tentativa desconhecida permanecem estruturais e não
   reconciliadas com o titular. Ausência vale apenas para o snapshot. Divergência,
   cardinalidade excessiva ou formato não esperado resultam em `unknown`.

Nenhum resultado prova senha, login, titular ou permissão para escrever. Nunca limpar
marcadores, migrar, seedar, criar conta ou repetir inicialização para inspecionar.

## Configuração futura (não aplicada)

Commit exato revisado e artefato Node sintético construído pelo launcher existente.
Start Command proposto:

```
node --experimental-strip-types scripts/synthetic-inspect-start.mjs
```

Manter `SYNTHETIC_INIT_ENABLED=false`, `SYNTHETIC_BROWSER_SETUP_ENABLED=false`, hash e
prazo de inicialização ausentes. Todas as guardas sintéticas, autenticação e flags de
transportes externos continuam obrigatórias. `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS`
são recusados; não remover configurações existentes sem revisão e autorização.
O binding privado já existente é consumido só em memória. Sem fallback PG/env/URL,
sem pool e sem credencial nova. Transporte é o TCP privado já usado pelo alvo
sintético existente, sem TLS (não é autorização para banco público ou outro alvo).

Parâmetros da operação, todos separados da inicialização:

- `SYNTHETIC_RO_INSPECTION_ENABLED=true` (ausente/false não inspeciona).
- `SYNTHETIC_RO_INSPECTION_MODE=identify` ou `inspect`.
- `SYNTHETIC_RO_INSPECTION_NOT_BEFORE` e `SYNTHETIC_RO_INSPECTION_EXPIRES_AT`: UTC ISO
  absoluto, intervalo positivo de no máximo 10 minutos; nunca renovado no startup.
- `SYNTHETIC_RO_INSPECTION_EXPECTED_HOST`, `..._DATABASE`, `..._USER`: valores privados
  aprovados, comparados exatamente ao binding; porta fixa 5432, URL sem query.
- `SYNTHETIC_RO_INSPECTION_EXPECTED_OID`: ausente em identify, obrigatório em inspect.

A conexão dedicada inicia com default_transaction_read_only=on. A transação é
REPEATABLE READ READ ONLY, search_path=pg_catalog, statement_timeout=3s e lock_timeout=1s.
SQL é fixo; não aceita comandos do operador. Processo filho descarta stdout/stderr;
resultado passa por projeção fechada IPC e só sai após encerramento do filho.

Orçamento total pretendido de 20s: término forçado do filho é solicitado até 19s
(ou 1s antes da expiração), reservando 1s para limpeza. Não há garantia de latência
de reap sob falha do SO. O launcher só continua após confirmação de fechamento;
se o SO não confirmar, permanece aguardando, nunca abre o serviço em paralelo à
conexão incerta. Menos de 1s restante não inicia inspeção. Não há retry interno.
Reinícios/instâncias sobrepostas podem repetir leituras dentro da janela absoluta:
não existe garantia de execução global única, lock ou marcador em disco/banco.

Erro da inspeção produz categoria fixa e segue para launcher original autenticado;
erro de segurança/artefato do launcher recusa startup antes de inspecionar. Isso não
controla reinícios externos da plataforma. Sucesso/erro não habilitam first-access.

Após observar o relatório, remover parâmetros RO e restaurar Start Command original
registrado; aplicar por operação de deploy explicitamente aprovada. Mudança de
configuração não é prova de encerramento de processos anteriores. Prazo absoluto
continua limitando novas conexões enquanto isso. Build/start/logs/SQL consomem quotas;
conferir plano e custos antes de executar, sem promessa universal de gratuidade.

## Evidência necessária antes de uso remoto

Testes de duas fases, pin obrigatório, flags/artefato, cardinalidade/limites, saída
sanitizada, encerramento/timeout, concorrência RO e launcher autenticado. A prova
PostgreSQL real é separada dos clientes fictícios e não pode ser substituída por
mocks. Sem imagem/binário local permitido, permanece pendente e impede alegar
validação operacional completa. Não abrir rede ou baixar imagem sem autorização.
