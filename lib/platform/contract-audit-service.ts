import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { contractAuditRuns, contractAudits, syncCheckpoints } from "../../db/schema.ts";
import { evaluateContact, type ContractIssue } from "./contract-audit-shared.ts";

/**
 * Auditoria de contratos: confere, em cada contrato novo do IXC, se o cadastro
 * do cliente tem celular/WhatsApp, e-mail e o Número do endereço no padrão.
 *
 * Funciona por **ponto de parada**: guarda o `id` do último contrato conferido e
 * pede ao IXC os de `id` maior. O ponto avança contrato a contrato, então se o
 * IXC cair no meio nada se perde — a próxima passada continua de onde parou.
 *
 * Também **reconfere** os que ficaram pendentes: o atendente corrige o cadastro
 * no IXC, e a auditoria percebe sozinha e marca como corrigido. O que estava
 * errado na primeira conferência fica guardado (`firstIssues`) — corrigir depois
 * não apaga o fato de o contrato ter nascido incompleto.
 *
 * Cada passada é pequena de propósito: o limite de consultas por minuto ao IXC
 * é **compartilhado** com o atendimento, e uma auditoria gulosa deixaria o
 * atendente sem conseguir identificar o cliente na conversa.
 */

export const NEW_PER_RUN = 8;
export const BASELINE_CONTRACTS = 8;
export const RECHECK_PER_RUN = 5;
/** Contratos já auditados que ainda não tiveram quem criou procurado no log. */
export const BACKFILL_PER_RUN = 10;
/**
 * Teto de consultas ao IXC por passada. Contrato novo custa duas (cadastro e
 * log); o limite do IXC por minuto é dividido com o atendimento, e uma passada
 * que o esgotasse deixaria o atendente sem conseguir identificar o cliente.
 */
export const MAX_IXC_CALLS_PER_RUN = 20;
/**
 * Folga que a auditoria deixa no limite por minuto do IXC. O limite é do processo
 * inteiro: ao abrir o app, o painel inicial já gasta metade dele — medido
 * localmente, a primeira passada parou no limite depois de 15 consultas com o
 * limite em 30. A auditoria pode esperar; o atendente com o cliente na linha, não.
 */
export const RATE_LIMIT_RESERVE = 10;
const CONTRACT_TABLE = "cliente_contrato";
/** Pendência mais velha que isto não é reconferida sozinha — só pelo botão. */
export const RECHECK_WINDOW_DAYS = 30;
/** Passada que começou há menos que isto e não terminou ainda conta como em andamento. */
export const RUN_LOCK_MS = 5 * 60 * 1000;
const CHECKPOINT_PROVIDER = "ixc";
const CHECKPOINT_SUBJECT = "contract-audit";

export type AuditStatus = "ok" | "pending" | "resolved" | "unverified";
export type AuditFilter = AuditStatus | "all";
export type RunTrigger = "manual" | "tela" | "agendado";

export interface AuditedContract { id: string; customerId: string; plan: string | null; status: string | null; createdAt: string | null; sellerId: string | null }

export interface ContractAuditRecord {
  contractId: string;
  customerId: string;
  customerName: string | null;
  plan: string | null;
  contractStatus: string | null;
  contractCreatedAt: string | null;
  sellerId: string | null;
  /** Quem inseriu o contrato, pelo log do IXC. Nulo com `creatorCheckedAt` = o log não tem a inserção. */
  createdBy: string | null;
  creatorCheckedAt: string | null;
  status: AuditStatus;
  issues: ContractIssue[];
  firstIssues: ContractIssue[];
  detail: string | null;
  checks: number;
  firstCheckedAt: string;
  lastCheckedAt: string;
  resolvedAt: string | null;
}

export interface AuditRun {
  id: string; trigger: RunTrigger; actor: string | null; startedAt: string; finishedAt: string | null;
  newChecked: number; rechecked: number; resolved: number; stoppedReason: string | null; correlationId: string;
}

export interface ContractAuditProvider {
  listContractsAfter(afterId: number, limit: number, correlationId: string): Promise<Record<string, unknown>[]>;
  listLatestContracts(limit: number, correlationId: string): Promise<Record<string, unknown>[]>;
  getCustomerRecord(customerId: string, correlationId: string): Promise<Record<string, unknown> | undefined>;
  getRecordCreator(table: string, recordId: string, authorizedCustomerId: string, correlationId: string): Promise<{ operator: string; at: string | null } | undefined>;
  /** Consultas que ainda cabem no minuto, para o app inteiro. Sem isto, só vale o teto da passada. */
  rateLimitRemaining?(): number;
}

