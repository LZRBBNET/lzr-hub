# Segurança e LGPD

- Não versionar `.env`, tokens, CPFs, telefones, boletos ou dados reais.
- Mascarar identificadores antes de logs e telemetria.
- Aplicar menor privilégio às credenciais de cada provedor.
- Separar homologação e produção.
- Exigir idempotência para mensagens e ações financeiras.
- Definir retenção para webhooks brutos e trilhas de auditoria.
- Não enviar conteúdo financeiro sensível para provedores de IA/observabilidade.
- Ações irreversíveis exigem confirmação e permissão explícitas.
