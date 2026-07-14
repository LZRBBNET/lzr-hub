export type View =
  | "dashboard" | "atendimento" | "clientes" | "monitoramento" | "mapa-alertas" | "massivas" | "chamados"
  | "cobranca" | "regua" | "campanhas" | "relatorios-cobranca"
  | "comercial" | "leads" | "funil" | "kanban" | "metas" | "relatorios-comercial"
  | "training" | "conhecimento" | "intelligence" | "saude" | "churn" | "upgrade" | "avaliacoes" | "prompts"
  | "integracoes" | "equipes" | "usuarios" | "auditoria" | "configuracoes";

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
  { id:"campanhas", label:"Campanhas", icon:"◉" },
  { id:"relatorios-cobranca", label:"Relatórios", icon:"▥" },
  { id:"comercial", label:"Dashboard", icon:"↗", group:"Comercial" },
  { id:"leads", label:"Leads", icon:"♙" },
  { id:"funil", label:"Funil", icon:"▽" },
  { id:"kanban", label:"Kanban", icon:"▤" },
  { id:"metas", label:"Metas", icon:"◎" },
  { id:"relatorios-comercial", label:"Relatórios", icon:"▥" },
  { id:"training", label:"AI Training Mode", icon:"✦", group:"Inteligência" },
  { id:"conhecimento", label:"Base de Conhecimento", icon:"▱" },
  { id:"intelligence", label:"Customer Intelligence", icon:"◈" },
  { id:"saude", label:"Saúde do Cliente", icon:"♡" },
  { id:"churn", label:"Risco de Churn", icon:"⚑" },
  { id:"upgrade", label:"Upgrade", icon:"↑" },
  { id:"avaliacoes", label:"Avaliações da IA", icon:"✓" },
  { id:"prompts", label:"Prompts e versões", icon:"{ }" },
  { id:"integracoes", label:"Integrações", icon:"⌁", group:"Administração" },
  { id:"equipes", label:"Equipes e Filas", icon:"♟" },
  { id:"usuarios", label:"Usuários e Permissões", icon:"⚿" },
  { id:"auditoria", label:"Auditoria", icon:"▧" },
  { id:"configuracoes", label:"Configurações", icon:"⚙" },
];

export const viewTitles: Record<View,[string,string]> = Object.fromEntries(navigation.map((item)=>[item.id,[item.label,"Dados demonstrativos tipados • atualizado agora"]])) as Record<View,[string,string]>;
viewTitles.dashboard=["Visão geral","Operação do atendimento em tempo real"];
viewTitles.atendimento=["Atendimentos","Central omnichannel"];
viewTitles.training=["AI Training Mode","Mesmo pipeline da produção, com supervisão adicional"];
