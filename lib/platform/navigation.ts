/**
 * Mapa das telas: seções no menu lateral, abas dentro de cada seção.
 *
 * O menu tinha 26 itens, e vários eram a mesma tela com outro nome:
 * "Cobrança › Relatórios" e "Comercial › Relatórios" repetiam os números da
 * visão geral com outro arranjo, "Configurações" relia o mesmo estado de
 * "Integrações", e Monitoramento, Mapa de Alertas e Massivas eram três portas
 * para o mesmo registro. Quem procura uma coisa não deveria ter de adivinhar
 * qual das três portas a tem. Agora cada assunto é **uma** entrada no menu, e
 * as variações dele são abas.
 *
 * Leads, Kanban, Campanhas, Saúde do Cliente, Upgrade e Customer Intelligence
 * continuam fora: nenhuma tinha fonte de dados. Ver `docs/telas-removidas.md`.
 */
export type View =
  | "dashboard" | "atendimento" | "clientes" | "chat-interno"
  | "monitoramento" | "massivas" | "mapa-alertas" | "chamados"
  | "cobranca" | "acoes-cobranca" | "regua"
  | "comercial" | "funil" | "metas" | "churn"
  | "avaliacoes" | "prompts" | "training" | "conhecimento" | "respostas"
  | "auditoria-contratos" | "usuarios" | "equipes" | "auditoria" | "integracoes" | "filas";

export type IconName =
  | "home" | "chat" | "users" | "team" | "network" | "ticket" | "wallet" | "trending" | "churn"
  | "sparkles" | "flask" | "book" | "clipboard" | "settings";

export interface NavTab { id: View; label: string; description: string; permission?: string }
export interface NavSection { id: string; label: string; icon: IconName; group: string; tabs: NavTab[] }

export const navigation: NavSection[] = [
  { id: "inicio", label: "Início", icon: "home", group: "Operação", tabs: [
    { id: "dashboard", label: "Visão geral", description: "O que está acontecendo na operação agora." },
  ] },
  { id: "atendimentos", label: "Atendimentos", icon: "chat", group: "Operação", tabs: [
    { id: "atendimento", label: "Conversas", description: "Mensagens dos clientes pelo WhatsApp." },
  ] },
  { id: "clientes", label: "Clientes", icon: "users", group: "Operação", tabs: [
    { id: "clientes", label: "Clientes", description: "Cadastro, contrato, financeiro e conexão, direto do IXC." },
  ] },
  { id: "equipe", label: "Chat da equipe", icon: "team", group: "Operação", tabs: [
    { id: "chat-interno", label: "Conversas internas", description: "Conversa entre a equipe. O cliente nunca vê." },
  ] },
  { id: "rede", label: "Rede e massivas", icon: "network", group: "Suporte", tabs: [
    { id: "monitoramento", label: "Visão geral", description: "Massivas, alertas de rede e chamados em aberto." },
    { id: "massivas", label: "Massivas", description: "Registre, avise a área afetada e encerre incidentes." },
    { id: "mapa-alertas", label: "Regiões", description: "Massivas abertas agrupadas por cidade e bairro." },
  ] },
  { id: "chamados", label: "Chamados", icon: "ticket", group: "Suporte", tabs: [
    { id: "chamados", label: "Ordens de serviço", description: "Fila de OS do IXC." },
  ] },
  { id: "cobranca", label: "Cobrança", icon: "wallet", group: "Negócio", tabs: [
    { id: "cobranca", label: "Visão geral", description: "Posição financeira lida do IXC." },
    { id: "acoes-cobranca", label: "Ações no IXC", description: "Segunda via, renegociação e promessas de pagamento." },
    { id: "regua", label: "Régua", description: "Quando e por onde falar com quem está em atraso." },
  ] },
  { id: "vendas", label: "Comercial", icon: "trending", group: "Negócio", tabs: [
    { id: "comercial", label: "Visão geral", description: "Vendas fechadas, contadas nos contratos ativados no IXC." },
    { id: "funil", label: "Funil", description: "Leads e etapas de venda." },
    { id: "metas", label: "Metas", description: "Meta do mês contra o realizado no IXC." },
  ] },
  { id: "churn", label: "Churn", icon: "churn", group: "Negócio", tabs: [
    { id: "churn", label: "Cancelamentos", description: "Contratos perdidos e clientes com sinal de risco." },
  ] },
  { id: "qualidade", label: "Qualidade da IA", icon: "sparkles", group: "Inteligência", tabs: [
    { id: "avaliacoes", label: "Avaliações", description: "Como o atendimento automático se saiu nas conversas reais." },
    { id: "prompts", label: "Como a IA decide", description: "Classificador, respostas e transbordo.", permission: "integrations.test" },
  ] },
  { id: "training", label: "AI Training Mode", icon: "flask", group: "Inteligência", tabs: [
    { id: "training", label: "Treino", description: "Converse como um cliente e veja a análise de cada resposta." },
  ] },
  { id: "conhecimento", label: "Base de conhecimento", icon: "book", group: "Inteligência", tabs: [
    { id: "conhecimento", label: "Documentos", description: "Fontes internas que a IA e o copiloto podem citar." },
    { id: "respostas", label: "Respostas aprovadas", description: "O texto que a IA sugere para cada assunto." },
  ] },
  { id: "contratos", label: "Auditoria de contratos", icon: "clipboard", group: "Gestão", tabs: [
    { id: "auditoria-contratos", label: "Contratos novos", description: "Cadastro conferido em cada contrato novo do IXC.", permission: "audit.read" },
  ] },
  { id: "admin", label: "Administração", icon: "settings", group: "Gestão", tabs: [
    { id: "usuarios", label: "Usuários", description: "Contas, perfis e permissões.", permission: "users.manage" },
    { id: "equipes", label: "Equipes", description: "Quem assume cada motivo de transbordo." },
    { id: "auditoria", label: "Auditoria", description: "Ações de pessoas e da IA, com correlação.", permission: "audit.read" },
    { id: "integracoes", label: "Integrações", description: "Estado de cada integração e políticas do ambiente.", permission: "integrations.test" },
    { id: "filas", label: "Filas técnicas", description: "Jobs de infraestrutura (Redis/BullMQ)." },
  ] },
];

/** Endereços antigos continuam abrindo alguma coisa em vez de cair na tela inicial. */
export const viewAliases: Record<string, View> = {
  "relatorios-cobranca": "cobranca", "relatorios-comercial": "comercial", configuracoes: "integracoes",
};

export const allViews: View[] = navigation.flatMap((section) => section.tabs.map((tab) => tab.id));

export function sectionOf(view: View): NavSection {
  return navigation.find((section) => section.tabs.some((tab) => tab.id === view)) ?? navigation[0];
}
export function tabOf(view: View): NavTab {
  return sectionOf(view).tabs.find((tab) => tab.id === view) ?? navigation[0].tabs[0];
}
export function parseView(value: string): View | null {
  const clean = value.replace(/^#\/?/, "").split(/[/?]/)[0];
  if ((allViews as string[]).includes(clean)) return clean as View;
  return viewAliases[clean] ?? null;
}

/**
 * Sem sessão (demonstração com login desligado) não há o que filtrar: tudo
 * aparece, como antes. Com sessão, some do menu o que daria 403 ao abrir —
 * botão que leva a "acesso negado" ensina a não clicar em nada.
 */
export function canSee(tab: NavTab, permissions: string[] | null) {
  return !tab.permission || permissions === null || permissions.includes(tab.permission);
}
