import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn("DATABASE_URL não está definida — pulando migrações (modo demonstrativo sem banco). Conecte o plugin Postgres e defina DATABASE_URL quando for habilitar funcionalidades reais.");
  process.exit(0);
}

const pool = new Pool({ connectionString });
const db = drizzle(pool);

console.log("Aplicando migrações do Postgres...");
await migrate(db, { migrationsFolder: "./drizzle" });
console.log("Migrações aplicadas com sucesso.");

await pool.end();
