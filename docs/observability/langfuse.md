# Observabilidade da IA com Langfuse (issue #6)

## Como funciona

Cada vez que o pipeline de IA processa uma mensagem (`/api/agent` ou o canal n8n/WhatsApp), um rastro é enviado ao Langfuse com: intenção detectada, confiança, ferramentas usadas (nome + resultado), desfecho, se houve transbordo (e o motivo), alertas de segurança e a nota de qualidade da resposta.

## O que nunca é enviado

**A mensagem do cliente e a resposta da IA nunca vão pro rastro.** Só campos estruturados (enums, números, booleanos) — nunca texto livre que possa conter dado pessoal digitado por alguém. Há teste garantindo isso (`traceAgentResult nunca manda a mensagem ou a resposta em texto livre`).

Isso é mais rígido que a exigência original da issue ("nomes, CPFs e telefones mascarados") — em vez de mascarar campos de texto livre um por um (frágil, fácil de esquecer um caso), simplesmente nenhum texto livre é enviado.

## Por que não usar o SDK oficial

O cliente foi escrito à mão sobre o endpoint OTLP/HTTP do Langfuse, seguindo o mesmo padrão do resto do projeto (cliente IXC, também sem SDK). A API de ingestão antiga do Langfuse (lote de eventos `trace-create`) foi **descontinuada** — a atual é OpenTelemetry, com trace/span ID em hex e timestamps em nanosegundos. Ver [`lib/observability/langfuse-provider.ts`](../../lib/observability/langfuse-provider.ts).

## Configuração

```
FEATURE_LANGFUSE=true
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

As chaves ficam em **Settings → API Keys** no painel do Langfuse, depois de criar um projeto.

**Fail-closed**: falta qualquer uma das três variáveis (`FEATURE_LANGFUSE=true`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) e a observabilidade fica desligada silenciosamente — nenhum erro, nenhuma tentativa de rede. Ver `lib/observability/runtime.ts`.

Falha de rede ao enviar um rastro nunca derruba o atendimento — é best-effort, com `try/catch` (`lib/observability/trace-agent-result.ts`).

## Validado até agora

- Formato exato do payload OTLP (trace ID de 32 hex, span ID de 16 hex, timestamps em nanosegundos, headers) — coberto por teste
- Nenhum dado pessoal no payload — coberto por teste
- Comportamento fail-closed sem as três variáveis — coberto por teste

**Ainda não validado**: uma chamada real contra a API do Langfuse. A documentação pública não expõe o schema de resposta do endpoint OTLP em detalhe, então o formato foi construído seguindo a documentação disponível, mas só fica confirmado de verdade com uma conta real e um rastro aparecendo no painel deles.

## Como fica pra fechar a issue de vez

1. Criar conta no Langfuse (grátis) e pegar as chaves
2. Configurar as três variáveis no Railway
3. Mandar algumas mensagens de teste pelo `/api/agent` ou pelo canal WhatsApp
4. Conferir no painel do Langfuse que os rastros aparecem, com os campos certos e sem dado pessoal
