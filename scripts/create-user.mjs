/**
 * Cria (ou atualiza) um usuário do LZR HUB.
 *
 * Uso:
 *   node scripts/create-user.mjs "email@bbnet.com" "Nome Completo" "Administrador"
 *
 * A senha NÃO é passada por argumento de propósito: argumentos ficam no
 * histórico do shell e na lista de processos. O script gera uma senha
 * aleatória e a imprime uma única vez.
 */
import { randomBytes, randomUUID, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";

const scryptAsync = promisify(scrypt);
const ROLES = ["Administrador", "Supervisor", "Atendente", "Suporte", "Cobrança", "Comercial", "Analista", "Somente leitura"];

const [email, name, role = "Administrador"] = process.argv.slice(2);

if (!email || !name) {
  console.error('Uso: node scripts/create-user.mjs "email@bbnet.com" "Nome Completo" ["Papel"]');
  process.exit(1);
}
if (!ROLES.includes(role)) {
  console.error(`Papel inválido: "${role}". Use um destes: ${ROLES.join(", ")}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não está definida. Configure o Postgres antes de criar usuários.");
  process.exit(1);
}

const password = randomBytes(12).toString("base64url");
const salt = randomBytes(16).toString("hex");
const hash = (await scryptAsync(password, salt, 64)).toString("hex");
const now = new Date().toISOString();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(
    `INSERT INTO users (id,email,name,role,password_hash,password_salt,active,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$7)
     ON CONFLICT (email) DO UPDATE SET
       name=excluded.name, role=excluded.role,
       password_hash=excluded.password_hash, password_salt=excluded.password_salt,
       active=true, updated_at=excluded.updated_at`,
    [randomUUID(), email.trim().toLowerCase(), name, role, hash, salt, now],
  );
  console.log(`\nUsuário pronto: ${email.trim().toLowerCase()} (${role})`);
  console.log(`Senha gerada:   ${password}`);
  console.log("\nGuarde agora — ela não será exibida de novo.\n");
} finally {
  await pool.end();
}
