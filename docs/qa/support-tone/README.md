# Atendimento mais natural: revisão local e limites

## O que esta mudança comprova

Os arquivos `before.json` e `after.json` são saídas **executadas do código**, com 12 entradas inventadas e histórico sem dados de clientes reais. O primeiro executa o commit `92dcc436dc53cb9146f281be8ca0ea1777885ca2`; o segundo, esta revisão. São replays determinísticos de um turno, alguns com histórico previamente carregado, não conversas produzidas por um modelo. `fetch` é bloqueado; ambas as execuções tiveram zero tentativas de rede. O envio usado em três cenários de triagem existe somente em memória.

### Três exemplos reproduzidos

**Cliente: “já reiniciei e continua sem internet”**

- Antes: “Para reiniciar: desligue o roteador e a ONU da tomada, espere 30 segundos e ligue de novo. Leva uns 2 minutos para normalizar. Me avise se voltou.”
- Depois: “Como você já reiniciou, não vou pedir isso de novo. Alguma luz do equipamento está vermelha ou apagada?”

**Cliente: “paguei ontem e já enviei o comprovante”**

- Antes: “Obrigado por avisar. Vamos conferir o pagamento e retornamos por aqui. Se tiver o comprovante, pode enviar.”
- Depois: “Obrigado por avisar. Um atendente precisa conferir a baixa do pagamento; ainda não tenho essa confirmação por aqui.”

**Cliente: “preciso resolver uma coisa”**

- Antes: apresentação seguida de nove opções numeradas.
- Depois: “Sou a assistente virtual da BBNET. O que você precisa resolver? Pode me contar com suas palavras.”

O protocolo real do atendimento fica fora dos exemplos JSON para manter a reprodução estável. O teste de triagem confere sua inclusão e não repetição.

## Implementação e proteção operacional

- Respostas curtas, no máximo uma pergunta nos cenários cobertos; elimina prazo de normalização não confirmado e promessas de envio, liberação ou transferência sem execução.
- `support-reply.ts` adapta respostas padrão com as últimas seis falas entregues/recentes (até seis horas), usando relatos do cliente como relatos, nunca como diagnóstico ou pagamento confirmado.
- Considera reinício já relatado; não repete perguntas de luzes, cômodo e teste cabo/Wi-Fi já recebidas. Negações, condições e perguntas sobre reinício não são confirmação de que ele ocorreu.
- Identifica-se como IA quando perguntada; identidade não apaga pedido de atendente nem recusa de acesso indevido.
- Pergunta aberta substitui o menu inicial. Escolha numérica continua disponível somente quando o último texto entregue mostrou o menu antigo; uma sugestão não enviada não habilita esse caminho.
- Resumo do copiloto mantém relatos intermediários sanitizados e distingue IA, atendente, autoria desconhecida e sugestões não enviadas.
- Textos publicados pelo operador continuam preservados, exceto a resposta de identidade explícita. Isso também significa que textos antigos publicados podem continuar repetitivos ou conter promessas: precisam de revisão antes de qualquer implantação. O patch não altera registros do banco.
- Mantidos os papéis, auditoria, protocolo, idempotência, falhas de envio e política de resposta automática. Nenhuma mensagem de cliente, consulta IXC, alteração de produção, push ou deploy foi realizada.

## O que NÃO está resolvido por templates

O modelo Groq é usado pelo canal para **classificar intenção**, não para redigir a resposta. `/api/agent` usa o pipeline de homologação; seus textos e notas heurísticas não são evidência de qualidade de conversa real.

A Cloud API da Meta hoje admite **primeira resposta automática por espera** e uma exceção para responder à pergunta de triagem. O restante vira sugestão para o operador. Este patch não habilita uma conversa autônoma contínua, nem muda a escolha do setor. Afirmações como “já transferi” continuam inadequadas antes da confirmação do encaminhamento.

