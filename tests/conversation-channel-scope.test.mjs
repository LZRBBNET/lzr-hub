import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { DbConversationsRepository } from "../lib/platform/conversations-service.ts";

// Real repository + Drizzle SQL generation, with a synthetic read-only pg boundary.
// This is not PostgreSQL execution: rows are fixtures and SQL scope is asserted separately.
const ID = "synthetic-shared-case";
const A = "synthetic-channel-a";
const B = "synthetic-channel-b";
const time = (hour) => `2026-11-05T${hour}:00:00.000Z`;
const message = (channel, role, content, hour, sentBy = null, id = ID) => ({ channel, external_conversation_id: id, role, content, created_at: time(hour), sent_by: sentBy });
const state = (channel, status, name, resolvedAt = null, id = ID) => ({ channel, external_conversation_id: id, status, assignee_id: name ? `synthetic-${name}` : null, assignee_name: name, assigned_at: name ? time("08") : null, resolved_at: resolvedAt, resolved_by: resolvedAt ? name : null });
const contact = (channel, name, id = ID) => ({ channel, external_conversation_id: id, display_name: name });
const outcome = (channel, intent, handoff, hour, id = ID) => ({ channel, external_conversation_id: id, intent, final_status: handoff ? "handoff" : "answered", handoff, created_at: time(hour) });

function fixture(overrides = {}) {
  const data = {
    channel_messages: [message(B, "customer", "Contexto exclusivo B", "12"), message(A, "agent", "Resposta exclusiva A", "10", "ana@example.test"), message(A, "customer", "Contexto exclusivo A", "09")],
    conversation_outcomes: [outcome(B, "human_handoff", true, "12"), outcome(A, "technical_no_connection", false, "09")],
    channel_contacts: [contact(A, "Perfil A"), contact(B, "Perfil B")],
    conversation_states: [state(A, "resolved", "Ana Teste", time("11")), state(B, "open", "Bia Teste")],
    users: [{ email: "ana@example.test", name: "Ana Teste" }],
    ...overrides,
  };
  const calls = [];
  const client = { async query(config, params) {
    const text = config.text;
    calls.push({ text, params });
    assert.match(text, /^select /i, "fixture refuses mutations");
    assert.equal(config.rowMode, "array");
    if (text.includes(" group by ")) {
      const groups = new Map();
      for (const row of data.channel_messages) {
        const key = JSON.stringify([row.channel, row.external_conversation_id]);
        const g = groups.get(key) ?? { ...row, messages: 0 };
        g.messages++;
        if (row.created_at > g.created_at) g.created_at = row.created_at;
        groups.set(key, g);
      }
      return { rows: [...groups.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, params.at(-1)).map(r => [r.channel, r.external_conversation_id, r.created_at, r.messages]) };
    }
    const table = / from "([a-z_]+)"/.exec(text)?.[1];
    assert.ok(Object.hasOwn(data, table), `unexpected table: ${table}`);
    let rows = data[table];
    // Apply pair scope when present, to exercise omitted-page behavior as well.
    const pairs = [...text.matchAll(/"[a-z_]+"\."channel" = \$(\d+) and "[a-z_]+"\."external_conversation_id" = \$(\d+)/g)];
    if (pairs.length) rows = rows.filter(r => pairs.some(m => r.channel === params[Number(m[1]) - 1] && r.external_conversation_id === params[Number(m[2]) - 1]));
    else if (table !== "users") rows = rows.filter(r => params.includes(r.external_conversation_id));
    else rows = rows.filter(r => params.includes(r.email));
    const columns = text.slice(7, text.indexOf(" from ")).split(", ").map(part => {
      const found = [...part.matchAll(/"([a-z_]+)"/g)];
      assert.ok(found.length, `unhandled projection: ${part}`);
      return found.at(-1)[1];
    });
    return { rows: rows.map(r => columns.map(c => r[c] ?? null)) };
  } };
  return { repository: new DbConversationsRepository(drizzle({ client })), calls, data };
}

async function list(overrides = {}, limit = 20) {
  const f = fixture(overrides);
  const rows = await f.repository.listConversations(limit);
  return { ...f, rows, a: rows.find(r => r.channel === A), b: rows.find(r => r.channel === B) };
}

