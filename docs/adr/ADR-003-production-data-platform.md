# ADR-003 — Plataforma de dados de produção

Status: aceito em 12/07/2026

## Decisão

Adotar **Cloudflare D1 + Drizzle/SQLite** na homologação e no primeiro piloto. Jobs usarão processamento compatível com Workers, com checkpoint e DLQ persistidos em D1; a busca de conhecimento continua híbrida por metadados, termos e evidências, sem alegar pgvector.

PostgreSQL, Redis/BullMQ e pgvector ficam como opção de evolução, sujeita a novo ADR quando volume, transações ou busca semântica comprovarem a necessidade.

## Comparação

| Critério | Cloudflare nativa | PostgreSQL + Redis |
|---|---|---|
| Código atual | Drizzle SQLite, Worker e helper D1 já presentes | Exige trocar dialect, driver, schema e conexão |
| Homologação | Menor caminho e binding gerenciado pelo Sites | Nova infraestrutura e secrets adicionais |
| Filas | D1 para estado; Queues/Workflows quando habilitados | BullMQ maduro, mas requer Redis operacional |
| Busca | Híbrida com evidência; Vectorize é evolução possível | pgvector mais flexível para embeddings |
| Transações | Adequado ao piloto controlado | Melhor para fluxos relacionais complexos |
| Auditoria | Tabelas append-only e índices atendem o piloto | Forte, com ecossistema amplo |
| Backup | Export SQL e restore testável | Ferramentas maduras, porém mais operação |
| Multi-tenant | Viável com tenant_id e índices; validar escala | Excelente flexibilidade e isolamento lógico |
| Deploy/observabilidade | Mesmo runtime e menos partes móveis | Rede externa, pool/proxy e Redis |
| Dependência | Cloudflare/Sites | Provedor PostgreSQL + Redis |
| Tempo e risco | Menores nesta fase | Maiores agora; benefício prematuro |

## Consequências

- O binding lógico é `DB`; os identificadores físicos continuam fora do Git.
- Migrations permanecem reversíveis e não destrutivas.
- Indicadores da interface deixam de chamar Redis, BullMQ ou pgvector de ativos.
- Cache, jobs, checkpoints, DLQ e auditoria têm contratos independentes para permitir migração futura.
- Não haverá importação de dump real nem persistência de payload bruto do IXC.

## Gatilhos para reavaliar

- contenção ou latência persistente do D1;
- necessidade comprovada de transações multi-etapas complexas;
- busca vetorial em produção com avaliação objetiva;
- filas com volume incompatível com o mecanismo Cloudflare escolhido;
- exigência de isolamento multi-tenant que ultrapasse o desenho atual.
