import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL não está definida. No Railway, conecte o plugin Postgres ao serviço para que essa variável seja injetada automaticamente."
      );
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function getDb() {
  return drizzle(getPool(), { schema });
}
