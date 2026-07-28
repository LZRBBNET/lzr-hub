# Copiloto LZR interno (Issue #11)

O Copiloto LZR é um assistente **do atendente** na tela de atendimento. Ele
consulta procedimentos internos, sugere uma resposta para revisão e cria um
resumo factual para transferência. Ele não atende o cliente diretamente.

## Feature flag

O recurso nasce desligado:

```env
FEATURE_INTERNAL_COPILOT=false
```

Para testar localmente com dados sintéticos:

```env
LZR_RUNTIME_MODE=mock
FEATURE_INTERNAL_COPILOT=true
```

A configuração padrão de staging continua com o recurso desligado. A ativação
não muda estas barreiras:

```env
IXC_MODE=disabled
FEATURE_N8N_CHANNEL=false
```

## Identidade e autorização

- Em `LZR_RUNTIME_MODE=mock`, a identidade é
  `demo-internal-copilot-agent`, papel `Atendente`, definida somente no
  servidor.
- Fora de `mock`, uma sessão real resolvida no servidor e a permissão
  `copilot.use` são obrigatórias.
- Fora de `mock`, `FEATURE_AUTH=false` não libera o copiloto. Sem sessão ou sem
  banco para resolvê-la, a rota falha fechada com `401`.
- `role`, `actorId`, identidade, histórico, mensagens e contexto enviados por
  body, query string ou headers não são aceitos.
- O navegador envia um `conversationId`, mas conteúdo e escopo da conversa são
  carregados por uma fonte controlada pelo servidor e validados contra o papel.

## API interna

`GET /api/copilot` informa apenas se a feature está ligada.

`POST /api/copilot` aceita:

| Ação | Campos aceitos | Resultado |
|---|---|---|
| `suggest_reply` | `action`, `conversationId` | Sugestão, recibo e fontes |
| `ask` | `action`, `conversationId`, `question` | Resposta interna e fontes |
| `summarize` | `action`, `conversationId` | Resumo factual da conversa |
| `use_suggestion` | `action`, `conversationId`, `suggestionId` | Confirmação de auditoria |

A pergunta tem limite de 1.000 caracteres. Campos extras e tentativas de
injeção de papel, prompt ou contexto operacional são bloqueados.

## Evidência

O copiloto usa `KnowledgeService.searchPublished`, que aceita somente:

- documento com `status: published`;
- documento com `validUntil` válido e não vencido;
- conteúdo com correspondência suficiente ao assunto consultado.

Cada fonte devolvida contém:

- `id`;
- `title`;
- `version`;
- `excerpt`, o trecho efetivamente usado.

Documentos em `draft`, `review`, vencidos, sem conteúdo ou sem correspondência
suficiente são excluídos. Sem fonte elegível, a resposta declara que não há
evidência suficiente e não cria uma sugestão utilizável.

## Uso e auditoria

“Usar sugestão” não envia mensagem. O fluxo é:

1. o servidor emite um recibo associado ao ator, conversa e fontes;
2. o clique consome esse recibo uma única vez, com validade de 15 minutos;
3. o uso é auditado como `copilot.suggestion.use`;
4. somente depois o texto é inserido no composer;
5. o atendente revisa e envia manualmente.

Com `DATABASE_URL`, a auditoria usa `audit_events`. Sem banco, o modo mock
mantém um rastro efêmero em memória e continua funcional. Esse fallback não
deve ser tratado como auditoria persistente de produção.

## Limites de integração

O copiloto não importa nem chama:

- IXC;
- n8n;
- WhatsApp ou outro canal;
- qualquer provedor externo de IA;
- qualquer operação de envio.

Em `mock`, toda resposta contém `simulationOnly: true`.
