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