test("mesmo ID em dois canais mantém última mensagem e contexto separados", async () => {
  const { a, b } = await list();
  assert.equal(a.lastMessage, "Resposta exclusiva A");
  assert.equal(a.lastRole, "agent");
  assert.equal(a.lastCustomerMessage, "Contexto exclusivo A");
  assert.equal(a.lastCustomerAt, time("09"));
  assert.equal(b.lastCustomerMessage, "Contexto exclusivo B");
});

test("desfecho e recomendação de humano pertencem ao canal correto", async () => {
  const { a, b } = await list();
  assert.equal(a.intent, "technical_no_connection");
  assert.equal(a.handoff, false);
  assert.equal(b.intent, "human_handoff");
  assert.equal(b.handoff, true);
});

test("fala de outro canal não reabre caso nem remove responsável", async () => {
  const { a, b } = await list();
  assert.equal(a.state.status, "resolved");
  assert.equal(a.state.reopened, false);
  assert.equal(a.state.assigneeName, "Ana Teste");
  assert.equal(b.state.status, "open");
  assert.equal(b.state.assigneeName, "Bia Teste");
});

test("resposta humana no canal A não interrompe espera no canal B", async () => {
  const { a, b } = await list({ channel_messages: [message(A, "agent", "Resposta A", "13", "ana@example.test"), message(B, "customer", "Cliente B esperando", "12"), message(A, "customer", "Cliente A atendido", "09")] });
  assert.equal(a.awaitingSince, undefined);
  assert.equal(b.awaitingSince, time("12"));
});

test("autoria e nome do remetente não migram entre canais", async () => {
  const { a, b } = await list();
  assert.equal(a.lastSentBy, "ana@example.test");
  assert.equal(a.lastSentByName, "Ana Teste");
  assert.equal(b.lastSentBy, undefined);
  assert.equal(b.lastSentByName, undefined);
});

test("sem desfecho no canal A não usa registro do canal B", async () => {
  const { a, b } = await list({ conversation_outcomes: [outcome(B, "human_handoff", true, "12")] });
  assert.equal(a.intent, undefined);
  assert.equal(a.handoff, undefined);
  assert.equal(b.handoff, true);
});

test("consultas auxiliares restringem pares canal+ID selecionados, inclusive página de um canal", async () => {
  const { calls, rows } = await list({}, 1);
  assert.equal(rows.length, 1);
  for (const table of ["channel_messages", "conversation_outcomes", "channel_contacts", "conversation_states"]) {
    const query = calls.find(c => c.text.includes(` from "${table}"`) && !c.text.includes(" group by "));
    assert.match(query.text, new RegExp(`"${table}"\\.\"channel\" = \\$\\d+ and "${table}"\\.\"external_conversation_id\" = \\$\\d+`));
    assert.deepEqual(query.params, [B, ID]);
  }
});

test("busca por perfil correlaciona canal e ID sem buscar contato de outro canal", async () => {
  const f = fixture({ channel_messages: [] });
  await f.repository.listConversations(20, "Perfil A");
  const { text, params } = f.calls[0];
  assert.match(text, /exists \(select/);
  assert.match(text, /"channel_contacts"\."channel" = "channel_messages"\."channel"/);
  assert.match(text, /"channel_contacts"\."external_conversation_id" = "channel_messages"\."external_conversation_id"/);
  assert.ok(params.includes("%Perfil A%"));
});

test("contato, estado e contexto não colidem quando campos contêm dois-pontos", async () => {
  const c1 = "synthetic:alpha", id1 = "case", c2 = "synthetic", id2 = "alpha:case";
  const { rows } = await list({ channel_messages: [message(c2, "customer", "Segundo", "12", null, id2), message(c1, "customer", "Primeiro", "09", null, id1)], channel_contacts: [contact(c1, "Primeiro perfil", id1), contact(c2, "Segundo perfil", id2)], conversation_states: [state(c1, "open", "Primeiro dono", null, id1), state(c2, "open", "Segundo dono", null, id2)], conversation_outcomes: [] });
  assert.equal(rows.find(r => r.channel === c1).displayName, "Primeiro perfil");
  assert.equal(rows.find(r => r.channel === c1).state.assigneeName, "Primeiro dono");
  assert.equal(rows.find(r => r.channel === c2).displayName, "Segundo perfil");
});

test("lista vazia não dispara consultas auxiliares", async () => {
  const { rows, calls } = await list({ channel_messages: [] });
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 1);
});

