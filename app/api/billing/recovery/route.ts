import { getDb } from "@/db";
import { getIxcRuntime } from "@/lib/integrations/ixc/runtime";
import { authorize } from "@/lib/platform/session-guard";
import { createRecoveryGetHandler, DbRecoveryPromiseRepository } from "@/lib/platform/recovery-service";

export const GET = createRecoveryGetHandler({
  authorize, getRuntime: getIxcRuntime,
  getPromises: async () => new DbRecoveryPromiseRepository(await getDb()),
});
