# LZR HUB

Plataforma inteligente de atendimento para provedores de internet.

Inclui interface operacional, atendimento, Copiloto LZR interno, Customer 360, suporte e monitoramento, cobrança, comercial, Customer Intelligence, conhecimento, AI Training Mode, pipeline compartilhado, Actions demonstrativas com comprovantes, filas, RBAC, auditoria e painel de integrações.

## Executar

```bash
npm ci
npm run dev
```

## Validar

```bash
npm run lint
npm run typecheck
npm test
```

Integrações reais permanecem desativadas por padrão. A homologação admite somente IXC `staging-readonly`, com allowlist de até 10 cadastros e escrita bloqueada. Consulte `docs/phase-3b-readiness-report.md`.

O copiloto interno nasce atrás de `FEATURE_INTERNAL_COPILOT=false`, usa somente
conhecimento publicado e vigente e nunca envia a sugestão automaticamente.
Consulte [`docs/internal-copilot.md`](docs/internal-copilot.md).
