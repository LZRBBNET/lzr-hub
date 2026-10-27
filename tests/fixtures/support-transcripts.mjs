/** Invented test conversations, not real customer data or live-model outputs. */
export const supportTranscripts = [
  { id: 'no-internet', title: 'Sem internet, primeiro contato', history: [], message: 'estou sem internet desde hoje cedo' },
  { id: 'already-restarted', title: 'Reinício já feito na mensagem atual', history: [], message: 'já reiniciei e continua sem internet' },
  { id: 'restart-in-history', title: 'Reinício informado antes', history: [
    { role: 'customer', content: 'estou sem internet' },
    { role: 'agent', content: 'Você já reiniciou o roteador?', sentBy: 'operador@example.test' },
    { role: 'customer', content: 'já reiniciei' },
  ], message: 'a internet continua sem conexão' },
  { id: 'angry-repeat', title: 'Terceiro contato, irritado', history: [
    { role: 'customer', content: 'estou sem internet' },
    { role: 'agent', content: 'Você já reiniciou o roteador?' },
    { role: 'customer', content: 'já reiniciei e não voltou' },
  ], message: 'é a terceira vez que falo, estou sem internet, que absurdo' },
  { id: 'already-paid', title: 'Pagamento relatado, comprovante já enviado', history: [], message: 'paguei ontem e já enviei o comprovante' },
  { id: 'unknown-outage', title: 'Relato regional sem confirmação', history: [], message: 'estou sem internet e os vizinhos também, tem prazo para voltar no bairro?' },
  { id: 'cancel', title: 'Cancelamento explícito', history: [], message: 'quero cancelar minha internet' },
  { id: 'ambiguous', title: 'Pedido vago, primeira pergunta de triagem', history: [], message: 'preciso resolver uma coisa', triage: true },
  { id: 'ambiguous-again', title: 'Pedido segue vago após pergunta recebida', history: [
    { role: 'customer', content: 'preciso de ajuda' },
    { role: 'agent', content: 'O que você precisa resolver?' },
  ], message: 'é sobre aquilo' },
  { id: 'identity', title: 'Identidade da IA', history: [], message: 'você é um robô?', triage: true },
  { id: 'slow-all-devices', title: 'Lentidão já informada em todos os aparelhos', history: [], message: 'está lento em todos os aparelhos' },
  { id: 'wifi-room', title: 'Cômodo já informado', history: [], message: 'o wifi está ruim no quarto' },
];