export interface CreatorCount { createdBy: string | null; total: number }

export interface ContractAuditRepository {
  getCursor(): Promise<number | null>;
  /** Só avança: um valor menor que o gravado é ignorado. */
  saveCursor(lastId: number, correlationId: string): Promise<void>;
  get(contractId: string): Promise<ContractAuditRecord | undefined>;
  save(record: ContractAuditRecord): Promise<void>;
  /** Pendentes e não verificados conferidos pela primeira vez depois de `sinceIso`, os menos recentes primeiro. */
  listForRecheck(limit: number, sinceIso: string, checkedBeforeIso: string): Promise<ContractAuditRecord[]>;
  list(filter: AuditFilter, limit: number): Promise<ContractAuditRecord[]>;
  counts(): Promise<Record<AuditStatus, number>>;
  /** Auditados que ainda não tiveram o log consultado, os mais novos primeiro. */
  listMissingCreator(limit: number): Promise<ContractAuditRecord[]>;
  /** Pendentes agrupados por quem criou o contrato, os que mais têm primeiro. */
  pendingByCreator(): Promise<CreatorCount[]>;
  runningSince(sinceIso: string): Promise<boolean>;
  startRun(run: Pick<AuditRun, "id" | "trigger" | "actor" | "startedAt" | "correlationId">): Promise<void>;
  finishRun(run: Pick<AuditRun, "id" | "finishedAt" | "newChecked" | "rechecked" | "resolved" | "stoppedReason">): Promise<void>;
  latestRun(): Promise<AuditRun | undefined>;
}

/** Texto do IXC, com as datas vazias dele ("0000-00-00") tratadas como ausentes. */
function text(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result && !result.startsWith("0000-00-00") ? result : null;
}

export function contractFromRow(row: Record<string, unknown>): AuditedContract | undefined {
  const id = String(row.id ?? "").trim();
  const customerId = String(row.id_cliente ?? "").trim();
  if (!/^\d+$/.test(id) || !customerId) return undefined;
  const seller = text(row.id_vendedor);
  return {
    id, customerId,
    plan: text(row.contrato),
    status: text(row.status),
    // `data_cadastro_sistema` é quando o contrato entrou no sistema; `data` fica de reserva.
    createdAt: text(row.data_cadastro_sistema) ?? text(row.data),
    sellerId: seller && seller !== "0" ? seller : null,
  };
}

const contractFromRecord = (record: ContractAuditRecord): AuditedContract => ({
  id: record.contractId, customerId: record.customerId, plan: record.plan, status: record.contractStatus,
  createdAt: record.contractCreatedAt, sellerId: record.sellerId,
});

/**
 * O resultado de uma conferência, a partir do anterior (se houver).
 *
 * - com pendência → `pending`;
 * - sem pendência, mas já teve → `resolved` (a data da correção fica);
 * - sem pendência nunca → `ok`;
 * - cadastro não encontrado → `unverified`, sem inventar pendência.
 */
/**
 * `creator`: `undefined` = o log não foi consultado agora (mantém o que havia);
 * `null` = consultado, e o log não tem a inserção.
 */
