import test from "node:test";
import assert from "node:assert/strict";
import { fetchBoletoSecondCopy, IxcWriteClientError } from "../lib/integrations/ixc/write-client.ts";

const options = (fetcher) => ({ baseUrl: "https://ixc-bridge.exemplo.com.br", token: "token-teste", fetcher });

test("monta a requisição exatamente como documentado na coleção Postman real", async () => {
  let captured;
  const fetcher = async (url, init) => { captured = { url, init }; return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  await fetchBoletoSecondCopy(options(fetcher), "4821", "corr-1");
  assert.equal(captured.url, "https://ixc-bridge.exemplo.com.br/webservice/v1/get_boleto");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["content-type"], "application/json");
  assert.equal(captured.init.headers["x-correlation-id"], "corr-1");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.boletos, "4821");
  assert.equal(body.juro, "", "não cobra juro sem pedido explícito");
  assert.equal(body.multa, "", "não cobra multa sem pedido explícito");
  assert.equal(body.base64, "S");
});

test("corpo vazio (comportamento real confirmado para ID inexistente) vira erro claro, nunca sucesso silencioso", async () => {
  const fetcher = async () => new Response("", { status: 200 });
  await assert.rejects(fetchBoletoSecondCopy(options(fetcher), "999", "corr-1"), (error) => {
    assert.ok(error instanceof IxcWriteClientError);
    assert.equal(error.message, "IXC_BOLETO_NAO_ENCONTRADO");
    return true;
  });
});

test("resposta que não é JSON reconhecível falha alto em vez de arriscar um boleto errado", async () => {
  const fetcher = async () => new Response("<html>não é isso</html>", { status: 200 });
  await assert.rejects(fetchBoletoSecondCopy(options(fetcher), "4821", "corr-1"), /IXC_RESPOSTA_INESPERADA/);
});

test("HTTP de erro vira IxcWriteClientError com o status", async () => {
  const fetcher = async () => new Response("erro", { status: 500 });
  await assert.rejects(fetchBoletoSecondCopy(options(fetcher), "4821", "corr-1"), /IXC_HTTP_500/);
});

test("resposta JSON válida devolve o conteúdo cru, sem inventar nome de campo", async () => {
  const fetcher = async () => new Response(JSON.stringify({ campo_desconhecido: "valor" }), { status: 200 });
  const result = await fetchBoletoSecondCopy(options(fetcher), "4821", "corr-1");
  assert.deepEqual(result.raw, { campo_desconhecido: "valor" });
});
