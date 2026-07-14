import type { View } from "@/lib/platform/navigation";

const moduleCopy: Partial<Record<View,{summary:string;metrics:[string,string][];flow:string[]}>> = {
  chamados:{summary:"Gestão de protocolos técnicos com prioridade, SLA e histórico.",metrics:[["Abertos","42"],["No SLA","91%"],["Críticos","6"]],flow:["Triagem","Diagnóstico","Execução","Validação"]},
  "relatorios-cobranca":{summary:"Entrega, leitura, conversão e recuperação financeira.",metrics:[["Recuperado","R$ 92,7 mil"],["Conversão","21,4%"],["ROI","8,7x"]],flow:["Segmento","Contato","Conversão","Receita"]},
  kanban:{summary:"Oportunidades organizadas por estágio e próxima ação.",metrics:[["Oportunidades","184"],["Propostas","49"],["Vendas demo","27"]],flow:["Novo","Qualificado","Proposta","Venda"]},
  metas:{summary:"Metas comerciais por equipe, responsável e período.",metrics:[["Meta mensal","380"],["Realizado","241"],["Projeção","396"]],flow:["Meta","Execução","Acompanhamento","Fechamento"]},
  "relatorios-comercial":{summary:"Conversão, velocidade do funil e desempenho de origem.",metrics:[["Conversão","18,7%"],["Ciclo médio","4,2 dias"],["Ticket","R$ 84,30"]],flow:["Origem","Qualificação","Venda","Receita"]},
  avaliacoes:{summary:"Qualidade, segurança e continuidade das respostas da IA.",metrics:[["Nota média","9,4"],["Aprovadas","96%"],["Handoffs","7,2%"]],flow:["Resposta","Avaliação","Supervisor","Aprendizado"]},
  prompts:{summary:"Versionamento controlado de instruções e rollback.",metrics:[["Versão ativa","v12"],["Experimentos","3"],["Rollback","Disponível"]],flow:["Rascunho","Revisão","Publicação","Monitoramento"]},
  equipes:{summary:"Filas, especialidades, capacidade e distribuição.",metrics:[["Equipes","8"],["Online","31"],["Ocupação","72%"]],flow:["Entrada","Priorização","Atribuição","SLA"]},
  configuracoes:{summary:"Políticas, ambientes e parâmetros protegidos.",metrics:[["Ambiente","Mock"],["Flags ativas","2/14"],["Segredos expostos","0"]],flow:["Configuração","Validação","Auditoria","Ativação"]},
};

export function PlatformView({view}:{view:View}) {
  const data=moduleCopy[view]??{summary:"Fluxo operacional demonstrável com dados mockados identificados e ações auditáveis.",metrics:[["Registros","24"],["Atualizados","agora"],["Fonte","Mock"]],flow:["Selecionar","Validar","Executar demo","Auditar"]};
  return <main className="content"><div className="page-heading"><div><h1>{view.replaceAll("-"," ")}</h1><p>{data.summary}</p></div><button className="button">Nova ação demonstrativa</button></div><section className="metrics">{data.metrics.map(([label,value])=><article className="metric" key={label}><div className="metric-top"><span>{label}</span><span className="metric-icon">•</span></div><strong>{value}</strong><small>Fonte demo • sem efeito real</small></article>)}</section><section className="card" style={{marginTop:14}}><div className="card-header"><strong>Fluxo do módulo</strong><span className="badge blue">Operacional</span></div><div className="card-body"><div className="flow-steps">{data.flow.map((step,index)=><div className="flow-step" key={step}><span>{index+1}</span><strong>{step}</strong><small>{index===data.flow.length-1?"Com registro de auditoria":"Etapa validada"}</small></div>)}</div></div></section></main>;
}
