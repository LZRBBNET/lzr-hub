/**
 * As telas que existem de verdade.
 *
 * Leads, Funil, Kanban, Campanhas, Saúde do Cliente, Upgrade e Customer
 * Intelligence saíram daqui: nenhuma tinha fonte de dados, e todas mostravam um
 * aviso explicando o que faltaria. Item de menu que não leva a lugar nenhum
 * ensina quem usa a desconfiar do sistema inteiro — some do menu até existir.
 * O que faltava para cada uma está em `docs/telas-removidas.md`.
 */
export type View =
  | "dashboard" | "atendimento" | "clientes" | "monitoramento" | "mapa-alertas" | "massivas" | "chamados"
  | "cobranca" | "regua" | "relatorios-cobranca"
  | "comercial" | "metas" | "relatorios-comercial"
  | "training" | "conhecimento" | "churn" | "avaliacoes" | "prompts"
  | "integracoes" | "equipes" | "usuarios" | "auditoria" | "configuracoes" | "chat-interno";

export interface NavItem { id: View; label: string; icon: string; group?: string }
export const navigation: NavItem[] = [
  { id:"dashboard", label:"Visão geral", icon:"⌂", group:"Operação" },
  { id:"atendimento", label:"Atendimentos", icon:"◫" },
  { id:"clientes", label:"Clientes", icon:"◎" },
  { id:"monitoramento", label:"Centro de Monitoramento", icon:"⌁", group:"Suporte" },
  { id:"mapa-alertas", label:"Mapa de Alertas", icon:"◇" },
  { id:"massivas", label:"Massivas", icon:"⚠" },
  { id:"chamados", label:"Chamados", icon:"▣" },
  { id:"cobranca", label:"Visão Geral", icon:"$", group:"Cobrança" },
  { id:"regua", label:"Régua", icon:"≋" },
  { id:"relatorios-cobranca", label:"Relatórios", icon:"▥" },
  { id:"comercial", label:"Dashboard", icon:"↗", group:"Comercial" },
  { id:"metas", label:"Metas", icon:"◎" },
  { id:"relatorios-comercial", label:"Relatórios", icon:"▥" },
  { id:"training", label:"AI Training Mode", icon:"✦", group:"Inteligência" },
  { id:"conhecimento", label:"Base de Conhecimento", icon:"▱" },
  { id:"churn", label:"Churn", icon:"⚑" },
  { id:"avaliacoes", label:"Avaliações da IA", icon:"✓" },
  { id:"prompts", label:"Prompts e versões", icon:"{ }" },
  { id:"chat-interno", label:"Chat da equipe", icon:"◈", group:"Administração" },
  { id:"integracoes", label:"Integrações", icon:"⌁" },
  { id:"equipes", label:"Equipes e Filas", icon:"♟" },
  { id:"usuarios", label:"Usuários e Permissões", icon:"⚿" },
  { id:"auditoria", label:"Auditoria", icon:"▧" },
  { id:"configuracoes", label:"Configurações", icon:"⚙" },
];

export const viewTitles: Record<View,[string,string]> = Object.fromEntries(navigation.map((item)=>[item.id,[item.label,"Dados demonstrativos tipados • atualizado agora"]])) as Record<View,[string,string]>;
viewTitles.dashboard=["Visão geral","Operação do atendimento em tempo real"];
viewTitles.atendimento=["Atendimentos","Central omnichannel"];
viewTitles.training=["AI Training Mode","Mesmo pipeline da produção, com supervisão adicional"];
