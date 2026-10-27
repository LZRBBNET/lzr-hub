// Test-only IXC-shaped data. Never imported by product code, never proxies a request.
// The fixed token is a fixture discriminator, NOT an external credential.
export const FIXTURE_TOKEN = 'lzr-synthetic-readonly-fixture';
export const FIXTURE_CUSTOMERS = ['910001', '910002'];
export const FIXTURE_ACCOUNTS = [
  { id: 'qa-browser-operator', email: 'operator@lzr-qa.invalid', name: 'SINTÉTICO — Operador QA', role: 'Cobrança' },
  { id: 'qa-browser-reader', email: 'reader@lzr-qa.invalid', name: 'SINTÉTICO — Leitura QA', role: 'Somente leitura' },
];
export const FIXTURE_ATTENDANCES = [
  { id: 'qa-browser-ticket-1', protocol: '20261027000001', customerId: '910001', conversationId: '5500000910001' },
  { id: 'qa-browser-ticket-2', protocol: '20261027000002', customerId: '910002', conversationId: '5500000910002' },
];

export function browserFixtureData(now = new Date()) {
  const day = offset => new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10);
  return {
    cliente: FIXTURE_CUSTOMERS.map((id, i) => ({ id, razao: `SINTÉTICO QA — Cliente ${i + 1}`, cnpj_cpf: 'DOCUMENTO INVÁLIDO — TESTE',
      telefone_celular: `(00) 00091-000${i + 1}`, whatsapp: '', fone: '', telefone_comercial: '', email: `customer-${i + 1}@lzr-qa.invalid`, cidade: '990001', bairro: 'Bairro sintético',
      endereco: 'Rua inexistente de homologação', numero: '0', ativo: 'S', data_cadastro: day(-300) })),
    cliente_contrato: [
      { id: '920001', id_cliente: '910001', id_vd_contrato: '930001', contrato: 'SINTÉTICO — contrato ativo', status: 'A', dia_vencimento: '10', data_ativacao: day(-60) },
      { id: '920002', id_cliente: '910001', id_vd_contrato: '930001', contrato: 'SINTÉTICO — contrato encerrado', status: 'CA', dia_vencimento: '10', data_ativacao: day(-90) },
      { id: '920003', id_cliente: '910002', id_vd_contrato: '930001', contrato: 'SINTÉTICO — contrato ativo', status: 'A', dia_vencimento: '10', data_ativacao: day(-60) },
    ],
    vd_contratos: [{ id: '930001', nome: 'SINTÉTICO — plano de teste', valor_contrato: '100.00' }],
    // 940021 is intentionally outside Customer360's first20. A point lookup must find it.
    fn_areceber: [
      ...Array.from({ length: 21 }, (_, i) => ({ id: String(940001 + i), id_cliente: '910001', id_contrato: '920001',
        status: i === 0 ? 'R' : i === 1 ? 'C' : i === 2 ? '?' : 'A', data_vencimento: day(i === 3 ? 5 : -10),
        valor: '100.00', valor_aberto: i === 0 || i === 1 ? '0.00' : '100.00' })),
      { id: '950001', id_cliente: '910002', id_contrato: '920003', status: 'A', data_vencimento: day(-5), valor: '70.00', valor_aberto: '70.00' },
    ],
    fn_movim_finan: [{ id: '960001', id_receber: '940001', data: `${day(-1)} 10:00:00`, valor: '100.00', tipo_recebimento: 'SINTÉTICO — não é recibo real' }],
    cidade: [{ id: '990001', nome: 'Cidade sintética', uf: '990002' }],
    uf: [{ id: '990002', nome: 'Estado sintético', sigla: 'QA' }],
    radusuarios: FIXTURE_CUSTOMERS.map((id, i) => ({ id: String(970001 + i), id_cliente: id, login: `synthetic-${id}`, online: 'S', ultima_conexao: `${day(-1)} 10:00:00` })),
    su_oss_chamado: [], ixc_logs: [],
  };
}

