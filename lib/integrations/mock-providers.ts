import type { AcsProvider, ChannelProvider, ErpProvider, MonitoringProvider, ObservabilityProvider, ProviderContext, ProviderHealth } from "./contracts";

const health = (service: string, detail: string): ProviderHealth => ({ service, mode: "mock", state: "healthy", latencyMs: 12, checkedAt: new Date().toISOString(), detail });

export class MockChannelProvider implements ChannelProvider {
  health = async () => health("Canal demonstrativo", "Mensagens ficam somente no ambiente de demonstração");
  async sendText(_externalConversationId: string, _text: string, context: ProviderContext) { return { externalMessageId: `mock-${context.idempotencyKey}` }; }
}

export class MockErpProvider implements ErpProvider {
  health = async () => health("IXC Mock", "Leitura segura com dados fictícios; escrita bloqueada");
  async findCustomer(query: string, context: ProviderContext) { void context; return query ? { externalId: "IXC-DEMO-1042", maskedName: "João P." } : null; }
}

export class NoopObservabilityProvider implements ObservabilityProvider {
  health = async () => health("Observabilidade local", "Telemetria externa desativada; atendimento resiliente");
  async trace(name: string, attributes: Record<string, unknown>) { void name; void attributes; return; }
}
export class MockLibreNmsProvider implements MonitoringProvider { health=async()=>health("LibreNMS Mock","Alertas de rede fictícios"); async listAlerts(context:ProviderContext){void context;return[{externalId:"ALERT-DEMO-1",severity:"critical",summary:"Perda óptica elevada"}]}}
export class MockGenieAcsProvider implements AcsProvider { health=async()=>health("GenieACS Mock","Telemetria TR-069 fictícia"); async getDeviceStatus(externalDeviceId:string,context:ProviderContext){void context;return{online:true,model:externalDeviceId?"FiberHome AN5506":"Desconhecido",lastInform:new Date().toISOString()}}}
