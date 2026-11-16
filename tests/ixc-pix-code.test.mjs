import test from "node:test";
import assert from "node:assert/strict";
import { fetchPixCode } from "../lib/integrations/ixc/write-client.ts";

/** Formato provado na fatura de teste 2098068 (16/11/2026), com os valores trocados. */
const sucesso = {
  type: "success",
  gateway: { gatewayNome: "MB" },
  pix: {
    dadosPix: {
      status: "ATIVA", txid: "abc", valor: { original: "4.99" }, expiracaoPix: "19/01/2027 00:00:00",
      devedor: { cpf: "52998224725", nome: "FULANO DE TAL" },
      pixCopiaECola: "000201269700exemplo6304ABCD",
    },
    qrCode: { qrcode: "000201269700exemplo6304ABCD", imagemQrcode: "iVBORw0KGgo" },
  },
};
const cliente = (body, status = 200) => ({ baseUrl: "https://ixc.invalid", token: "1:x", fetcher: async (url, init) => { cliente.ultimo = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify(body), { status }); } });

test("devolve só o copia e cola e a validade — o CPF e o nome do devedor ficam para trás", async () => {
  const pix = await fetchPixCode(cliente(sucesso), "2098068", "c-1");
  assert.deepEqual(pix, { copyPaste: "000201269700exemplo6304ABCD", expiresAt: "19/01/2027 00:00:00" });
  assert.doesNotMatch(JSON.stringify(pix), /52998224725|FULANO/);
  assert.match(cliente.ultimo.url, /\/webservice\/v1\/get_pix$/);
  assert.deepEqual(cliente.ultimo.body, { id_areceber: "2098068" });
});

test("recusa do IXC em HTTP 200 e resposta sem código viram erro, nunca PIX vazio", async () => {
  await assert.rejects(fetchPixCode(cliente({ type: "error", message: "Fatura não encontrada" }), "1", "c"), /IXC_PIX_RECUSADO/);
  await assert.rejects(fetchPixCode(cliente({ type: "success", pix: { dadosPix: {} } }), "1", "c"), /IXC_PIX_SEM_CODIGO/);
  await assert.rejects(fetchPixCode(cliente({}, 500), "1", "c"), /IXC_HTTP_500/);
});
