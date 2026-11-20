import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { effectiveState } from "./conversation-state-shared.ts";
import { searchTerm } from "./conversations-service.ts";
import { TRIAGE_QUEUES } from "./triage-shared.ts";

export type QueueView = "fila" | "minhas" | "abertas" | "resolvidas";
export type PageInput = { view?: string; sector?: string; search?: string | null; channel?: string | null; actorId?: string; cursor?: string | null; limit?: number };
export class InvalidConversationCursor extends Error {}
type Cursor = { at: string; channel: string; id: string; scope: string };
const scopeOf = (input: PageInput) => createHash("sha256").update(JSON.stringify([
  input.view ?? "abertas", input.sector ?? "todos", searchTerm(input.search), input.channel ?? null, input.actorId ?? null,
])).digest("hex");
export function decodeConversationCursor(value: string | null | undefined, input: PageInput): Cursor | undefined {
  if (!value) return undefined;
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const c = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (c.scope !== scopeOf(input) || typeof c.at !== "string" || !Number.isFinite(Date.parse(c.at)) || c.at.length > 40
      || typeof c.channel !== "string" || c.channel.length > 100 || typeof c.id !== "string" || c.id.length > 200) throw Error();
    return c;
  } catch { throw new InvalidConversationCursor("Cursor inválido para estes filtros. Volte à primeira página."); }
}
export const encodeConversationCursor = (key: Omit<Cursor, "scope">, input: PageInput) =>
  Buffer.from(JSON.stringify({ ...key, scope: scopeOf(input) })).toString("base64url");

