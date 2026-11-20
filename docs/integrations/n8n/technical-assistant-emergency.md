# Contenção emergencial: suporte técnico Meta

Base independente do código implantado. Em turnos técnicos reconhecidos
(texto/assunto do ticket ou continuação da pergunta técnica protegida), o
canal só pode sair com uma pergunta neutra sobre outros aparelhos ou luz
do roteador, **gerada pelo modelo** e aceita por uma gramática fechada.
Não há resposta pronta alternativa. Fala fora do recorte, falha n8n/Meta,
proposta de ação, sugestão fora da gramática, humano responsável, timestamp
inválido ou falta de configuração: entrada preservada para atendimento,
sem alegar resposta, transferir a posse, cobrar, gerar Pix ou criar O.S.

O n8n recebe apenas a pequena frase pública e a tarefa; sem nome, telefone,
conta, fatos do IXC, histórico ou base. Os fatos de diagnóstico e cache da
triagem não são enviados ao modelo nem usados em resposta automática da
Meta; a visão interna continua. A classificação geral e outras automações
do código-base não foram contidas aqui. Fora do escopo técnico reconhecido,
este hotfix não é uma garantia sobre todo texto nem substitui uma revisão
de finanças, outros emissores ou cobertura geral. O classificador legado pode
atuar antes de reconhecer uma fala ambígua; sua saída técnica já entra na
barreira, mas sua entrada não foi redesenhada.

O WAMID e a entrada são guardados juntos antes de qualquer ação do modelo.
A reserva incerta não é retomada automaticamente. Meta accepted não prova
entrega. Um erro não marca falso aceite nem gera sugestão clicável.
A decisão de liberar depois de falha pertence ao operador. Homologar o lock
em PostgreSQL, consentimento, dono humano e recibos com uma única rota Meta
e confirmar a segurança do fluxo publicado no n8n antes de qualquer rollout.
A atual aplicação publicada não muda sem deploy; não publicar esta variante
por mera suposição de que os caminhos paralelos foram drenados.

## Respostas anteriores que não são evidência

Uma pergunta que faz referência explícita a número ou estado de uma O.S.
vai para revisão, sem gerar texto. Referência indireta só aciona essa
proteção quando ancorada na última resposta recente da IA que contém
alegação técnica reconhecível. Frase simples de sintoma ainda atual entra
como relato do cliente, sem repetir nem levar a alegação ao modelo. O texto
original e sua auditoria não são alterados; somente a cópia de contexto
usada pelos fluxos automáticos é filtrada. Isto não comprova se a O.S.
existe, não é um detector semântico geral e não valida dados históricos.

## Pausa restrita e reversível

Se houver desvio depois da publicação, definir
`FEATURE_META_TECHNICAL_REPLY_PAUSED=true` somente no serviço Meta/LZR
interrompe a geração e o envio nos turnos protegidos, preservando entrada
e trilha. Não desliga recebimento, atendimento humano ou outros fluxos.
Confirmar o novo estado implantado e não reverter para a versão antiga
que permitia as alegações. Para retomar, remover a variável depois de
corrigir e revalidar a causa. Não repetir mensagens de clientes já reservadas.

## Continuidade opcional: uma segunda pergunta

`FEATURE_META_TECHNICAL_CONTINUITY=true` (desligada por padrão) permite
somente uma segunda pergunta diagnóstica. Só reconhece respostas curtas em
português à última pergunta efetivamente aceita pela Meta e vinculada, no
histórico imediato (até 15 min), ao resultado idempotente de uma primeira
pergunta gerada e validada por este fluxo. Um recibo de falha, outro turno
visível, timestamp incompatível, terceiro turno, dado pessoal ou resposta
ambígua deixam a mensagem original disponível para revisão. O resultado
“aceito pela Meta” não comprova entrega; uma resposta sem citação exige
recibo de entrega/leitura gravado e hora não anterior à projeção da
pergunta. Uma citação válida exige WAMID exato da pergunta, no contexto
assinado pela Meta; só ela resolve a ambiguidade de duas falas no mesmo
segundo sem recibo. Citações inválidas não são tratadas como fala sem
citação.

Uma reserva persistente por pergunta anterior não permite que dois
webhooks, mesmo com WAMIDs diferentes, disparem duas segundas perguntas.
O modelo recebe só um relato normalizado da resposta, sem histórico, e
deve gerar uma pergunta curta sobre a outra dimensão diagnóstica. O
resultado não pode repetir a dimensão anterior, fazer afirmações, citar
IXC, sugerir O.S./Pix ou executar ações. Sem texto autorizado nada é
enviado. Mantêm-se os limites do recorte técnico, o registro para revisão manual, o
bloqueio de posse humana no despacho e a pausa
`FEATURE_META_TECHNICAL_REPLY_PAUSED`.

Testar em PostgreSQL descartável a aceitação do ledger e a reserva
concorrente por pergunta. Verificar também a resposta do fluxo n8n em
ambiente de teste com permissões e credenciais sintéticas, antes de ligar
no canal. Os testes em memória não comprovam esses dois pontos.

## Cumprimento responde à fala atual

Um cumprimento curto e sem outro pedido desvia antes de triagem/consulta IXC,
inclusive quando o ticket já era técnico ou a resposta antiga afirmava
algo não verificado. O n8n recebe só o cumprimento atual, sem história,
documentos, dados da conta, sinais ou O.S. Para sair, a pergunta cordial
deve ser gerada no n8n, prevista pela gramática segura e combinar com o
período dito pelo cliente (sem inventar período ausente). Não há resposta
pronta em caso de falha. Responsável humano, fluxo privado, escopo do
receptor/remetente, hora do evento, pausa e idempotência continuam valendo.
Este recorte não muda como continuidades explícitas de uma conversa são
resolvidas.

## Cumprimento com pedido e desescalada

“Boa tarde, estou sem internet” é um pedido técnico atual: começar com
“Boa tarde!” e fazer uma pergunta útil de diagnóstico, sem perguntar
genericamente como ajudar. Um primeiro contato sem saudação explícita
pode inferir o período em America/Sao_Paulo apenas se o evento da Meta
for recente (até dois minutos) e não existir fala visível anterior.
Respostas curtas à pergunta anterior não repetem a saudação.

Se um relato técnico reconhecido vier junto de uma expressão de frustração
do repertório fechado, o modelo recebe somente o sintoma normalizado e
uma instrução de acolhimento. Aceita-se somente um reconhecimento cordial
da frustração e uma pergunta técnica segura. Não é um detector amplo de
ameaças nem de intenção; frases ameaçadoras reconhecidas ou queixas
ambíguas do repertório ficam registradas para revisão, sem modelo ou envio.
Nenhuma fala citada do histórico, diagnóstico, identificação, O.S., Pix,
promessa ou ação entra na geração. Preservam-se a posse humana e a pausa.

O contexto do atendimento anterior só pode bloquear por posse humana
vigente ou etapa privada explicitamente pendente (pedido de CPF/tentativa
ainda disponível). Atendimentos fechados e provas de expiração de 24 h
não bloqueiam um cumprimento ou relato atual. Se uma etapa privada
pendente tiver hora inválida e não houver prova de expiração, a IA se
abstém. A posse real continua sendo conferida no envio
independentemente da idade do atendimento da triagem.
