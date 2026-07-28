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

export function copilotEnabled(source:Record<string,string|undefined>=process.env):boolean {
  return source.FEATURE_INTERNAL_COPILOT==="true";
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