test("busca numérica continua parametrizada e mantém filtro de grupos", async () => {
  const f = fixture({ channel_messages: [] });
  await f.repository.listConversations(12, "(000) 123");
  assert.match(f.calls[0].text, /not like/);
  assert.ok(f.calls[0].params.includes("%@%"));
  assert.ok(f.calls[0].params.includes("%000123%"));
  assert.equal(f.calls[0].params.at(-1), 12);
});

test("falha de consulta de estado não devolve lista aparentemente completa", async () => {
  const db = drizzle({ client: { async query(config) { if (config.text.includes(" group by ")) return { rows: [[A, ID, time("09"), 1]] }; if (config.text.includes(' from "conversation_states"')) throw new Error("synthetic state read failure"); return { rows: [] }; } } });
  await assert.rejects(new DbConversationsRepository(db).listConversations(20), /synthetic read failure|Failed query/);
});

test("consultas de dois canais conservam pares sem produto cruzado de listas", async () => {
  const { calls } = await list();
  for (const table of ["channel_messages", "conversation_outcomes", "channel_contacts", "conversation_states"]) {
    const query = calls.find(c => c.text.includes(` from "${table}"`) && !c.text.includes(" group by "));
    assert.deepEqual(query.params, [B, ID, A, ID]);
    assert.match(query.text, /\) or \(/);
    assert.doesNotMatch(query.text, / in \(/);
  }
});

test("nova fala no próprio canal continua reabrindo sem responsável antigo", async () => {
  const { a, b } = await list({ channel_messages: [message(A, "customer", "Reabertura A", "13"), message(B, "customer", "Contexto B", "12")] });
  assert.equal(a.state.status, "open");
  assert.equal(a.state.reopened, true);
  assert.equal(a.state.assigneeId, null);
  assert.equal(b.state.assigneeName, "Bia Teste");
});

test("ausência de estado ou perfil em A não herda responsável ou perfil de B", async () => {
  const { a, b } = await list({ conversation_states: [state(B, "open", "Bia Teste")], channel_contacts: [contact(B, "Perfil B")] });
  assert.equal(a.state.assigneeId, null);
  assert.equal(a.displayName, undefined);
  assert.equal(b.state.assigneeName, "Bia Teste");
  assert.equal(b.displayName, "Perfil B");
});

test("dois IDs do mesmo canal conservam contexto e responsável próprios", async () => {
  const other = "synthetic-another-case";
  const { rows } = await list({ channel_messages: [message(A, "customer", "Outro caso", "13", null, other), message(A, "customer", "Caso original", "09")], conversation_states: [state(A, "open", "Dono original"), state(A, "open", "Outro dono", null, other)], channel_contacts: [], conversation_outcomes: [] });
  assert.equal(rows.find(r => r.externalConversationId === ID).lastCustomerMessage, "Caso original");
  assert.equal(rows.find(r => r.externalConversationId === ID).state.assigneeName, "Dono original");
  assert.equal(rows.find(r => r.externalConversationId === other).state.assigneeName, "Outro dono");
});

test("IA e sugestão no próprio canal não apagam espera por humano", async () => {
  const { a, b } = await list({ channel_messages: [message(A, "agent", "Resposta IA A", "14", "ia"), message(B, "suggestion", "Sugestão B", "13"), message(B, "customer", "Cliente B", "12"), message(A, "customer", "Cliente A", "09")], conversation_states: [] });
  assert.equal(a.awaitingSince, time("09"));
  assert.equal(a.lastSentByName, "IA");
  assert.equal(b.awaitingSince, time("12"));
  assert.equal(b.lastRole, "suggestion");
});

test("busca por nome mantém curingas escapados e valores fora do SQL", async () => {
  const f = fixture({ channel_messages: [] });
  await f.repository.listConversations(20, "Teste_%' OR 1=1");
  assert.ok(f.calls[0].params.includes("%Teste\\_\\%' OR 1=1%"));
  assert.doesNotMatch(f.calls[0].text, /Teste|1=1/);
});
