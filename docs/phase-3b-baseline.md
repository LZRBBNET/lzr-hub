# Fase 3B — baseline

Data: 12/07/2026

- Branch inicial: `main`
- HEAD: `68bf3d5932663c5886cc45790414b995e93fe178`
- O HEAD contém `68bf3d5`: sim
- Árvore inicial: limpa
- Lint: aprovado
- Typecheck: aprovado
- Testes: 27/27 aprovados
- Build: aprovado
- Branch de trabalho: `feat/ixc-readonly-pilot`

O gerenciador hospedado possuía apenas flags não secretas. `IXC_BASE_URL`, `IXC_API_TOKEN`, `IXC_ALLOWED_CUSTOMER_IDS` e o segredo administrativo não estavam configurados; por isso o IXC real permaneceu desligado e nenhum smoke test real foi inventado.