export function nextRecord(
  previous: ContractAuditRecord | undefined,
  contract: AuditedContract,
  customer: Record<string, unknown> | undefined,
  nowIso: string,
  creator?: { operator: string } | null,
): ContractAuditRecord {
  const base = {
    contractId: contract.id, customerId: contract.customerId, plan: contract.plan, contractStatus: contract.status,
    contractCreatedAt: contract.createdAt, sellerId: contract.sellerId,
    ...(creator === undefined
      ? { createdBy: previous?.createdBy ?? null, creatorCheckedAt: previous?.creatorCheckedAt ?? null }
      : { createdBy: creator?.operator ?? null, creatorCheckedAt: nowIso }),
    customerName: customer ? text(customer.razao) : previous?.customerName ?? null,
    checks: (previous?.checks ?? 0) + 1,
    firstCheckedAt: previous?.firstCheckedAt ?? nowIso,
    lastCheckedAt: nowIso,
  };
  if (!customer) {
    return { ...base, status: "unverified", issues: [], firstIssues: previous?.firstIssues ?? [], detail: "O cadastro do cliente não foi encontrado no IXC.", resolvedAt: previous?.resolvedAt ?? null };
  }
  const issues = evaluateContact({
    mobile: String(customer.telefone_celular ?? ""),
    whatsapp: String(customer.whatsapp ?? ""),
    email: String(customer.email ?? ""),
    addressNumber: String(customer.numero ?? ""),
  });
  // O retrato da primeira conferência é fato de auditoria e não muda mais — exceto
  // se ela não chegou a ver o cadastro, aí a primeira conferência de verdade é esta.
  const firstIssues = previous && previous.status !== "unverified" ? previous.firstIssues : issues;
  const hadIssues = firstIssues.length > 0 || previous?.status === "pending" || previous?.status === "resolved";
  const status: AuditStatus = issues.length > 0 ? "pending" : hadIssues ? "resolved" : "ok";
  return {
    ...base, status, issues, firstIssues, detail: null,
    resolvedAt: status === "resolved" ? (previous?.status === "resolved" && previous.resolvedAt ? previous.resolvedAt : nowIso) : null,
  };
}

/** Por que a passada parou, em português — a próxima continua do mesmo ponto. */
export function stopReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const code = `${(error as { code?: unknown } | undefined)?.code ?? ""} ${error instanceof Error ? error.message : ""}`;
  if (name === "IxcCustomerNotAllowedError") return "A auditoria precisa da leitura da base inteira do IXC (FEATURE_IXC_FULL_BASE).";
  if (/RATE_LIMIT/i.test(code)) return "Limite de consultas ao IXC por minuto atingido; a próxima verificação continua de onde parou.";
  if (/CIRCUIT/i.test(code)) return "O IXC está instável e as consultas foram pausadas; a próxima verificação continua de onde parou.";
  if (/TIMEOUT/i.test(code)) return "O IXC demorou demais para responder; a próxima verificação continua de onde parou.";
  return "O IXC não respondeu; a próxima verificação continua de onde parou.";
}

/** A passada para por conta própria — não é falha do IXC, e a próxima continua do mesmo ponto. */
class PassStopped extends Error {
  readonly reason: string;
  constructor(reason: string) { super("PASS_STOPPED"); this.name = "PassStopped"; this.reason = reason; }
}

export interface RunOutcome {
  ran: boolean; skipped?: string; runId?: string;
  newChecked: number; rechecked: number; resolved: number;
  /** Contratos já auditados que tiveram quem criou preenchido nesta passada. */
  creatorsFilled: number;
  stoppedReason: string | null;
}

