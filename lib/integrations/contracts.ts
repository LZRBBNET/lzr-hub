export type IntegrationMode = "disabled" | "mock" | "staging-readonly" | "production-readonly";
export type HealthState = "healthy" | "degraded" | "disabled";

export interface ProviderHealth { service: string; mode: IntegrationMode; state: HealthState; latencyMs?: number; checkedAt: string; detail: string }
export interface ProviderContext { correlationId: string; idempotencyKey: string }
export interface ChannelProvider { health(): Promise<ProviderHealth>; sendText(externalConversationId: string, text: string, context: ProviderContext): Promise<{ externalMessageId: string }> }
export interface ErpProvider { health(): Promise<ProviderHealth>; findCustomer(query: string, context: ProviderContext): Promise<{ externalId: string; maskedName: string } | null> }
export interface ObservabilityProvider { health(): Promise<ProviderHealth>; trace(name: string, attributes: Record<string, unknown>): Promise<void> }
export interface MonitoringProvider { health(): Promise<ProviderHealth>; listAlerts(context:ProviderContext):Promise<Array<{externalId:string;severity:string;summary:string}>> }
export interface AcsProvider { health(): Promise<ProviderHealth>; getDeviceStatus(externalDeviceId:string,context:ProviderContext):Promise<{online:boolean;model:string;lastInform:string}> }
export interface TelephonyProvider { health():Promise<ProviderHealth>; createCallback(destinationMasked:string,context:ProviderContext):Promise<{requestId:string}> }
export interface AiGatewayProvider { health():Promise<ProviderHealth>; generate(input:string,context:ProviderContext):Promise<{text:string;model:string}> }

export class IntegrationDisabledError extends Error {
  constructor(public readonly service: string) { super(`${service} está desativado`); this.name = "IntegrationDisabledError"; }
}

export const featureFlags = {
  chatwoot: false,
  evolution: false,
  metaWhatsApp: false,
  ixcWrite: false,
  langfuse: false,
  pgvector: false,
  queues: false,
} as const;
