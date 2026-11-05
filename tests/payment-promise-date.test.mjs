import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parsePromisedFor, PaymentPromiseValidationError } from "../lib/platform/payment-promise-service.ts";
import { isValidPromisedDate, formatPromisedDate } from "../lib/platform/payment-promise-date.ts";

// Render the actual billing panel with synthetic loaded state. Effects do not
// run during server rendering, so no API, database or IXC request is made.
const root = fileURLToPath(new URL("../", import.meta.url));
const built = buildSync({
  stdin: { contents: "export { BillingModule } from './components/modules/billing';", resolveDir: root, loader: "tsx" },
  bundle: true, platform: "node", format: "cjs", write: false,
  external: ["react", "react-dom", "react-dom/server"], logLevel: "silent",
});
const require = createRequire(import.meta.url);
function renderPromise(promisedFor) {
  const fixture = { id: "synthetic-promise", invoiceId: "901", customerId: "10", promisedFor, status: "pending" };
  const react = { ...React, useState(initial) {
    let value = initial;
    if (initial === "reissue") value = "promise";
    else if (initial === "loading") value = "ready";
    else if (Array.isArray(initial)) value = [fixture];
    return React.useState(value);
  } };
  const compiled = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(
    (id) => id === "react" ? react : require(id), compiled, compiled.exports,
  );
  return renderToStaticMarkup(React.createElement(compiled.exports.BillingModule, { view: "acoes-cobranca" }));
}

for (const timeZone of ["UTC", "America/Sao_Paulo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
  test(`data prometida renderizada preserva o dia civil em ${timeZone}`, () => {
    const previous = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      for (const [value, expected] of [
        ["2026-11-05", "05/11/2026"],
        ["2027-01-01", "01/01/2027"],
        ["2028-02-29", "29/02/2028"],
      ]) {
        const html = renderPromise(value);
        const date = html.match(/promete pagar em ([^<]+)/)?.[1];
        assert.equal(date, expected, `${value} em ${timeZone}`);
      }
      const now = new Date("2026-11-06T02:30:00Z"); // Ainda dia 5 no fuso do negócio.
      assert.equal(parsePromisedFor("2026-11-05", now), "2026-11-05");
      assert.equal(parsePromisedFor("2027-01-04", now), "2027-01-04"); // 60 dias.
      assert.throws(() => parsePromisedFor("2027-01-05", now), PaymentPromiseValidationError);
      assert.throws(() => parsePromisedFor("2026-11-04", now), PaymentPromiseValidationError);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
}

test("data prometida inexistente não é normalizada nem registrada", () => {
  for (const [value, today] of [
    ["2026-11-31", "2026-11-05"], ["2026-11-00", "2026-11-01"],
    ["2026-13-01", "2026-12-01"], ["2027-02-29", "2027-02-01"],
    ["2028-02-30", "2028-02-01"], ["2100-02-29", "2100-02-01"],
  ]) {
    assert.throws(() => parsePromisedFor(value, new Date(`${today}T12:00:00Z`)), PaymentPromiseValidationError, value);
  }
});

test("promessa legada inválida exibe aviso em vez de outra data", () => {
  for (const value of ["2026-11-31", "2027-02-29", "2026-13-01", "05/11/2026", "2026-11-05T00:00:00Z", "", null, undefined, 20261105]) {
    assert.match(renderPromise(value), /promete pagar em Data inválida/);
  }
});

test("calendário gregoriano aceita apenas datas reais, sem normalização", () => {
  for (const value of ["2026-01-31", "2026-04-30", "2026-12-31", "2028-02-29", "2000-02-29", "2400-02-29"]) {
    assert.equal(isValidPromisedDate(value), true, value);
    const [year, month, day] = value.split("-");
    assert.equal(formatPromisedDate(value), `${day}/${month}/${year}`);
  }
  for (const value of ["2026-04-31", "2026-01-32", "2026-00-01", "2026-02-29", "1900-02-29", "2100-02-29", "0000-01-01", "2026-1-01", "2026-01-1", " 2026-11-05", "2026-11-05\n", {}, false]) {
    assert.equal(isValidPromisedDate(value), false, String(value));
    assert.equal(formatPromisedDate(value), "Data inválida");
  }
});

test("validação da promessa preserva 29 de fevereiro em ano bissexto", () => {
  assert.equal(parsePromisedFor("2028-02-29", new Date("2028-02-01T12:00:00Z")), "2028-02-29");
});
