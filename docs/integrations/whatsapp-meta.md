# Canal de WhatsApp oficial: Meta Cloud API → LZR HUB

Este é o **caminho oficial e recomendado**. O outro
([`whatsapp-evolution.md`](whatsapp-evolution.md)) usa Baileys, que é uma
reimplementação não oficial do WhatsApp Web — a Meta detectou e avisou que a
conta poderia ser restringida.

## Por que migrar não foi opção de estilo

O aviso que chegou no WhatsApp Business dizia, em resumo: *"parece que você pode
estar usando ferramentas que não seguem nossos termos de serviço para enviar
mensagens automáticas ou em massa; sua conta poderá ser restringida"*.

Não é falso positivo. Automação por Baileys viola os Termos de Serviço, e o
número em risco é **o que os clientes usam para falar com o provedor**. Perdê-lo
é perder o canal inteiro, de uma vez, sem aviso prévio.

## O caminho

```
Cliente no WhatsApp
      ↓
Número da BBNET no WhatsApp Business Platform (Cloud API)
      ↓  webhook assinado (X-Hub-Signature-256)
LZR HUB em produção — POST /api/channels/meta
```

Tudo **depois** do webhook é o mesmo pipeline já testado: classificação de
intenção, sugestão de resposta, captação de lead, métricas. Só o tradutor muda.

## 1. Do lado da Meta (o trabalho que não é código)

1. Conta no **Meta Business** e verificação da empresa
2. Criar um aplicativo em developers.facebook.com com o produto **WhatsApp**
3. Adicionar o número da BBNET (ou migrar o número existente do WhatsApp
   Business — a Meta tem processo próprio para isso)
4. Guardar o **App Secret** do aplicativo

⚠️ Migrar um número já em uso apaga o histórico de conversas do aparelho. O
histórico que interessa ao atendimento já está no LZR HUB, mas vale saber antes.

## 2. Variáveis no Railway

| Variável | O que é |
|---|---|
| `FEATURE_META_WHATSAPP` | `true` liga a rota |
| `META_VERIFY_TOKEN` | Você inventa. Repete no painel da Meta ao cadastrar o webhook |
| `META_APP_SECRET` | O **App Secret** do aplicativo |

⚠️ **Os dois segredos têm papéis diferentes, e confundi-los deixa a rota aberta.**
O `META_VERIFY_TOKEN` serve **só** ao handshake de cadastro do webhook. Quem
protege cada mensagem é a **assinatura** feita com o `META_APP_SECRET`.

## 3. Cadastrar o webhook

No painel do aplicativo → WhatsApp → Configuration → Webhook:

- **Callback URL**: `https://lzr-hub-production.up.railway.app/api/channels/meta`
- **Verify token**: o mesmo valor de `META_VERIFY_TOKEN`
- **Campos**: assine **`messages`**

A Meta chama a URL com `hub.challenge` e espera o valor de volta, cru. Se as
variáveis estiverem certas, a verificação passa na hora.

## 4. O que a rota faz

| Situação | O que acontece |
|---|---|
| Assinatura ausente, errada, ou **corpo adulterado** | **401** |
| Várias mensagens no mesmo POST | todas processadas, uma a uma |
| Texto, ou resposta a botão | pipeline: classifica e grava a sugestão |
| Áudio, imagem, documento, figurinha, localização | gravado como aviso para o atendente ("[Áudio recebido — …]"), **sem** IA |
| Reação a mensagem, aviso de sistema | ignorado |
| Recibo de entrega/leitura | grava o status na resposta enviada (nunca rebaixa) |
| Outro objeto ou outro campo | ignorado |
| Mesmo `wamid` reentregue | não processa duas vezes |

⚠️ Evento ignorado responde **200** de propósito: a Meta reenfileira o que não
recebe 200, e recusar um recibo de leitura viraria reentrega infinita.

⚠️ O recibo de entrega chega pelo **mesmo** webhook, num array `statuses` em vez
de `messages`. Sem separar, a IA responderia ao próprio "entregue".

## 5. A diferença que muda a operação

Na Cloud API, **responder a quem te procurou é livre por 24 horas**. Passado
esse prazo, ou para iniciar conversa, é preciso **modelo aprovado** pela Meta.

Isso não afeta o modo observação atual (a IA não envia nada). Afeta quando o
envio for ligado: resposta de atendimento cabe na janela de 24h; a régua de
cobrança, que **inicia** conversa, vai exigir modelo aprovado.

## 6. O atendente responde pela tela

Atendimentos tem um campo de resposta que envia pela Cloud API. Para ligar, no
Railway:

| Variável | Valor |
|---|---|
| `META_PHONE_NUMBER_ID` | `1377624278760819` — "Identificação do número de telefone" do `+55 79 6000-4421` |
| `META_ACCESS_TOKEN` | token **permanente** do usuário do sistema "Employee": Configurações do negócio → Usuários do sistema → Employee → **Gerar token**, app "BBNet bot", permissões `whatsapp_business_messaging` e `whatsapp_business_management`. Cole só no Railway |
| `FEATURE_ATTENDANT_REPLY` | `true` |

Também precisa de `FEATURE_AUTH=true` (já está): mensagem a cliente sem autor
identificado é recusada.

O que o envio faz, e por quê:

- **Só dentro de 24 horas** da última mensagem do cliente. Fora disso a tela
  recusa antes de chamar a Meta — ela recusaria com o erro 131047
- **Recusa texto de homologação** ("fictício", "simulado", "homologação"),
  venha de rascunho ou de digitação
- **Uma chave por clique**: o duplo clique não manda duas mensagens. Em
  *timeout* a chave fica presa, porque a mensagem pode ter saído
- **Marca a mensagem do cliente como lida** antes de responder
- Grava a resposta com o e-mail de quem enviou, e registra
  `whatsapp.reply.sent` (ou `blocked`/`failed`) na auditoria

⚠️ O app "BBNet bot" ainda está **"Não publicado"**. Se o envio voltar com o
código 131030 ("número fora da lista de destinatários"), o caminho é publicar
o app em developers.facebook.com → Publicar.

Cada resposta enviada mostra o recibo da Meta: *Aceita pela Meta* (só o envio
foi aceito), *Enviada*, *Entregue*, *Lida* — ou *Falhou*, com o motivo traduzido.
Para isso o webhook do app precisa estar assinado no campo **`messages`**: é por
ele que os recibos chegam.

## Conferir que funcionou

| Tela | O que deve aparecer |
|---|---|
| **Atendimentos** | a conversa, com a resposta aprovada marcada *"Sugestão da IA — não enviada ao cliente"* (nunca o texto "fictício" do pipeline) |
| **Comercial → Funil** | cartão novo — só se o número não for cliente no IXC |
| **Administração → Auditoria** | `channel.message.processed` |

## Depurar

1. **A verificação passou?** Sem ela a Meta nem começa a entregar
2. **401 nos logs?** Assinatura — confira o `META_APP_SECRET`, e que ele é o
   *App Secret*, não o token de acesso nem o verify token
3. **`ignored` com `reason`?** Não é falha de entrega; a razão diz o que era
4. **Nada chegando?** No painel da Meta, WhatsApp → Configuration, o webhook
   mostra as entregas recentes e o código de resposta que recebeu de nós

## E o caminho antigo

`/api/channels/evolution` e `/api/channels/n8n` continuam funcionando. Desligar
é decisão separada: enquanto o número não estiver migrado, ele ainda é o canal.
Quando estiver, vale remover para não manter porta aberta sem uso.