export async function runContractAudit(
  deps: { repository: ContractAuditRepository; provider: ContractAuditProvider; now?: () => Date },
  input: { trigger: RunTrigger; actor?: string | null; correlationId?: string; newLimit?: number; recheckLimit?: number; maxCalls?: number },
): Promise<RunOutcome> {
  const { repository, provider } = deps;
  const now = deps.now ?? (() => new Date());
  const correlationId = input.correlationId ?? randomUUID();
  const outcome: RunOutcome = { ran: false, newChecked: 0, rechecked: 0, resolved: 0, creatorsFilled: 0, stoppedReason: null };

  // Duas passadas ao mesmo tempo (o botão e o agendamento) gastariam o limite do
  // IXC em dobro para conferir as mesmas coisas.
  if (await repository.runningSince(new Date(now().getTime() - RUN_LOCK_MS).toISOString())) {
    return { ...outcome, skipped: "Já há uma verificação em andamento." };
  }
  const startedAt = now().toISOString();
  const runId = randomUUID();
  await repository.startRun({ id: runId, trigger: input.trigger, actor: input.actor ?? null, startedAt, correlationId });
  outcome.ran = true; outcome.runId = runId;

  // Cada consulta ao IXC passa por aqui. Estourou o teto, a passada para e a
  // próxima continua do mesmo ponto — o que sobrou só espera, não se perde.
  let calls = 0;
  const budget = input.maxCalls ?? MAX_IXC_CALLS_PER_RUN;
  const spend = () => {
    if (calls >= budget) throw new PassStopped("A verificação usou o máximo de consultas ao IXC que pode fazer de uma vez; o restante fica para a próxima.");
    if (provider.rateLimitRemaining && provider.rateLimitRemaining() <= RATE_LIMIT_RESERVE) {
      throw new PassStopped("O IXC está sendo muito consultado agora pelo resto do sistema; a verificação parou para não atrapalhar o atendimento e continua na próxima.");
    }
    calls += 1;
  };
  // O mesmo cliente com dois contratos novos é uma consulta só.
  const customers = new Map<string, Promise<Record<string, unknown> | undefined>>();
  const customer = (id: string) => {
    if (!customers.has(id)) { spend(); customers.set(id, provider.getCustomerRecord(id, correlationId)); }
    return customers.get(id)!;
  };
  const creatorOf = async (contractId: string, customerId: string) => {
    spend();
    return (await provider.getRecordCreator(CONTRACT_TABLE, contractId, customerId, correlationId)) ?? null;
  };

  try {
    const cursor = await repository.getCursor();
    spend();
    const rows = cursor === null
      ? await provider.listLatestContracts(BASELINE_CONTRACTS, correlationId)
      : await provider.listContractsAfter(cursor, input.newLimit ?? NEW_PER_RUN, correlationId);
    // Do mais antigo para o mais novo: o ponto de parada só pode avançar em ordem.
    const contracts = rows.map(contractFromRow).filter((item): item is AuditedContract => !!item).sort((a, b) => Number(a.id) - Number(b.id));
    for (const contract of contracts) {
      // Cadastro e log antes de gravar: se o IXC falhar entre os dois, nada é
      // gravado e o ponto não avança — a próxima passada refaz este contrato inteiro.
      const fields = await customer(contract.customerId);
      const creator = await creatorOf(contract.id, contract.customerId);
      await repository.save(nextRecord(await repository.get(contract.id), contract, fields, now().toISOString(), creator));
      await repository.saveCursor(Number(contract.id), correlationId);
      outcome.newChecked += 1;
    }

    const since = new Date(now().getTime() - RECHECK_WINDOW_DAYS * 86_400_000).toISOString();
    for (const previous of await repository.listForRecheck(input.recheckLimit ?? RECHECK_PER_RUN, since, startedAt)) {
      const record = nextRecord(previous, contractFromRecord(previous), await customer(previous.customerId), now().toISOString());
      await repository.save(record);
      outcome.rechecked += 1;
      if (record.status === "resolved" && previous.status !== "resolved") outcome.resolved += 1;
    }

    // Contratos auditados antes de existir esta coluna, ou cujo log falhou: quem
    // criou não muda, então basta procurar uma vez.
    for (const previous of await repository.listMissingCreator(BACKFILL_PER_RUN)) {
      const creator = await creatorOf(previous.contractId, previous.customerId);
      await repository.save({ ...previous, createdBy: creator?.operator ?? null, creatorCheckedAt: now().toISOString() });
      if (creator) outcome.creatorsFilled += 1;
    }
  } catch (error) {
    outcome.stoppedReason = error instanceof PassStopped ? error.reason : stopReason(error);
  } finally {
    await repository.finishRun({ id: runId, finishedAt: now().toISOString(), newChecked: outcome.newChecked, rechecked: outcome.rechecked, resolved: outcome.resolved, stoppedReason: outcome.stoppedReason }).catch(() => undefined);
  }
  return outcome;
}

/** Reconfere um contrato agora, pelo botão — sem esperar a próxima passada. */
export async function recheckContract(
  deps: { repository: ContractAuditRepository; provider: ContractAuditProvider; now?: () => Date },
  contractId: string,
): Promise<ContractAuditRecord | undefined> {
  const previous = await deps.repository.get(contractId);
  if (!previous) return undefined;
  const correlationId = randomUUID();
  const fields = await deps.provider.getCustomerRecord(previous.customerId, correlationId);
  // Quem criou não muda: só procura se ainda não procurou.
  const creator = previous.creatorCheckedAt ? undefined : (await deps.provider.getRecordCreator(CONTRACT_TABLE, previous.contractId, previous.customerId, correlationId)) ?? null;
  const record = nextRecord(previous, contractFromRecord(previous), fields, (deps.now ?? (() => new Date()))().toISOString(), creator);
  await deps.repository.save(record);
  return record;
}

