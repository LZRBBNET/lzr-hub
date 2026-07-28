import type { Role } from "../platform/rbac.ts";

export type CopilotAction = "suggest_reply" | "ask" | "summarize";

export interface CopilotActor {
  id:string;
  email:string;
  name:string;
  role:Role;
  source:"server-demo"|"session";
}

export interface CopilotConversationMessage {
  role:"customer"|"agent";
  content:string;
  at:string;
}

export interface CopilotConversation {
  id:string;
  customerId:string;
  customerName:string;
  allowedRoles:Role[];
  messages:CopilotConversationMessage[];
}

export interface CopilotSource {
  id:string;
  title:string;
  version:number;
  excerpt:string;
}

export interface CopilotResult {
  action:CopilotAction;
  answer:string;
  sources:CopilotSource[];
  suggestionId?:string;
  simulationOnly:boolean;
}
