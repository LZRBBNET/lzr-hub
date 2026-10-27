import { createHash, randomUUID } from "node:crypto";
import { sanitizeHandoffText } from "../agent/handoff.ts";
import { businessToday } from "./billing-service.ts";
import { can, roles, type Role } from "./rbac.ts";
import { CASE_REASONS, CASE_STATUSES, type RecoveryCaseMutation, type RecoveryCaseMutationPayload, type RecoveryCaseEventType, type SupervisedRecoveryCase } from "./recovery-cases-shared.ts";
import type { RecoveryCaseRecord, RecoveryCasesRepository, RecoveryCaseListQuery, LegacyAttendanceReference, RecoveryCaseEventRecord } from "./recovery-cases-repository.ts";

const IXC_ID = /^[1-9]\d{0,31}$/;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ATTENDANCE_PROTOCOL = /^\d{14,18}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
export const CASE_LINK_LIMIT = 20;
export const CASE_HISTORY_LIMIT = 100;
export class RecoveryCaseError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 503;
  constructor(status: RecoveryCaseError["status"], message: string) { super(message); this.name = "RecoveryCaseError"; this.status = status; }
}
export interface RecoveryCaseActor { id: string; role: string }
export interface RecoveryCaseSource {
  getCustomerRecord(customerId: string, correlationId: string): Promise<Record<string, unknown> | undefined>;
  getInvoiceForCustomer(customerId: string, invoiceId: string, correlationId: string): Promise<{ id: string; customerId: string; status: string } | undefined>;
}
export function resolveRecoveryCaseScope(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env.RECOVERY_CASE_SCOPE_ID?.trim(); return value && /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(value) ? value : undefined;
}
const fail = (status: RecoveryCaseError["status"], text: string): never => { throw new RecoveryCaseError(status, text); };
function identifier(raw: unknown, pattern: RegExp, label: string): string {
  if (typeof raw !== "string" || !pattern.test(raw.trim())) return fail(400, `${label} inválido.`); return raw.trim();
}
function date(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fail(400, "Informe uma data de calendário válida.");
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return fail(400, "Informe uma data de calendário válida."); return raw;
}
function note(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 1000) return fail(400, "Relato deve ter entre 1 e 1000 caracteres.");
  const value = sanitizeHandoffText(raw).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  if (!value) return fail(400, "Relato vazio."); return value.slice(0, 1000);
}
export function parseRecoveryCaseMutation(raw: unknown): RecoveryCaseMutation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "Solicitação inválida.");
  const body = raw as Record<string, unknown>;
  const idempotencyKey = identifier(body.idempotencyKey, IDEMPOTENCY_KEY, "Identificador da solicitação");
  const extra: Record<string, string[]> = { open: ["customerId", "reason"], claim: ["takeOver"], schedule: ["nextActionOn"], note: ["text"], link_invoice: ["invoiceId"], link_promise: ["promiseId"], link_attendance: ["protocol"], close: ["reason"], reopen: [] };
  const action = typeof body.action === "string" ? body.action : "";
  if (!Object.hasOwn(extra, action)) return fail(400, "Ação inválida.");
  const allowed = new Set(["action", "idempotencyKey", ...(action === "open" ? [] : ["caseId", "version"]), ...extra[action]]);
  if (Object.keys(body).some(key => !allowed.has(key))) return fail(400, "A solicitação contém campos não permitidos.");
  if (action === "open") {
    if (!CASE_REASONS.some(reason => reason === body.reason)) return fail(400, "Motivo inválido.");
    return { action, idempotencyKey, customerId: identifier(body.customerId, IXC_ID, "Cliente"), reason: body.reason as "debt" | "cancellation" | "both" };
  }
  if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 1) return fail(400, "Versão inválida. Atualize o caso.");
  const base = { idempotencyKey, caseId: identifier(body.caseId, LOCAL_ID, "Caso"), version: body.version };
  switch (action) {
    case "claim": if (body.takeOver !== undefined && typeof body.takeOver !== "boolean") return fail(400, "Confirmação de transferência inválida."); return { ...base, action, takeOver: body.takeOver === true };
    case "schedule": return { ...base, action, nextActionOn: date(body.nextActionOn) };
    case "note": return { ...base, action, text: note(body.text) };
    case "link_invoice": return { ...base, action, invoiceId: identifier(body.invoiceId, IXC_ID, "Fatura") };
    case "link_promise": return { ...base, action, promiseId: identifier(body.promiseId, LOCAL_ID, "Promessa") };
    case "link_attendance": return { ...base, action, protocol: identifier(body.protocol, ATTENDANCE_PROTOCOL, "Protocolo do atendimento") };
    case "close": return { ...base, action, reason: note(body.reason) };
    case "reopen": return { ...base, action };
    default: return fail(400, "Ação inválida.");
  }
}
export function parseRecoveryCaseList(params: URLSearchParams): RecoveryCaseListQuery {
  const number = (key: string, fallback: number, max: number) => {
    const raw = params.get(key); if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) return fail(400, "Paginação inválida."); return Number(raw);
  };
  const status = params.get("status") ?? "active";
  if (![...CASE_STATUSES, "active", "all"].includes(status)) return fail(400, "Filtro de estado inválido.");
  return { page: number("page", 1, 100000), pageSize: number("pageSize", 20, 50), status: status as RecoveryCaseListQuery["status"],
    ...(params.has("customerId") ? { customerId: identifier(params.get("customerId"), IXC_ID, "Cliente") } : {}) };
}
function verifiedAttendance(ticket: LegacyAttendanceReference | undefined, customerId: string) {
  return !!ticket && ticket.identification === "identified" && ticket.ixcCustomerId === customerId && ticket.channel === "n8n-whatsapp" && /^\d{10,15}$/.test(ticket.externalConversationId);
}
export async function presentRecoveryCase(repository: RecoveryCasesRepository, record: RecoveryCaseRecord): Promise<SupervisedRecoveryCase> {
  // Legacy attendance has no tenant column. Link is usable only inside this configured single-installation DB and while same-customer identity still holds.
  const ticket = record.attendanceTicketId ? await repository.attendance(record.attendanceTicketId).catch(() => undefined) : undefined;
  // A protocol is historical, while navigation opens the whole phone conversation.
  // Do not expose it if a later ticket identifies another customer or has no identity.
  const latest = verifiedAttendance(ticket, record.customerId) && ticket!.id === record.attendanceTicketId
    ? await repository.latestAttendance(ticket!.channel, ticket!.externalConversationId).catch(() => undefined) : undefined;
  const canNavigate = verifiedAttendance(latest, record.customerId) && latest!.channel === ticket?.channel && latest!.externalConversationId === ticket?.externalConversationId;
  const ownerName = record.ownerId ? await repository.ownerName(record.ownerId).catch(() => null) : null;
  const { scopeId: _scope, ...item } = record; void _scope;
  return { ...item, ownerName, attendance: canNavigate ? { ticketId: ticket!.id, protocol: ticket!.protocol, channel: ticket!.channel, conversationId: ticket!.externalConversationId } : null };
}
function safeEvent(event: RecoveryCaseEventRecord) {
  const { scopeId: _scope, requestHash: _hash, idempotencyKey: _key, correlationId: _corr, ...result } = event;
  void _scope; void _hash; void _key; void _corr; return result;
}
function uniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; cause?: unknown }; return value.code === "23505" || (value.cause !== undefined && value.cause !== error && uniqueViolation(value.cause));
}
export async function mutateRecoveryCase(repository: RecoveryCasesRepository, scopeId: string, actor: RecoveryCaseActor, source: RecoveryCaseSource | undefined,
  input: RecoveryCaseMutation, now: Date = new Date()): Promise<RecoveryCaseMutationPayload> {
  if (!actor?.id) return fail(401, "A fila assistida exige sessão autenticada.");
  if (!mayWrite(actor)) return fail(403, "Seu perfil não permite alterar casos.");
  if (resolveRecoveryCaseScope({ RECOVERY_CASE_SCOPE_ID: scopeId }) !== scopeId) return fail(503, "Escopo da instalação inválido.");
  input = parseRecoveryCaseMutation(input);
  const correlationId = randomUUID(), at = now.toISOString();
  const requestHash = createHash("sha256").update(JSON.stringify({ scopeId, actorId: actor.id, input })).digest("hex");
  const replay = async (repo: RecoveryCasesRepository) => {
    const event = await repo.eventByKey(scopeId, input.idempotencyKey); if (!event) return undefined;
    if (event.actorId !== actor.id || event.requestHash !== requestHash) return fail(409, "Identificador já usado em outra solicitação.");
    const item = await repo.get(scopeId, event.caseId); if (!item) return fail(409, "O resultado anterior não está disponível. Atualize a lista.");
    return { record: item, replay: true };
  };
  const prior = await replay(repository); if (prior) return { item: await presentRecoveryCase(repository, prior.record), replay: true };
  const previous = input.action === "open" ? undefined : await repository.get(scopeId, input.caseId);
  if (input.action !== "open" && !previous) return fail(404, "Caso não encontrado.");
  if (input.action !== "open" && previous && previous.version !== input.version) return fail(409, "O caso mudou. Atualize antes de continuar.");
  let evidence: RecoveryCaseEventRecord["evidence"] = { provenance: "operator_report", receiptConfirmed: false };
  const needSource = input.action === "open" || input.action === "link_invoice" || input.action === "link_promise" || input.action === "link_attendance";
  if (needSource && !source) return fail(503, "IXC indisponível: vínculo não confirmado. Nada foi alterado.");
  async function confirmCustomer(customerId: string) {
    let record; try { record = await source!.getCustomerRecord(customerId, correlationId); } catch { return fail(503, "Não foi possível confirmar o cliente no IXC."); }
    const id = typeof record?.id === "string" ? record.id : typeof record?.id === "number" && Number.isSafeInteger(record.id) ? String(record.id) : "";
    if (id !== customerId) return fail(503, "Identidade do cliente não confirmada no IXC.");
  }
  async function confirmInvoice(customerId: string, invoiceId: string) {
    let invoice; try { invoice = await source!.getInvoiceForCustomer(customerId, invoiceId, correlationId); } catch { return fail(503, "Não foi possível confirmar a fatura no IXC."); }
    if (!invoice || invoice.id !== invoiceId || invoice.customerId !== customerId) return fail(503, "Fatura e cliente não confirmados juntos.");
    return { provenance: "ixc_identity_observation", invoiceId, statusCode: ["A", "R", "C"].includes(invoice.status) ? invoice.status : "unknown", observedAt: at, receiptConfirmed: false };
  }
  if (input.action === "open") { await confirmCustomer(input.customerId); evidence = { ...evidence, reason: input.reason, customerVerifiedAt: at }; }
  if (input.action === "schedule" && input.nextActionOn < businessToday(now)) return fail(400, "O próximo retorno não pode estar no passado.");
  if (input.action === "link_invoice") evidence = await confirmInvoice(previous!.customerId, input.invoiceId);
  let promiseInvoiceId: string | undefined;
  if (input.action === "link_promise") {
    const promise = await repository.promise(input.promiseId);
    if (!promise || promise.customerId !== previous!.customerId || !IXC_ID.test(promise.invoiceId)) return fail(409, "Promessa não pertence ao cliente do caso ou não foi confirmada.");
    promiseInvoiceId = promise.invoiceId; evidence = { ...await confirmInvoice(previous!.customerId, promise.invoiceId), promiseId: promise.id, promiseStatus: ["pending", "fulfilled", "broken"].includes(promise.status) ? promise.status : "unknown" };
  }
  let attendanceTicketId: string | undefined;
  if (input.action === "link_attendance") {
    const ticket = await repository.attendanceByProtocolForCustomer(input.protocol, previous!.customerId);
    if (!verifiedAttendance(ticket, previous!.customerId) || ticket!.protocol !== input.protocol) return fail(409, "Atendimento não encontrado ou não confirmado para este cliente.");
    attendanceTicketId = ticket!.id;
    await confirmCustomer(previous!.customerId); evidence = { provenance: "same_customer_link", ticketId: attendanceTicketId, protocol: input.protocol, receiptConfirmed: false };
  }
  try {
    const result = await repository.transaction(async tx => {
      const repeated = await replay(tx); if (repeated) return repeated;
      let item: RecoveryCaseRecord; let eventType: RecoveryCaseEventType;
      if (input.action === "open") {
        item = await tx.create({ id: randomUUID(), scopeId, customerId: input.customerId, reason: input.reason, status: "open", ownerId: null, nextActionOn: null,
          invoiceIds: [], promiseIds: [], attendanceTicketId: null, openedAt: at, closedAt: null, closingReason: null, version: 1, createdBy: actor.id, updatedAt: at }); eventType = "opened";
      } else {
        const current = await tx.get(scopeId, input.caseId); if (!current) return fail(404, "Caso não encontrado.");
        if (current.version !== input.version) return fail(409, "O caso mudou. Atualize antes de continuar.");
        if (current.status === "closed" && input.action !== "reopen") return fail(409, "Caso encerrado. Reabra antes de alterar.");
        const changes: Partial<RecoveryCaseRecord> = { updatedAt: at };
        switch (input.action) {
          case "claim":
            if (current.ownerId && current.ownerId !== actor.id && !input.takeOver) return fail(409, "Outro operador é responsável. Confirme a transferência explicitamente.");
            changes.ownerId = actor.id; changes.status = "in_progress"; eventType = "claimed";
            evidence = { ...evidence, previousOwnerId: current.ownerId, ownerId: actor.id, takeOver: input.takeOver === true }; break;
          case "schedule": changes.nextActionOn = input.nextActionOn; changes.status = "waiting"; eventType = "scheduled"; evidence = { ...evidence, nextActionOn: input.nextActionOn }; break;
          case "note": eventType = "note"; evidence = { ...evidence, text: input.text }; break;
          case "link_invoice":
            if (current.invoiceIds.includes(input.invoiceId)) return fail(409, "Fatura já vinculada.");
            if (current.invoiceIds.length >= CASE_LINK_LIMIT) return fail(409, "Limite de 20 faturas vinculadas atingido.");
            changes.invoiceIds = [...current.invoiceIds, input.invoiceId]; eventType = "invoice_linked"; break;
          case "link_promise": {
            const latestPromise = await tx.promise(input.promiseId);
            if (!latestPromise || latestPromise.customerId !== current.customerId || latestPromise.invoiceId !== promiseInvoiceId) return fail(409, "O vínculo da promessa mudou. Consulte novamente.");
            if (current.promiseIds.includes(input.promiseId)) return fail(409, "Promessa já vinculada.");
            if (current.promiseIds.length >= CASE_LINK_LIMIT) return fail(409, "Limite de 20 promessas vinculadas atingido.");
            changes.promiseIds = [...current.promiseIds, input.promiseId]; eventType = "promise_linked"; break;
          }
          case "link_attendance": {
            const latestTicket = await tx.attendanceByProtocolForCustomer(input.protocol, current.customerId);
            if (!verifiedAttendance(latestTicket, current.customerId) || latestTicket!.protocol !== input.protocol || latestTicket!.id !== attendanceTicketId) return fail(409, "Atendimento não encontrado ou não confirmado para este cliente.");
            changes.attendanceTicketId = attendanceTicketId; eventType = "attendance_linked"; break;
          }
          case "close": changes.status = "closed"; changes.closedAt = at; changes.closingReason = input.reason; changes.nextActionOn = null; eventType = "closed";
            evidence = { ...evidence, reason: input.reason, outcomeVerified: false }; break;
          case "reopen":
            if (current.status !== "closed") return fail(409, "Caso já está aberto.");
            changes.status = "open"; changes.closedAt = null; changes.closingReason = null; changes.nextActionOn = null; eventType = "reopened"; break;
        }
        const updated = await tx.update(scopeId, current.id, input.version, changes); if (!updated) return fail(409, "O caso mudou. Atualize antes de continuar."); item = updated;
      }
      await tx.append({ id: randomUUID(), scopeId, caseId: item.id, type: eventType, actorId: actor.id, createdAt: at, correlationId, idempotencyKey: input.idempotencyKey, requestHash, evidence });
      return { record: item, replay: false };
    });
    // Optional presentation lookups run only after COMMIT. A failed SELECT
    // inside a PostgreSQL transaction would abort it even if caught in JS.
    return { item: await presentRecoveryCase(repository, result.record), replay: result.replay };
  } catch (error) {
    if (uniqueViolation(error)) { const repeated = await replay(repository); if (repeated) return { item: await presentRecoveryCase(repository, repeated.record), replay: true }; return fail(409, "Já existe um caso ativo para este cliente. Atualize a lista."); }
    throw error;
  }
}

