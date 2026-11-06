import test from 'node:test';
import assert from 'node:assert/strict';
import { IxcReadonlyProvider } from '../lib/integrations/ixc/readonly-provider.ts';
import { Customer360Service } from '../lib/platform/customer360-service.ts';

function fixture(cityRows) {
  const state = { cityRows, cityCalls: 0 };
  const provider = new IxcReadonlyProvider({
    baseUrl: 'https://synthetic.example.invalid', token: 'synthetic-not-a-credential',
    allowedCustomerIds: ['10'], fullBase: true, retryLimit: 0, rateLimitPerMinute: 1000,
    fetcher: async (url, init) => {
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('ixcsoft'), 'listar');
      const resource = new URL(url).pathname.split('/').at(-1);
      const query = JSON.parse(init.body);
      if (resource === 'cidade') {
        assert.equal(query.qtype, 'id'); assert.equal(query.query, '1'); assert.equal(query.oper, '=');
        state.cityCalls++;
        return Response.json({ registros: state.cityRows, total: state.cityRows.length });
      }
      if (resource === 'cliente') return Response.json({ registros: [{ id: '10', razao: 'Cliente sintético', cidade: '1', ativo: 'S' }], total: 1 });
      assert.ok(['cliente_contrato', 'fn_areceber', 'su_oss_chamado', 'radusuarios'].includes(resource), resource);
      return Response.json({ registros: [], total: 0 });
    },
  });
  return { state, provider, service: new Customer360Service(undefined, provider, ['10'], false) };
}

for (const [label, rows] of [
  ['ID de outra cidade', [{ id: '2', nome: 'Cidade incorreta sintética' }]],
  ['ID ausente', [{ nome: 'Cidade sem identidade sintética' }]],
  ['resultado ambíguo', [{ id: '1', nome: 'Cidade sintética A' }, { id: '2', nome: 'Cidade sintética B' }]],
]) test(`Cliente 360 conserva código e não cacheia nome sem correspondência: ${label}`, async () => {
  const { state, service } = fixture(rows);
  const before = await service.get('10');
  assert.equal(before.customer.city, '1');
  assert.equal(before.customer.id, '10');
  assert.equal(before.finance.openInvoices, 0);
  state.cityRows = [{ id: '1', nome: 'Cidade correta sintética' }];
  const after = await service.refresh('10');
  assert.equal(after.customer.city, 'Cidade correta sintética');
  assert.equal(state.cityCalls, 2, 'resultado rejeitado não contamina cache de cidade');
  await service.refresh('10');
  assert.equal(state.cityCalls, 2, 'resultado validado continua em cache');
});

test('lista rejeita ID divergente sem contaminar detalhe e aceita ID numérico correspondente', async () => {
  const { state, provider, service } = fixture([{ id: '2', nome: 'Cidade incorreta sintética' }]);
  assert.equal((await provider.listCustomers('', 1, 20, 'synthetic-list')).items[0].city, '1');
  state.cityRows = [{ id: 1, nome: 'Cidade correta sintética' }];
  assert.equal((await service.get('10')).customer.city, 'Cidade correta sintética');
  assert.equal(state.cityCalls, 2);
  assert.equal((await provider.listCustomers('', 1, 20, 'synthetic-list-cached')).items[0].city, 'Cidade correta sintética');
  assert.equal(state.cityCalls, 2);
});