/* ------------------------------------------------------------- banco --- */

type Row = typeof contractAudits.$inferSelect;
const fromRow = (row: Row): ContractAuditRecord => ({
  contractId: row.contractId, customerId: row.customerId, customerName: row.customerName, plan: row.plan,
  contractStatus: row.contractStatus, contractCreatedAt: row.contractCreatedAt, sellerId: row.sellerId,
  createdBy: row.createdBy, creatorCheckedAt: row.creatorCheckedAt,
  status: row.status as AuditStatus, issues: (row.issues ?? []) as ContractIssue[], firstIssues: (row.firstIssues ?? []) as ContractIssue[],
  detail: row.detail, checks: row.checks, firstCheckedAt: row.firstCheckedAt, lastCheckedAt: row.lastCheckedAt, resolvedAt: row.resolvedAt,
});

export class DbContractAuditRepository implements ContractAuditRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  constructor(db: unknown) { this.db = db; }

  async getCursor(): Promise<number | null> {
    const rows = await this.db.select({ cursor: syncCheckpoints.cursorMasked }).from(syncCheckpoints)
      .where(and(eq(syncCheckpoints.provider, CHECKPOINT_PROVIDER), eq(syncCheckpoints.subjectId, CHECKPOINT_SUBJECT))).limit(1);
    const value = Number(rows[0]?.cursor);
    return rows[0] && Number.isFinite(value) ? value : null;
  }

  async saveCursor(lastId: number, correlationId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(syncCheckpoints).values({
      id: `${CHECKPOINT_PROVIDER}:${CHECKPOINT_SUBJECT}`, provider: CHECKPOINT_PROVIDER, subjectId: CHECKPOINT_SUBJECT,
      cursorMasked: String(lastId), lastSuccessAt: now, lastAttemptAt: now, status: "ok", correlationId, updatedAt: now,
    }).onConflictDoUpdate({
      target: [syncCheckpoints.provider, syncCheckpoints.subjectId],
      // Só avança: duas passadas fora de ordem não fazem o ponto voltar.
      set: { cursorMasked: sql`greatest(coalesce(nullif(${syncCheckpoints.cursorMasked}, '')::bigint, 0), ${lastId})::text`, lastSuccessAt: now, lastAttemptAt: now, status: "ok", correlationId, updatedAt: now },
    });
  }

  async get(contractId: string) {
    const rows = await this.db.select().from(contractAudits).where(eq(contractAudits.contractId, contractId)).limit(1);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async save(record: ContractAuditRecord): Promise<void> {
    const update: Partial<ContractAuditRecord> = { ...record };
    delete update.contractId;
    await this.db.insert(contractAudits).values(record).onConflictDoUpdate({ target: contractAudits.contractId, set: update });
  }

  async listForRecheck(limit: number, sinceIso: string, checkedBeforeIso: string) {
    const rows = await this.db.select().from(contractAudits)
      .where(and(inArray(contractAudits.status, ["pending", "unverified"]), gte(contractAudits.firstCheckedAt, sinceIso), lt(contractAudits.lastCheckedAt, checkedBeforeIso)))
      .orderBy(asc(contractAudits.lastCheckedAt)).limit(limit);
    return rows.map(fromRow);
  }

  async list(filter: AuditFilter, limit: number) {
    const query = this.db.select().from(contractAudits);
    const rows = await (filter === "all" ? query : query.where(eq(contractAudits.status, filter)))
      .orderBy(desc(sql`cast(${contractAudits.contractId} as bigint)`)).limit(limit);
    return rows.map(fromRow);
  }

  async counts() {
    const rows = await this.db.select({ status: contractAudits.status, total: sql<number>`count(*)` }).from(contractAudits).groupBy(contractAudits.status);
    const result: Record<AuditStatus, number> = { ok: 0, pending: 0, resolved: 0, unverified: 0 };
    for (const row of rows) if (row.status in result) result[row.status as AuditStatus] = Number(row.total);
    return result;
  }

  async listMissingCreator(limit: number) {
    const rows = await this.db.select().from(contractAudits).where(isNull(contractAudits.creatorCheckedAt))
      .orderBy(desc(sql`cast(${contractAudits.contractId} as bigint)`)).limit(limit);
    return rows.map(fromRow);
  }

  async pendingByCreator(): Promise<CreatorCount[]> {
    const rows = await this.db.select({ createdBy: contractAudits.createdBy, total: sql<number>`count(*)` }).from(contractAudits)
      .where(eq(contractAudits.status, "pending")).groupBy(contractAudits.createdBy).orderBy(desc(sql`count(*)`));
    return rows.map((row: { createdBy: string | null; total: number }) => ({ createdBy: row.createdBy, total: Number(row.total) }));
  }

  async runningSince(sinceIso: string) {
    const rows = await this.db.select({ id: contractAuditRuns.id }).from(contractAuditRuns)
      .where(and(isNull(contractAuditRuns.finishedAt), gte(contractAuditRuns.startedAt, sinceIso))).limit(1);
    return rows.length > 0;
  }

  async startRun(run: Pick<AuditRun, "id" | "trigger" | "actor" | "startedAt" | "correlationId">) {
    await this.db.insert(contractAuditRuns).values({ ...run, newChecked: 0, rechecked: 0, resolved: 0, stoppedReason: null, finishedAt: null });
  }

  async finishRun(run: Pick<AuditRun, "id" | "finishedAt" | "newChecked" | "rechecked" | "resolved" | "stoppedReason">) {
    const { id, ...rest } = run;
    await this.db.update(contractAuditRuns).set(rest).where(eq(contractAuditRuns.id, id));
  }

  async latestRun() {
    const rows = await this.db.select().from(contractAuditRuns).orderBy(desc(contractAuditRuns.startedAt)).limit(1);
    return rows[0] as AuditRun | undefined;
  }
}