export interface RecoveryCasesDependencies {
  authorize(request: Request, permission: string): Promise<{ allowed: false; status: number; error: string } | { allowed: true; user?: RecoveryCaseActor }>;
  getRepository(): Promise<RecoveryCasesRepository>;
  getSource(): RecoveryCaseSource | undefined;
  getScope?: () => string | undefined;
  now?: () => Date;
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
const mayWrite = (actor: RecoveryCaseActor) => roles.some(role => role === actor.role) && can(actor.role as Role, "billing.write-demo");
export function createRecoveryCasesHandlers(deps: RecoveryCasesDependencies) {
  async function access(request: Request, write: boolean) {
    const guard = await deps.authorize(request, write ? "billing.write-demo" : "customer.read");
    if (!guard.allowed) return { response: json({ error: guard.error }, guard.status) };
    if (!guard.user || !guard.user.id) return { response: json({ error: "A fila assistida exige sessão autenticada." }, 401) };
    if (write && !mayWrite(guard.user)) return { response: json({ error: "Seu perfil não permite alterar casos." }, 403) };
    const rawScope = (deps.getScope ?? resolveRecoveryCaseScope)();
    const scopeId = resolveRecoveryCaseScope({ RECOVERY_CASE_SCOPE_ID: rawScope });
    return { actor: guard.user, scopeId };
  }
  return {
    GET: async (request: Request): Promise<Response> => {
      try {
        const auth = await access(request, false); if (auth.response) return auth.response;
        const params = new URL(request.url).searchParams;
        const info = { canWrite: mayWrite(auth.actor!), currentActorId: auth.actor!.id };
        if (!auth.scopeId) return json({ available: false, detail: "Escopo da instalação não configurado. A fila assistida permanece desabilitada.", items: [], item: null, events: [], historyTruncated: false, total: null, page: 1, pageSize: 20, ...info });
        const repository = await deps.getRepository();
        if (params.has("id")) {
          const id = identifier(params.get("id"), LOCAL_ID, "Caso"); const record = await repository.get(auth.scopeId, id); if (!record) return json({ error: "Caso não encontrado." }, 404);
          const history = await repository.history(auth.scopeId, id, CASE_HISTORY_LIMIT + 1);
          return json({ available: true, item: await presentRecoveryCase(repository, record), events: history.slice(0, CASE_HISTORY_LIMIT).map(safeEvent), historyTruncated: history.length > CASE_HISTORY_LIMIT, ...info });
        }
        const query = parseRecoveryCaseList(params); const result = await repository.list(auth.scopeId, query);
        return json({ available: true, items: await Promise.all(result.items.map(item => presentRecoveryCase(repository, item))), total: result.total, page: query.page, pageSize: query.pageSize, ...info });
      } catch (error) { return json({ error: error instanceof RecoveryCaseError ? error.message : "Fila assistida indisponível." }, error instanceof RecoveryCaseError ? error.status : 503); }
    },
    POST: async (request: Request): Promise<Response> => {
      try {
        const auth = await access(request, true); if (auth.response) return auth.response;
        if (!auth.scopeId) return json({ error: "Escopo da instalação não configurado. Nada foi alterado." }, 503);
        const input = parseRecoveryCaseMutation(await request.json().catch(() => null));
        const repository = await deps.getRepository();
        let source; try { source = deps.getSource(); } catch { source = undefined; }
        return json(await mutateRecoveryCase(repository, auth.scopeId, auth.actor!, source, input, (deps.now ?? (() => new Date()))()), input.action === "open" ? 201 : 200);
      } catch (error) { return json({ error: error instanceof RecoveryCaseError ? error.message : "Não foi possível confirmar a alteração. Atualize o caso antes de repetir; use a mesma solicitação para conferir seu resultado." }, error instanceof RecoveryCaseError ? error.status : 503); }
    },
  };
}
