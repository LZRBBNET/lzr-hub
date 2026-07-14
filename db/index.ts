import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export async function getDb() {
  const binding = await getD1();
  return drizzle(binding, { schema });
}

export async function getD1(): Promise<D1Database> {
  const { env } = await import("cloudflare:workers");
  const binding = env.DB as D1Database | undefined;
  if (!binding) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }
  return binding;
}