/** One bounded page of summaries. No history content crosses the database boundary. */
export async function conversationPage(db: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }, input: PageInput) {
  const view = input.view ?? "abertas", sector = input.sector ?? "todos";
  if (!["fila", "minhas", "abertas", "resolvidas"].includes(view) || (sector !== "todos" && !(TRIAGE_QUEUES as readonly string[]).includes(sector))) throw new InvalidConversationCursor("Filtro inválido.");
  if (view === "minhas" && !input.actorId) throw new InvalidConversationCursor("A fila Minhas exige usuário identificado.");
  const limit = Math.max(1, Math.min(40, Math.trunc(input.limit ?? 40)));
  if (!Number.isFinite(limit)) throw new InvalidConversationCursor("Tamanho de página inválido.");
  const cursor = decodeConversationCursor(input.cursor, input);
  const term = searchTerm(input.search);
  const pattern = `%${(term?.value ?? "").replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
  const result = await db.execute(sql`
    with grouped as (
      select m.channel, m.external_conversation_id as id, min(m.created_at) as first_at,
        max(m.created_at) as last_at, count(*) as messages,
        max(m.created_at) filter (where m.role = 'customer') as customer_at,
        max(m.created_at) filter (where m.role not in ('customer','suggestion') and m.delivery_status is distinct from 'failed' and not (m.role = 'agent' and coalesce(m.sent_by,'') = 'ia')) as answer_at
      from channel_messages m where m.external_conversation_id not like '%@%'
        and (${input.channel ?? null}::text is null or m.channel = ${input.channel ?? null})
      group by m.channel, m.external_conversation_id
    ), scoped as (
      select g.*, s.status as saved_status, s.resolved_at, s.resolved_by,
        s.assignee_id, s.assignee_name, s.assigned_at,
        (s.status = 'resolved' and (g.customer_at is null or s.resolved_at is null or g.customer_at <= s.resolved_at)) as resolved,
        t.protocol, t.queue, t.stage, t.opened_at, c.display_name,
        ((${sector} = 'todos' or t.queue = ${sector})
          and (${!term} or ${term?.kind === "digits"} and g.id like ${pattern}
            or ${term?.kind === "name"} and c.display_name ilike ${pattern})) as matches_filter,
        (select min(w.created_at) from channel_messages w where w.channel = g.channel and w.external_conversation_id = g.id
          and w.role = 'customer' and (g.answer_at is null or w.created_at > g.answer_at)
          and (s.status is distinct from 'resolved' or s.resolved_at is null or w.created_at > s.resolved_at)) as waiting_at
      from grouped g
      left join conversation_states s on s.channel = g.channel and s.external_conversation_id = g.id
      left join support_tickets t on t.channel = g.channel and t.external_conversation_id = g.id and t.status = 'open'
      left join channel_contacts c on c.channel = g.channel and c.external_conversation_id = g.id
    ), marked as (
      select *, not coalesce(resolved,false) and (waiting_at is not null or stage = 'handoff'
        or saved_status = 'open' and assignee_id is not null) as pending,
        case when saved_status = 'open' then assignee_id end as owner,
        coalesce(waiting_at, case when saved_status = 'open' then assigned_at end, customer_at, opened_at) as pending_at
      from scoped
    ), filtered as (
      select * from marked where matches_filter and (
        (${view} = 'fila' and pending) or (${view} = 'minhas' and not coalesce(resolved,false) and owner = ${input.actorId ?? null})
        or (${view} = 'abertas' and not coalesce(resolved,false)) or (${view} = 'resolvidas' and resolved))
    ), page as (
      select * from filtered
      where ${cursor ? sql`(first_at, channel, id) > (${cursor.at}, ${cursor.channel}, ${cursor.id})` : sql`true`}
      order by first_at, channel, id limit ${limit + 1}
    )
    select (select count(*) from filtered)::int as total,
      (select count(*) from marked where pending)::int as "pendingCount",
      (select count(*) from marked where not coalesce(resolved,false) and owner = ${input.actorId ?? null})::int as "mineCount",
      (select min(pending_at) from marked where pending) as "oldestPendingAt",
      coalesce((select jsonb_agg(jsonb_build_object(
        'firstAt', p.first_at, 'channel', p.channel, 'externalConversationId', p.id, 'lastAt', p.last_at,
        'messages', p.messages, 'lastCustomerAt', p.customer_at, 'displayName', p.display_name,
        'awaitingSince', case when p.pending then p.pending_at end,
        'lastMessage', left(last_msg.content, 500), 'lastRole', last_msg.role, 'lastSentBy', last_msg.sent_by,
        'deliveryStatus', last_msg.delivery_status,
        'lastCustomerMessage', left(customer_msg.content, 500),
        'lastSentByName', case when last_msg.sent_by in ('ia','ia-agente') then 'IA' else sender.name end,
        'handoff', case when p.stage = 'handoff' and not coalesce(p.resolved,false) then true else last_outcome.handoff end, 'intent', last_outcome.intent, 'finalStatus', last_outcome.final_status,
        'stateRow', jsonb_build_object('status', p.saved_status, 'assigneeId', p.assignee_id, 'assigneeName', p.assignee_name,
          'assignedAt', p.assigned_at, 'resolvedAt', p.resolved_at, 'resolvedBy', p.resolved_by),
        'ticket', case when p.stage is not null then jsonb_build_object('protocol', p.protocol, 'queue', p.queue, 'stage', p.stage) end
      ) order by p.first_at, p.channel, p.id)
      from page p left join lateral (
        select content, role, sent_by, delivery_status from channel_messages m where m.channel = p.channel and m.external_conversation_id = p.id
        order by created_at desc, id desc limit 1
      ) last_msg on true
      left join lateral (
        select content from channel_messages m where m.channel = p.channel and m.external_conversation_id = p.id and m.role = 'customer'
        order by created_at desc, id desc limit 1
      ) customer_msg on true
      left join lateral (
        select handoff, intent, final_status from conversation_outcomes o where o.channel = p.channel and o.external_conversation_id = p.id
        order by created_at desc, id desc limit 1
      ) last_outcome on true
      left join lateral (select name from users u where u.email = last_msg.sent_by limit 1) sender on true), '[]'::jsonb) as items
  `);
  const row = (result as { rows: Array<Record<string, unknown>> }).rows[0];
  if (!row || !Array.isArray(row.items)) throw new Error("QUEUE_PAGE_UNAVAILABLE");
  const raw = row.items as Array<Record<string, unknown>>;
  const hasMore = raw.length > limit;
  const selected = raw.slice(0, limit);
  const last = selected.at(-1);
  const nextCursor = hasMore && last ? encodeConversationCursor({ at: String(last.firstAt), channel: String(last.channel), id: String(last.externalConversationId) }, input) : null;
  const items = selected.map(({ firstAt: _firstAt, stateRow, ...item }) => {
    void _firstAt;
    const state = stateRow as Parameters<typeof effectiveState>[0];
    return { ...item, state: effectiveState(state?.status ? state : undefined, item.lastCustomerAt as string | undefined) };
  });
  return { items, nextCursor, hasMore, total: Number(row.total), pendingCount: Number(row.pendingCount), mineCount: Number(row.mineCount), oldestPendingAt: row.oldestPendingAt ?? null };
}