const EMPTY_FIELDS = { su_oss_chamado: ['id', 'id_cliente', 'status', 'data_abertura'], ixc_logs: ['id', 'id_registro', 'tabela', 'data'] };
const response = (status, body) => ({ status, body });
export function syntheticIxcResponse({ method, path, headers, body }, data) {
  if (!['GET', 'POST'].includes(method) || headers.authorization !== `Basic ${FIXTURE_TOKEN}` || headers.ixcsoft !== 'listar') return response(403, { type: 'error', message: 'Synthetic readonly fixture only' });
  const match = /^\/webservice\/v1\/([a-z_]+)$/.exec(path);
  if (!match || !Object.hasOwn(data, match[1])) return response(404, { type: 'error', message: 'Fixture resource unsupported' });
  const resource = match[1], rows = data[resource], fields = new Set(rows.flatMap(Object.keys).concat(EMPTY_FIELDS[resource] ?? []));
  const field = value => {
    if (typeof value !== 'string') throw new Error('field');
    const parts = value.split('.');
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== resource) || !fields.has(parts.at(-1))) throw new Error('field');
    return parts.at(-1);
  };
  try {
    const query = JSON.parse(body);
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(k => !['qtype', 'query', 'oper', 'page', 'rp', 'sortname', 'sortorder', 'grid_param'].includes(k))) throw new Error('query');
    const page = Number(query.page), size = Number(query.rp);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100 || !Number.isSafeInteger(size) || size < 1 || size > 500) throw new Error('page');
    const filters = [{ TB: query.qtype, OP: query.oper, P: query.query }, ...(query.grid_param ? JSON.parse(query.grid_param) : [])];
    if (filters.length > 10) throw new Error('filters');
    const prepared = filters.map(filter => {
      if (!filter || typeof filter.P !== 'string' || !['=', '!=', '>', '<', '>=', '<=', 'L'].includes(filter.OP)) throw new Error('filter');
      return { key: field(filter.TB), op: filter.OP, value: filter.P };
    });
    const compare = (left, right) => /^\d+$/.test(left) && /^\d+$/.test(right) ? Number(left) - Number(right) : left.localeCompare(right);
    const filtered = rows.filter(row => prepared.every(({ key, op, value }) => {
      const raw = String(row[key] ?? ''), order = compare(raw, value);
      return op === '=' ? raw === value : op === '!=' ? raw !== value : op === '>' ? order > 0 : op === '<' ? order < 0 : op === '>=' ? order >= 0 : op === '<=' ? order <= 0 : raw.toLocaleLowerCase().includes(value.toLocaleLowerCase());
    }));
    const sort = field(query.sortname);
    if (!['asc', 'desc'].includes(query.sortorder)) throw new Error('sort');
    filtered.sort((a, b) => compare(String(a[sort] ?? ''), String(b[sort] ?? '')) * (query.sortorder === 'desc' ? -1 : 1));
    return response(200, { page: String(page), total: String(filtered.length), registros: filtered.slice((page - 1) * size, page * size) });
  } catch { return response(400, { type: 'error', message: 'Fixture query unsupported' }); }
}

// Inserts only. Caller must have passed the real DB gate and hold the verified DB transaction.
// Password hashes are supplied by the approved provisioner, never generated or logged here.
export function browserSeedStatements(credentials, now = new Date()) {
  if (!Array.isArray(credentials) || credentials.length !== 2 || credentials.some(row => !row || !/^[a-f0-9]{128}$/.test(row.hash) || !/^[a-f0-9]{32}$/.test(row.salt))
      || credentials[0].hash === credentials[1].hash || credentials[0].salt === credentials[1].salt) throw new Error('Invalid separate test-only credential hashes');
  const at = now.toISOString();
  const statements = FIXTURE_ACCOUNTS.map((account, i) => ({
    text: 'insert into users (id,email,name,role,password_hash,password_salt,active,must_change_password,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,true,false,$7,$7)',
    values: [account.id, account.email, account.name, account.role, credentials[i].hash, credentials[i].salt, at],
  }));
  const targetAt = new Date(now.getTime() - 120000).toISOString();
  for (const ticket of FIXTURE_ATTENDANCES) {
    statements.push({ text: "insert into support_tickets (id,protocol,channel,external_conversation_id,status,opened_at,last_customer_at,identification,ixc_customer_id,intent,intent_source,intent_confidence,queue,stage) values ($1,$2,'n8n-whatsapp',$3,'open',$4,$4,'identified',$5,'financial_invoice','rules',100,'financeiro','routed')", values: [ticket.id, ticket.protocol, ticket.conversationId, targetAt, ticket.customerId] });
    statements.push({ text: "insert into channel_messages (id,channel,external_conversation_id,role,content,created_at) values ($1,'n8n-whatsapp',$2,'customer',$3,$4)", values: [`message-${ticket.id}`, ticket.conversationId, `SINTÉTICO QA — acompanhamento financeiro do cliente ${ticket.customerId}. Nenhuma pessoa real.`, targetAt] });
  }
  // The legitimate linked target must be outside the inbox's default first40.
  // A direct-case handoff must still open it, never silently show the first unrelated row.
  for (let i = 0; i < 40; i++) statements.push({ text: "insert into channel_messages (id,channel,external_conversation_id,role,content,created_at) values ($1,'n8n-whatsapp',$2,'customer',$3,$4)",
    values: [`qa-browser-newer-message-${i}`, String(5500000800000 + i), `SINTÉTICO QA — conversa não alvo ${i + 1}.`, new Date(now.getTime() - 60000 + i * 1000).toISOString()] });
  // Synthetic historical promise, for reconciliation against the fixture's R status.
  statements.push({ text: "insert into payment_promises (id,invoice_id,customer_id,promised_for,status,registered_by,correlation_id,created_at,updated_at) values ('qa-promise-received','940001','910001',$1,'pending','synthetic-seed','synthetic-seed',$2,$2)", values: [new Date(now.getTime() - 86400000).toISOString().slice(0, 10), at] });
  return statements;
}
