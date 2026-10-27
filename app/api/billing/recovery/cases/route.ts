import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { authorize } from "@/lib/platform/session-guard";
import { DbRecoveryCasesRepository } from "@/lib/platform/recovery-cases-repository";
import { createRecoveryCasesHandlers } from "@/lib/platform/recovery-cases-service";

const handlers = createRecoveryCasesHandlers({
  authorize,
  getRepository: async () => new DbRecoveryCasesRepository(await getDb()),
  getSource: () => getIxcRuntime().provider,
});
export const GET = handlers.GET;
export const POST = handlers.POST;