Adaptações por regras cobrem apenas padrões explícitos. Paráfrases, troca de assunto, contexto contraditório e respostas curtas ainda dependem da classificação e podem exigir um humano. A intenção `cancellation_risk`, por exemplo, é ampla; o texto padrão não afirma que a pessoa decidiu cancelar. A janela de contexto é limitada e não substitui um estado de atendimento estruturado.

## Próximo passo proposto: redação generativa restrita (não implementada/ativada)

1. O orquestrador escolhe o próximo passo permitido: uma pergunta, explicar evidência confirmada ou solicitar continuidade humana. O modelo não decide ações financeiras, estado de envio, baixa, diagnóstico ou prazo.
2. Separar fatos verificados (ID da fonte, data, resultado da ferramenta) de relatos do cliente e sugestões não enviadas. Enviar contexto mínimo sanitizado; histórico é dado, não instrução.
3. Primeiro gerar **rascunhos em observação**, sob flag independente desligada por padrão. Resultado estruturado inclui texto e referências aos fatos permitidos; erro, timeout, ausência de fonte ou validação negativa retorna o padrão seguro.
4. Fatos sensíveis — valores, vencimentos, PIX, desconto, pagamento, indisponibilidade, prazo e ação concluída — devem ser renderizados a partir de dados/recibos confirmados, não inventados pela prosa do modelo. Só dizer que encaminhou após confirmação de roteamento; sem recibo, explicar a necessidade do próximo passo.
5. Revisão humana das amostras: naturalidade, continuidade, resposta à pergunta, uma pergunta por vez, repetição e afirmações sem evidência. Testar mensagens ambíguas, negativas, irritação, pagamento já feito, pedido de pessoa, cancelamento, prompt injection, troca de assunto e falhas de ferramentas. Não usar notas fixas do simulador como resultado dessa avaliação.
6. Definir orçamento, timeout, limite de tokens e registro de versão/latência/custo antes de chamadas reais. Uma validação com modelo e uma validação controlada de entrega/routing são etapas distintas; nenhuma foi executada aqui. Ativação, publicação e qualquer envio real exigem autorização própria.

## Como reproduzir

Requer Node >=22.13 e as dependências locais instaladas. Não usa chaves de modelo.

```bash
baseline=$(mktemp -d)
git archive 92dcc436dc53cb9146f281be8ca0ea1777885ca2 | tar -x -C "$baseline"
ln -s "$(pwd)/node_modules" "$baseline/node_modules"
node --experimental-strip-types scripts/preview-support-replies.mjs "$baseline" 92dcc436dc53cb9146f281be8ca0ea1777885ca2 > /tmp/support-before.json
node --experimental-strip-types scripts/preview-support-replies.mjs . local-working-tree > /tmp/support-after.json
diff -u docs/qa/support-tone/before.json /tmp/support-before.json
diff -u docs/qa/support-tone/after.json /tmp/support-after.json
node --experimental-strip-types --test tests/support-reply.test.mjs tests/triage.test.mjs tests/reply-templates.test.mjs tests/copilot.test.mjs
```

Os testes incluem fluxos multi-turno de triagem e envio simulado, replay idempotente, histórico antigo, sugestões não entregues, autoria do resumo e as regressões encontradas por revisão independente. Para verificação agregada: `npm run typecheck`, `npm run lint` e `npm test` (build + suíte completa).

## Resultado local desta revisão

- Verificação de tipos e lint: aprovados na fonte final.
- Testes focados: 87/87 aprovados.
- Build e suíte agregada: 804/804 aprovados antes da última correção estreita de relato de reinício seguido de pergunta. Após ela, a suíte completa de código foi reexecutada (805/805); a reconstrução integrada final deve incluir esta revisão.
- Revisão independente: todos os problemas materiais apontados foram corrigidos; o último caso misto e os casos negativos/perguntas foram reconferidos.
- Replays antes/depois: reproduzidos novamente e comparados byte a byte com os JSONs versionados.
- Não executado: chamadas reais de modelo, ensaio de entrega WhatsApp/IXC real e implantação. Resultado local não prova qualidade conversacional em produção.
