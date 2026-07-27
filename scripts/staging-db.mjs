import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const database = "lzr-hub-staging";
const config = "wrangler.jsonc";
const restoreState = ".wrangler/restore-test";
const backup = "backups/staging/latest.sql";

function wrangler(args, persistTo) {
  const persistence = persistTo ? ["--persist-to", persistTo] : [];
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", ...args, "--local", ...persistence, "--config", config], { stdio: "inherit", env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/logs" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function migrate(persistTo) {
  if (persistTo) mkdirSync(persistTo, { recursive: true });
  wrangler(["d1", "migrations", "apply", database], persistTo);
}

const command = process.argv[2];
if (command === "create") {
  migrate();
  console.log("Banco D1 local de homologação inicializado; o D1 hospedado é provisionado pelo Sites com o binding DB.");
} else if (command === "migrate") {
  migrate();
} else if (command === "seed") {
  migrate();
  wrangler(["d1", "execute", database, "--file", "scripts/staging-seed.sql"]);
} else if (command === "backup") {
  mkdirSync("backups/staging", { recursive: true });
  wrangler(["d1", "export", database, "--output", backup]);
  console.log(`Backup sanitizado criado em ${backup}`);
} else if (command === "restore-test") {
  if (!existsSync(backup)) throw new Error("Execute db:staging:backup antes do teste de restauração");
  rmSync(restoreState, { recursive: true, force: true });
  mkdirSync(restoreState, { recursive: true });
  wrangler(["d1", "execute", database, "--file", backup], restoreState);
  wrangler(["d1", "execute", database, "--command", "SELECT COUNT(*) AS tables_count FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%';"], restoreState);
  console.log("Restauração isolada concluída; o banco de staging original não foi alterado.");
} else if (command === "status") {
  migrate();
  wrangler(["d1", "execute", database, "--command", "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"]);
  wrangler(["d1", "execute", database, "--command", `SELECT json_object(
    'customers', (SELECT COUNT(*) FROM customers),
    'network_incidents', (SELECT COUNT(*) FROM network_incidents),
    'collection_rules', (SELECT COUNT(*) FROM collection_rules),
    'collection_rule_steps', (SELECT COUNT(*) FROM collection_rule_steps),
    'collection_campaigns', (SELECT COUNT(*) FROM collection_campaigns),
    'leads', (SELECT COUNT(*) FROM leads),
    'knowledge_documents', (SELECT COUNT(*) FROM knowledge_documents),
    'audit_events', (SELECT COUNT(*) FROM audit_events)
  ) AS synthetic_counts;`]);
} else {
  throw new Error("Comando esperado: create, migrate, seed, backup, restore-test ou status");
}
