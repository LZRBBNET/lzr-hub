# Robô de dúvidas (n8n)

No **horário comercial** o LZR pede ao n8n a resposta de uma **dúvida** e a envia ao cliente pelo WhatsApp. Fora do horário quem fala é a triagem (`FEATURE_OFF_HOURS_AUTOREPLY`).

```
cliente → Meta → LZR ──(pergunta + trechos da base)──► n8n ──► Groq (gpt-oss-120b)
                  ▲                                      │
                  └────────── texto da resposta ◄────────┘
LZR confere o texto e envia pela Cloud API
```

O n8n **não** tem o token da Meta nem acesso ao IXC. Ele recebe texto e devolve texto.

## O que o robô responde

Só `general_information` e `sales_inquiry` (`DOUBT_INTENTS`), e só quando a **base de conhecimento** tem trecho que sustente (documento publicado e dentro da validade). Sem trecho o n8n nem é chamado. Fatura, bloqueio, sem internet, OS e cancelamento seguem os fluxos do LZR.

Cumprimento ou pedido vago ("oi") também é respondido: o robô se apresenta como assistente virtual, manda o protocolo e o menu numerado de assuntos (o mesmo da triagem). A escolha do cliente vira o assunto e segue para o atendente.

Conversa com **responsável humano** (botão "Com você" / "Minhas") nunca recebe resposta do robô: para devolver, use **Devolver à IA**.

Uma resposta por espera: depois que a IA respondeu, as próximas falas do cliente viram sugestão até um atendente responder (mesma regra da resposta automática).

## Travas, todas caindo na sugestão ao atendente

- Sem `FEATURE_N8N_BOT`, URL `https` ou segredo (≥ 24 caracteres): sem chamada.
- n8n lento (7 s), fora do ar ou HTTP diferente de 200: sugestão + auditoria `whatsapp.doubtbot.failed`.
- O texto devolvido é conferido (`checkBotAnswer`): recusa vazio, `NAO_SEI`, mais de 900 caracteres, "homologação/fictício", e-mail, CPF, telefone, link e **afirmação de ação já feita** ("já abri", "foi gerada"…).
- Humano com a conversa, janela de 24 h vencida, reentrega do webhook: as mesmas travas da resposta automática.
- A pergunta e o histórico vão **sanitizados** (sem CPF, e-mail, telefone).

## Montar no n8n (https://n8n.bbnetup.com.br)

1. **Credenciais** (Credentials → Create):
   - *Header Auth* com nome `Authorization` e valor `Bearer <SEGREDO>` — é o que protege o webhook. `<SEGREDO>` é uma sequência aleatória longa que você gera (não use senha reaproveitada). Deve ser **igual** ao `N8N_BOT_SECRET` do Railway.
   - *Header Auth* com nome `Authorization` e valor `Bearer <GROQ_API_KEY>` — para chamar a Groq.
2. **Importar** `robo-duvidas.workflow.json` (menu ⋯ → Import from file). Abra o nó **Pergunta do LZR** e escolha a primeira credencial; abra **Groq (gpt-oss-120b)** e escolha a segunda.
3. **Ativar** o fluxo (botão *Active*). A URL de produção do webhook é `https://n8n.bbnetup.com.br/webhook/duvidas` — não a de teste (`/webhook-test/`).
4. Teste de fora, sem passar pelo WhatsApp:

```bash
curl -s -X POST https://n8n.bbnetup.com.br/webhook/duvidas \
  -H "Authorization: Bearer <SEGREDO>" -H "Content-Type: application/json" \
  -d '{"intent":"general_information","question":"qual o horário da loja?","history":[],"sources":[{"title":"Horário das lojas","excerpt":"A loja funciona das 8h às 18h."}]}'
```

Deve voltar `{"answer":"..."}`. Sem o cabeçalho, 403.

## Ligar no Railway

| Variável | Valor |
|---|---|
| `N8N_BOT_URL` | `https://n8n.bbnetup.com.br/webhook/duvidas` |
| `N8N_BOT_SECRET` | o mesmo `<SEGREDO>` |
| `FEATURE_N8N_BOT` | `true` — **por último**, depois de testar o webhook |

Para mudar o tom ou as regras do robô, edite o prompt no nó **Monta o pedido ao modelo**. O LZR continua conferindo o texto que volta, então um prompt ruim no n8n não vira promessa falsa ao cliente.

## Modo autônomo (`FEATURE_AI_AGENT`)

Com `FEATURE_AI_AGENT=true` (mais `N8N_BOT_URL` e `N8N_BOT_SECRET`), o mesmo fluxo vira o atendente de primeira linha, **a qualquer hora**:

- a IA responde **cada fala** do cliente pela base de conhecimento, guiando passo a passo;
- segunda via, PIX e diagnóstico de conexão continuam pelos fluxos do LZR (com CPF do titular);
- pedido de atendente, cancelamento, reclamação e desconto vão direto para a fila;
- quando a resposta diz que "um atendente" vai fazer algo, a conversa fica na fila até alguém assumir ou clicar **Devolver à IA**; enquanto isso a IA continua respondendo o que a base sustenta, sem repetir a promessa;
- recusa ("qual meu CPF?") não passa a conversa: a IA recusa e segue ajudando;
- conversa que a IA resolveu **sai da fila** sozinha.

O prompt do nó **Monta o pedido ao modelo** devolve `NAO_SEI` quando o cliente já fez o que a base orienta e o problema continua — é o que leva a conversa ao atendente em vez de repetir o mesmo passo.
