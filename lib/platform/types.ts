export type DataState = "ready" | "loading" | "empty" | "partial" | "error";
export type Severity = "low" | "medium" | "high" | "critical";
export type IntegrationMode = "disabled" | "mock" | "sandbox" | "production";

export interface DataSource { provider: string; updatedAt: string; state: DataState; detail?: string; mode?:"demo"|"staging-readonly"|"local"; cache?:"hit"|"miss"|"none"; masked?:boolean; latencyMs?:number }
export interface CustomerSummary { id: string; name: string; maskedDocument: string; city: string; neighborhood: string; plan: string; status: string; health: number; churnRisk: Severity; priority: string; tags: string[] }
export interface NetworkIncident { id: string; title: string; city: string; neighborhood: string; equipment: string; severity: Severity; status: "investigating" | "monitoring" | "resolved"; startedAt: string; affectedCustomers: number; probableCause: string; source: string }
export interface CollectionRuleStep { id: string; label: string; offsetDays: number; channel: string; template: string; time: string; attempts: number; pauseOnPayment: boolean; optOut: boolean; active: boolean }
export interface CollectionCampaign { id: string; name: string; segment: string; audience: number; delivered: number; read: number; converted: number; recovered: number; status: "draft" | "queued-demo" | "running-demo" | "cancelled" | "completed" }
export interface Lead { id: string; name: string; maskedPhone: string; city: string; neighborhood: string; source: string; interest: string; coverage: string; owner: string; stage: string; score: number; nextAction: string }
export interface HealthFactor { label: string; value: number; weight: number; impact: number; explanation: string }
export interface KnowledgeDocument { id: string; title: string; category: string; status: "draft" | "published" | "review"; version: number; city: string; plan: string; equipment: string; validUntil: string; chunks: number; updatedAt: string }
export interface AuditEvent { id: string; actor: string; role: string; action: string; entity: string; result: "success" | "blocked" | "failed"; origin: "human" | "ai"; correlationId: string; at: string; reason: string }
