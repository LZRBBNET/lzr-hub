import { IxcReadonlyProvider } from './readonly-provider.ts';
import { businessToday } from '../../platform/billing-service.ts';

const OFF = ['FEATURE_IXC_WRITE', 'IXC_WRITE_ENABLED', 'FEATURE_QUEUES', 'FEATURE_META_WHATSAPP',
  'FEATURE_N8N_CHANNEL', 'FEATURE_N8N_AUTOREPLY', 'FEATURE_ATTENDANT_REPLY', 'FEATURE_EVOLUTION',
  'FEATURE_CHATWOOT', 'FEATURE_LANGFUSE', 'FEATURE_LLM_INTENT', 'FEATURE_COPILOT_LLM', 'FEATURE_TELEGRAM_ALERTS'];
const SECRETS = ['IXC_API_TOKEN', 'META_ACCESS_TOKEN', 'META_APP_SECRET', 'N8N_CHANNEL_SECRET',
  'GROQ_API_KEY', 'QUEUE_SERVICE_SECRET', 'STAGING_JOB_SECRET', 'TELEGRAM_WEBHOOK_SECRET', 'EVOLUTION_API_KEY', 'CHATWOOT_API_TOKEN'];
export function assertSyntheticDemo(source: Record<string, string | undefined> = process.env): void {
  if (source.FEATURE_SYNTHETIC_INVOICES !== 'true' || source.DEMO_DATASET !== 'isolated-invoices-v1' ||
    source.LZR_ENV !== 'staging' || source.NEXT_PUBLIC_LZR_ENV !== 'staging' || source.LZR_RUNTIME_MODE !== 'mock' ||
    source.FEATURE_AUTH !== 'true' || source.PILOT_MODE !== 'disabled' || source.IXC_MODE !== 'disabled' ||
    source.IXC_TRANSPORT !== 'disabled' || source.FEATURE_IXC_FULL_BASE !== 'false' ||
    OFF.some(key => source[key] !== 'false') || SECRETS.some(key => Boolean(source[key]))) {
    throw new Error('SYNTHETIC_DEMO_CONFIGURATION_BLOCKED');
  }
}

/** Fixed, invented identities. All transport is in memory; there is no fallback. */
export function createSyntheticInvoiceDemo(source: () => Record<string, string | undefined> = () => process.env) {
  assertSyntheticDemo(source());
  let paid = false;
  const dueAt = businessToday(new Date(Date.now() - 86400000));
  const provider = new IxcReadonlyProvider({ baseUrl: 'https://synthetic.invalid', token: 'synthetic-not-a-credential',
    allowedCustomerIds: ['10'], retryLimit: 0, rateLimitPerMinute: 10000,
    fetcher: async (url, init) => {
      assertSyntheticDemo(source());
      const endpoint = new URL(url instanceof Request ? url.url : url);
      if (endpoint.hostname !== 'synthetic.invalid' || init?.method !== 'POST' || new Headers(init.headers).get('ixcsoft') !== 'listar') throw new Error('SYNTHETIC_TRANSPORT_BLOCKED');
      const request = JSON.parse(String(init.body));
      const resources: Record<string, unknown[]> = {
        cliente: [{ id: '10', razao: 'Cliente sintético DEMO', ativo: 'S', cnpj_cpf: 'DOC-SINTETICO-INVALIDO', cidade: '1', bairro: 'Bairro fictício' }],
        cidade: [{ id: '1', nome: 'Cidade fictícia' }],
        cliente_contrato: [{ id: '501', id_cliente: '10', contrato: 'Plano sintético', status: 'A' }],
        fn_areceber: [{ id: '901', id_cliente: '10', id_contrato: '501', status: paid ? 'R' : 'A', data_vencimento: dueAt, valor: '50', valor_aberto: paid ? '0' : '50' }],
        fn_movim_finan: paid ? [{ id: '801', id_receber: '901', data: businessToday(new Date()), valor: '50', tipo_recebimento: 'SIMULADO' }] : [],
        radusuarios: [], su_oss_chamado: [],
      };
      const resource = endpoint.pathname.split('/').at(-1)!;
      if (!(resource in resources)) throw new Error('SYNTHETIC_RESOURCE_BLOCKED');
      let rows = resources[resource];
      if (request.qtype === 'fn_areceber.id' && request.query !== '901') rows = [];
      if (resource === 'fn_areceber' && paid && String(request.grid_param).includes('status')) rows = [];
      return Response.json({ registros: rows, total: rows.length });
    } });
  const guarded = new Proxy(provider, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? (...args: unknown[]) => { assertSyntheticDemo(source()); return value.apply(target, args); } : value;
  } });
  return { provider: guarded, reset(confirmation: string) {
    assertSyntheticDemo(source());
    if (confirmation !== 'RESET_SYNTHETIC_INVOICE_901') throw new Error('SYNTHETIC_RESET_CONFIRMATION_REQUIRED');
    paid = false; provider.invalidate('10');
    return { synthetic: true, invoiceId: '901', status: 'A', databaseReset: false, delivered: false,
      warning: 'Somente a fatura em memória foi reaberta; promessas e histórico persistidos permanecem.' };
  }, markPaid() { assertSyntheticDemo(source()); paid = true; provider.invalidate('10'); return { synthetic: true, invoiceId: '901', status: 'R', delivered: false }; } };
}

let demo: ReturnType<typeof createSyntheticInvoiceDemo> | undefined;
export function getSyntheticInvoiceDemo() {
  assertSyntheticDemo();
  return demo ??= createSyntheticInvoiceDemo();
}
