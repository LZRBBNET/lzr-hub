/**
 * Popula um banco **de desenvolvimento** com dados sintéticos para que as telas
 * possam ser abertas e inspecionadas com conteúdo realista.
 *
 * Isto não é fixture de produto nem dado de demonstração embutido na aplicação:
 * é massa de teste para quem está desenvolvendo. O produto continua sem ficção —
 * o que aparece nas telas em produção vem do IXC e do banco real.
 *
 * A trava de host é deliberada: este script recusa qualquer banco que não seja
 * localhost. Rodar isto contra a base do provedor inventaria atendimento,
 * incidente e usuário no meio de dado real.
 */
import { randomUUID, scrypt } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const scryptAsync = promisify(scrypt);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) { console.error("DATABASE_URL não definida."); process.exit(1); }
const host = new URL(DATABASE_URL).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`Recusado: "${host}" não é localhost. Este seed é só para banco descartável de desenvolvimento.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
const now = Date.now();
/** Datas espalhadas para que os filtros de 24h / 7d / 30d mostrem números diferentes. */
const daysAgo = (days, hour = 10) => new Date(now - days * 86400000 - hour * 3600000).toISOString();
const pick = (list, index) => list[index % list.length];

async function hash(password) {
  const salt = randomUUID().replace(/-/g, "");
  const derived = await scryptAsync(password, salt, 64);
  return { hash: derived.toString("hex"), salt };
}

const CIDADES = [
  ["Itabaiana", "Centro"], ["Itabaiana", "Bairro Industrial"], ["Aracaju", "Farolândia"],
  ["Aracaju", "Atalaia"], ["Campo do Brito", "Centro"], ["Frei Paulo", "Centro"],
];

/** Mensagens no estilo de quem escreve de verdade — informal, com erro e abreviação. */
const CONVERSAS = [
  ["oi, ta sem net aqui em casa desde ontem", "technical_no_connection", true, "low_intent_confidence"],
  ["bom dia! minha internet ta muito ruim, trava direto pra assistir", "technical_slow", false, null],
  ["nao ta pegando nada", "technical_no_connection", true, "low_intent_confidence"],
  ["manda o codigo pro pagamento ai por favor", "financial_pix", false, null],
  ["ja fiz o pagamento ontem mas continua bloqueado", "financial_unlock", true, "low_intent_confidence"],
  ["queria a conta desse mes", "financial_invoice", false, null],
  ["no meu quarto o wifi nao chega direito", "technical_wifi", false, null],
  ["quero falar com alguem", "human_handoff", true, "customer_requested_human"],
  ["to pensando em cancelar, ta caro demais", "cancellation_risk", true, "cancellation_risk"],
  ["vcs atendem em qual regiao?", "general_information", true, "low_intent_confidence"],
  ["segunda via do boleto pfvr", "financial_invoice", false, null],
  ["ta caindo toda hora, ja reiniciei o modem", "technical_no_connection", false, null],
  ["isso é um absurdo, terceiro dia sem internet", "complaint", true, "customer_irritated"],
  ["me passa os dados do cliente do apartamento 302", "unauthorized_request", true, "unauthorized_request"],
];

async function main() {
  await client.connect();
  console.log(`Semeando ${host}…`);

  // Limpa só o que este script cria, para poder rodar de novo sem duplicar.
  for (const table of ["csat_ratings", "conversation_outcomes", "channel_messages", "channel_idempotency_keys",
    "audit_events", "network_incidents", "knowledge_documents", "leads", "collection_rule_steps",
    "collection_rules", "collection_campaigns", "password_reset_requests", "sessions", "users"]) {
    await client.query(`DELETE FROM ${table}`);
  }

  // ---- Usuários -----------------------------------------------------------
  const senha = await hash("desenvolvimento-local-123");
  const usuarios = [
    ["Vinícius Lima Santos", "vinicius@bbnet.dev", "Administrador", true, false],
    ["Breno Moura", "breno@bbnet.dev", "Administrador", true, false],
    ["Camila Torres", "camila@bbnet.dev", "Supervisor", true, false],
    ["Diego Nunes", "diego@bbnet.dev", "Atendente", true, true],
    ["Elaine Prado", "elaine@bbnet.dev", "Cobrança", true, false],
    ["Fábio Rocha", "fabio@bbnet.dev", "Comercial", true, false],
    ["Gisele Amorim", "gisele@bbnet.dev", "Suporte", false, false],
    ["Heitor Vilela", "heitor@bbnet.dev", "Somente leitura", true, false],
  ];
  for (const [i, [name, email, role, active, mustChange]] of usuarios.entries()) {
    await client.query(
      `INSERT INTO users (id,email,name,role,password_hash,password_salt,active,must_change_password,last_login_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [randomUUID(), email, name, role, senha.hash, senha.salt, active, mustChange,
        i < 4 ? daysAgo(i) : null, daysAgo(60 - i)],
    );
  }

  await client.query(
    `INSERT INTO password_reset_requests (id,email,status,created_at) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)`,
    [randomUUID(), "diego@bbnet.dev", "pending", daysAgo(0, 3),
      randomUUID(), "naoexiste@bbnet.dev", "pending", daysAgo(1, 5)],
  );

  // ---- Conversas do canal -------------------------------------------------
  // Modo observação: a resposta fica como "suggestion" e o desfecho é "suggested".
  let conversas = 0;
  for (let i = 0; i < 46; i++) {
    const [texto, intent, handoff, motivo] = pick(CONVERSAS, i);
    const dia = i < 6 ? 0 : i < 18 ? Math.floor(i / 6) : Math.floor(i / 2);
    const quando = daysAgo(dia, i % 20);
    const conversaId = `5579${900000000 + i * 7331}`;
    const correlacao = randomUUID();

    await client.query(
      `INSERT INTO channel_messages (id,channel,external_conversation_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), "n8n-whatsapp", conversaId, "customer", texto, quando],
    );
    await client.query(
      `INSERT INTO channel_messages (id,channel,external_conversation_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), "n8n-whatsapp", conversaId, "suggestion",
        handoff ? "Vou transferir você para um atendente que pode ajudar melhor com isso." :
          "Consegui localizar seu cadastro. Vou verificar isso agora e te retorno com o resultado.",
        new Date(new Date(quando).getTime() + 4000).toISOString()],
    );
    await client.query(
      `INSERT INTO conversation_outcomes (id,channel,external_conversation_id,intent,final_status,handoff,handoff_reason,correlation_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), "n8n-whatsapp", conversaId, intent, "suggested", handoff, motivo, correlacao, quando],
    );
    // Poucas notas: coerente com o modo observação, em que a pergunta de CSAT não é feita.
    if (i % 9 === 3) {
      await client.query(
        `INSERT INTO csat_ratings (id,channel,external_conversation_id,score,created_at) VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), "n8n-whatsapp", conversaId, [5, 4, 5, 3, 2][i % 5], quando],
      );
    }
    await client.query(
      `INSERT INTO audit_events (id,actor_id,role,action,entity,reason,correlation_id,result,origin,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), "n8n-channel", "system", "channel.message.processed", `conversation:${conversaId}`,
        "Mensagem recebida via canal n8n/WhatsApp; resposta apenas sugerida, não enviada", correlacao, "suggested", "ia", quando],
    );
    conversas++;
  }

  // ---- Massivas -----------------------------------------------------------
  const massivas = [
    ["Rompimento de fibra no anel norte", "critical", "investigating", 0, 340, "OLT-ITA-02 / PON 4"],
    ["Queda de energia na estação de Campo do Brito", "high", "monitoring", 1, 85, "OLT-CBR-01"],
    ["Manutenção programada — troca de switch", "medium", "resolved", 6, 120, "SW-ARA-07"],
  ];
  for (const [i, [title, severity, status, dia, afetados, equip]] of massivas.entries()) {
    const [city, neighborhood] = pick(CIDADES, i);
    await client.query(
      `INSERT INTO network_incidents (id,title,severity,status,city,neighborhood,equipment,affected_customers,started_at,ended_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$9)`,
      [randomUUID(), title, severity, status, city, neighborhood, equip, afetados, daysAgo(dia),
        status === "resolved" ? daysAgo(dia - 1) : null],
    );
  }

  // ---- Base de conhecimento ----------------------------------------------
  const docs = [
    ["Procedimento: cliente sem conexão", "tecnico", "Confirmar luz do equipamento, checar se há massiva na região, orientar reinício, e abrir OS se persistir.", "published"],
    ["Política de desbloqueio por confiança", "financeiro", "Desbloqueio de confiança pode ser concedido uma vez a cada 6 meses, para contratos sem histórico de inadimplência recorrente.", "published"],
    ["Prazos de instalação por cidade", "comercial", "Itabaiana e Campo do Brito: até 3 dias úteis. Aracaju: até 5 dias úteis.", "published"],
    ["Roteiro de retenção", "comercial", "Rascunho em revisão pela supervisão.", "draft"],
  ];
  for (const [title, category, content, status] of docs) {
    await client.query(
      `INSERT INTO knowledge_documents (id,title,category,content,status,version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$6)`,
      [randomUUID(), title, category, content, status, daysAgo(20)],
    );
  }

  // ---- Leads --------------------------------------------------------------
  const estagios = ["novo", "contatado", "qualificado", "proposta", "ganho", "perdido"];
  const origens = ["indicacao", "whatsapp", "instagram", "porta-a-porta", "site"];
  for (let i = 0; i < 24; i++) {
    const [city, neighborhood] = pick(CIDADES, i);
    await client.query(
      `INSERT INTO leads (id,name,masked_phone,city,neighborhood,source,stage,score,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [randomUUID(), `Interessado ${String(i + 1).padStart(2, "0")}`, `(79) *****-${1000 + i}`,
        city, neighborhood, pick(origens, i), pick(estagios, i), 40 + (i * 7) % 60, daysAgo(i % 28)],
    );
  }

  // ---- Régua de cobrança e campanhas -------------------------------------
  const ruleId = randomUUID();
  await client.query(
    `INSERT INTO collection_rules (id,name,status,version,author_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [ruleId, "Régua padrão de inadimplência", "active", 2, "seed-dev", daysAgo(30)],
  );
  const passos = [[-3, "whatsapp", "lembrete-vencimento"], [1, "whatsapp", "aviso-atraso"], [7, "whatsapp", "aviso-bloqueio"], [15, "ligacao", "negociacao"]];
  for (const [offset, channel, template] of passos) {
    await client.query(
      `INSERT INTO collection_rule_steps (id,rule_id,offset_days,channel,template_id,attempts,active,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,1,true,$6,$6)`,
      [randomUUID(), ruleId, offset, channel, template, daysAgo(30)],
    );
  }
  for (const [name, segment, status, audience, cents] of [
    ["Recuperação — vencidos há 30+ dias", "vencidos-30", "completed", 412, 2874000],
    ["Lembrete de vencimento — agosto", "a-vencer", "running", 1180, 0],
  ]) {
    await client.query(
      `INSERT INTO collection_campaigns (id,name,segment,status,audience,recovered_cents,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [randomUUID(), name, segment, status, audience, cents, daysAgo(12)],
    );
  }

  // ---- Auditoria de ações humanas ----------------------------------------
  for (const [i, [action, entity, reason, result]] of [
    ["user.created", "user:diego@bbnet.dev", "Conta criada pela administração", "success"],
    ["user.password.reset", "user:diego@bbnet.dev", "Senha resetada a pedido", "success"],
    ["incident.created", "incident:anel-norte", "Massiva registrada pela operação", "success"],
    ["auth.login.failed", "user:desconhecido@bbnet.dev", "Credenciais inválidas", "denied"],
  ].entries()) {
    await client.query(
      `INSERT INTO audit_events (id,actor_id,role,action,entity,reason,correlation_id,result,origin,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), "vinicius@bbnet.dev", "Administrador", action, entity, reason, randomUUID(), result, "humano", daysAgo(i)],
    );
  }

  console.log(`Pronto: ${usuarios.length} usuários, ${conversas} conversas, ${massivas.length} massivas, ${docs.length} documentos, 24 leads.`);
  console.log("Login de desenvolvimento: vinicius@bbnet.dev / desenvolvimento-local-123");
  await client.end();
}

main().catch(async (error) => { console.error(error); await client.end().catch(() => {}); process.exit(1); });
