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
/**
 * Rodando da sua máquina, o DATABASE_URL do Railway não resolve: ele aponta para
 * a rede privada. O endereço público é o DATABASE_PUBLIC_URL — por isso ele vem
 * primeiro aqui. Esta é a saída de emergência quando ninguém mais consegue
 * entrar na aplicação (por exemplo, o último administrador perdeu a senha).
 */
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Defina DATABASE_PUBLIC_URL (ou DATABASE_URL). Da sua máquina, use o público:");
  console.error('  railway run --service Postgres node scripts/create-user.mjs "email" "Nome" "Papel"');
  process.exit(1);
}

const password = randomBytes(12).toString("base64url");
const salt = randomBytes(16).toString("hex");
const hash = (await scryptAsync(password, salt, 64)).toString("hex");
const now = new Date().toISOString();

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
try {
  await pool.query(
    // must_change_password fica true: esta senha foi gerada e apareceu na tela de
    // quem rodou o script, então a pessoa define a dela no primeiro acesso.
    `INSERT INTO users (id,email,name,role,password_hash,password_salt,active,must_change_password,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,true,true,$7,$7)
     ON CONFLICT (email) DO UPDATE SET
       name=excluded.name, role=excluded.role,
       password_hash=excluded.password_hash, password_salt=excluded.password_salt,
       active=true, must_change_password=true, updated_at=excluded.updated_at`,
    [randomUUID(), email.trim().toLowerCase(), name, role, hash, salt, now],
  );
  console.log(`\nUsuário pronto: ${email.trim().toLowerCase()} (${role})`);
  console.log(`Senha gerada:   ${password}`);
  console.log("\nGuarde agora — ela não será exibida de novo.\n");
} finally {
  await pool.end();
}
