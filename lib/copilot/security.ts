import type { AuthenticatedUser } from "../platform/auth.ts";
import { can } from "../platform/rbac.ts";
import { currentUser } from "../platform/session-guard.ts";
import type { CopilotActor } from "./types.ts";

const DEMO_ACTOR:CopilotActor=Object.freeze({
  id:"demo-internal-copilot-agent",
  email:"copiloto-demo@invalid.local",
  name:"Atendente Demonstração",
  role:"Atendente",
  source:"server-demo",
});

const allowedBodyFields=new Set(["action","conversationId","question","suggestionId"]);
const forbiddenQueryFields=new Set(["role","actorid","actor_id","identity","context","history","messages"]);
const forbiddenHeaders=["x-role","x-actor-id","x-user-id","x-user-role","x-copilot-context"];

export function copilotEnabled(source:Record<string,string|undefined>=process.env):boolean {
  return source.FEATURE_INTERNAL_COPILOT==="true";
}

export function hasUntrustedCopilotContext(request:Request,body:Record<string,unknown>):boolean {
  if(Object.keys(body).some((field)=>!allowedBodyFields.has(field)))return true;
  const url=new URL(request.url);
  if([...url.searchParams.keys()].some((key)=>forbiddenQueryFields.has(key.toLowerCase())))return true;
  return forbiddenHeaders.some((header)=>request.headers.has(header));
}

export function containsCopilotInstructionInjection(question:string):boolean {
  const normalized=question.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  return /ignore.{0,40}(regra|instrucao|sistema)|finja que|atue como|revele.{0,30}prompt|assuma.{0,30}papel/.test(normalized);
}

function fromSession(user:AuthenticatedUser):CopilotActor {
  return {...user,source:"session"};
}

/**
 * A identidade mock é constante e definida aqui. Fora do mock, FEATURE_AUTH
 * desligada não concede acesso: somente uma sessão real resolvida no servidor.
 */
export async function resolveCopilotActor(
  request:Request,
  source:Record<string,string|undefined>=process.env,
):Promise<CopilotActor|undefined> {
  if(source.LZR_RUNTIME_MODE==="mock")return DEMO_ACTOR;
  const sessionUser=await currentUser(request);
  if(!sessionUser||!can(sessionUser.role,"copilot.use"))return undefined;
  return fromSession(sessionUser);
}