export class MemoryContractAuditRepository implements ContractAuditRepository {
  cursor: number | null = null;
  readonly records = new Map<string, ContractAuditRecord>();
  readonly runs: AuditRun[] = [];
  async getCursor() { return this.cursor; }
  async saveCursor(lastId: number) { this.cursor = Math.max(this.cursor ?? 0, lastId); }
  async get(contractId: string) { return this.records.get(contractId); }
  async save(record: ContractAuditRecord) { this.records.set(record.contractId, record); }
  async listForRecheck(limit: number, sinceIso: string, checkedBeforeIso: string) {
    return [...this.records.values()]
      .filter((r) => (r.status === "pending" || r.status === "unverified") && r.firstCheckedAt >= sinceIso && r.lastCheckedAt < checkedBeforeIso)
      .sort((a, b) => a.lastCheckedAt.localeCompare(b.lastCheckedAt)).slice(0, limit);
  }
  async list(filter: AuditFilter, limit: number) {
    return [...this.records.values()].filter((r) => filter === "all" || r.status === filter)
      .sort((a, b) => Number(b.contractId) - Number(a.contractId)).slice(0, limit);
  }
  async counts() {
    const result: Record<AuditStatus, number> = { ok: 0, pending: 0, resolved: 0, unverified: 0 };
    for (const record of this.records.values()) result[record.status] += 1;
    return result;
  }
  async listMissingCreator(limit: number) {
    return [...this.records.values()].filter((r) => !r.creatorCheckedAt).sort((a, b) => Number(b.contractId) - Number(a.contractId)).slice(0, limit);
  }
  async pendingByCreator() {
    const totals = new Map<string | null, number>();
    for (const record of this.records.values()) if (record.status === "pending") totals.set(record.createdBy, (totals.get(record.createdBy) ?? 0) + 1);
    return [...totals.entries()].map(([createdBy, total]) => ({ createdBy, total })).sort((a, b) => b.total - a.total);
  }
  async runningSince(sinceIso: string) { return this.runs.some((run) => !run.finishedAt && run.startedAt >= sinceIso); }
  async startRun(run: Pick<AuditRun, "id" | "trigger" | "actor" | "startedAt" | "correlationId">) {
    this.runs.push({ ...run, finishedAt: null, newChecked: 0, rechecked: 0, resolved: 0, stoppedReason: null });
  }
  async finishRun(run: Pick<AuditRun, "id" | "finishedAt" | "newChecked" | "rechecked" | "resolved" | "stoppedReason">) {
    const index = this.runs.findIndex((item) => item.id === run.id);
    if (index >= 0) this.runs[index] = { ...this.runs[index], ...run };
  }
  async latestRun() { return [...this.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]; }
}
