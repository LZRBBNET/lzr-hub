import test from "node:test";
import assert from "node:assert/strict";
import { buildActionQueue, scoreChurnRisk, MISSING_SIGNALS, SCORE_CAVEATS } from "../lib/platform/churn-risk-service.ts";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const signals = (over = {}) => ({ customerId: "c1", tickets: [], invoices: [], ...over });
const ticket = (subject, openedAt = "2026-08-01") => ({ subject, openedAt });
const invoice = (dueAt, status = "A") => ({ status, dueAt });

test("cliente sem sinal nenhum tem score zero e diz isso", () => {
  const risk = scoreChurnRisk(signals(), NOW);
  assert.equal(risk.score, 0);
  assert.equal(risk.level, "baixo");
  assert.match(risk.mainReason, /Nenhum sinal/i);
  assert.equal(risk.suggestedAction, "Nenhuma ação necessária");
});

test("volume de chamados pesa por faixa, não linearmente", () => {
  assert.equal(scoreChurnRisk(signals({ tickets: [ticket("lentidão")] }), NOW).score, 10);
  assert.equal(scoreChurnRisk(signals({ tickets: [ticket("a"), ticket("b"), ticket("c")] }), NOW).score, 25);
  assert.equal(scoreChurnRisk(signals({ tickets: [ticket("a"), ticket("b"), ticket("c"), ticket("d"), ticket("e")] }), NOW).score, 40);
});

test("mesmo problema repetido pesa mais que chamados variados", () => {
  const variados = scoreChurnRisk(signals({ tickets: [ticket("lentidão"), ticket("boleto"), ticket("mudança")] }), NOW);
  const repetido = scoreChurnRisk(signals({ tickets: [ticket("lentidão"), ticket("lentidão"), ticket("lentidão")] }), NOW);
  assert.ok(repetido.score > variados.score, "problema que volta é sinal pior que problemas diferentes");
  assert.match(repetido.mainReason, /chamados|repetido/i);
});

test("recorrência aparece como fator com o número de repetições", () => {
  const risk = scoreChurnRisk(signals({ tickets: [ticket("Sem conexão"), ticket("sem conexão  "), ticket("outro")] }), NOW);
  const fator = risk.factors.find((f) => /repetido/i.test(f.reason));
  assert.ok(fator, "recorrência precisa virar fator visível");
  assert.match(fator.reason, /2 vezes/);
});

test("fatura vencida pesa; fatura em aberto no prazo não", () => {
  const noPrazo = scoreChurnRisk(signals({ invoices: [invoice("2026-09-10")] }), NOW);
  assert.equal(noPrazo.score, 0, "vencer no futuro não é atraso");
  const vencida = scoreChurnRisk(signals({ invoices: [invoice("2026-08-01")] }), NOW);
  assert.equal(vencida.score, 15);
});

test("fatura já paga não conta como atraso", () => {
  const risk = scoreChurnRisk(signals({ invoices: [invoice("2026-01-01", "R")] }), NOW);
  assert.equal(risk.score, 0, "status R é recebida — não há dívida");
});

test("atraso longo soma um fator próprio", () => {
  const risk = scoreChurnRisk(signals({ invoices: [invoice("2026-06-01")] }), NOW);
  assert.equal(risk.score, 30, "15 pela fatura vencida + 15 pelo atraso acima de 30 dias");
  assert.ok(risk.factors.some((f) => /dias/.test(f.reason)));
});

test("cliente novo só pesa quando já há outro problema", () => {
  const semProblema = scoreChurnRisk(signals({ customerSince: "2026-07-01" }), NOW);
  assert.equal(semProblema.score, 0, "ser cliente novo, sozinho, não é risco");
  const comProblema = scoreChurnRisk(signals({ customerSince: "2026-07-01", tickets: [ticket("lentidão")] }), NOW);
  assert.equal(comProblema.score, 20, "10 do chamado + 10 de cliente novo");
});

test("cliente antigo não recebe o peso de cliente novo", () => {
  const risk = scoreChurnRisk(signals({ customerSince: "2016-04-27", tickets: [ticket("lentidão")] }), NOW);
  assert.equal(risk.score, 10);
});

test("níveis seguem as faixas e o score satura em 100", () => {
  const critico = scoreChurnRisk(signals({
    tickets: [ticket("x"), ticket("x"), ticket("x"), ticket("x"), ticket("x")],
    invoices: [invoice("2026-05-01"), invoice("2026-05-02"), invoice("2026-05-03")],
    customerSince: "2026-07-01",
  }), NOW);
  assert.equal(critico.score, 100, "satura em 100, não passa");
  assert.equal(critico.level, "crítico");
});

test("motivo principal é sempre o fator de maior peso", () => {
  const risk = scoreChurnRisk(signals({
    tickets: [ticket("lentidão")],
    invoices: [invoice("2026-05-01"), invoice("2026-05-02"), invoice("2026-05-03")],
  }), NOW);
  assert.match(risk.mainReason, /3 faturas vencidas/, "35 pontos do atraso pesa mais que 10 do chamado");
  assert.match(risk.suggestedAction, /cobrança/i);
});

test("os sinais que não coletamos são declarados, não somem", () => {
  const risk = scoreChurnRisk(signals({ tickets: [ticket("a")] }), NOW);
  assert.deepEqual(risk.missingSignals, MISSING_SIGNALS);
  assert.ok(risk.missingSignals.some((s) => /conexão/i.test(s)));
  assert.ok(risk.missingSignals.some((s) => /sentimento/i.test(s)));
});

test("data de contrato ilegível não quebra nem inventa peso", () => {
  const risk = scoreChurnRisk(signals({ customerSince: "não informado", tickets: [ticket("a")] }), NOW);
  assert.equal(risk.score, 10, "sem data legível, o fator de tempo de casa simplesmente não entra");
});

test("chamado antigo não conta como recente — o snapshot do IXC devolve OS de qualquer época", () => {
  // Foi o defeito que motivou a janela: o cliente 21857 tem 20 OS, todas já
  // finalizadas e antigas. Sem recorte, viraria "risco crítico" sem problema nenhum hoje.
  const antigos = Array.from({ length: 20 }, () => ticket("instalação", "2019-03-10"));
  assert.equal(scoreChurnRisk(signals({ tickets: antigos }), NOW).score, 0);
});

test("a janela separa o que é recente do que é histórico", () => {
  const risk = scoreChurnRisk(signals({ tickets: [ticket("a", "2026-08-01"), ticket("b", "2026-07-20"), ticket("c", "2019-01-01")] }), NOW);
  assert.equal(risk.score, 10, "só os 2 dentro de 90 dias contam, e 2 chamados caem na faixa mais baixa");
  assert.match(risk.mainReason, /2 chamado\(s\) em 90 dias/);
});

test("recorrência também respeita a janela", () => {
  const risk = scoreChurnRisk(signals({ tickets: [ticket("lentidão", "2026-08-01"), ticket("lentidão", "2019-01-01")] }), NOW);
  assert.ok(!risk.factors.some((f) => /repetido/i.test(f.reason)), "repetição precisa ser dentro da janela para significar problema atual");
});

test("chamado sem data legível não entra na janela nem infla o risco", () => {
  const risk = scoreChurnRisk(signals({ tickets: [{ subject: "sem data" }, { subject: "outro", openedAt: "data-invalida" }] }), NOW);
  assert.equal(risk.score, 0, "sem prova de que é recente, não conta — mesmo princípio da fatura sem vencimento");
});

test("fila de ação ordena por risco e descarta score zero", () => {
  const fila = buildActionQueue([
    scoreChurnRisk(signals({ customerId: "sem-risco" }), NOW),
    scoreChurnRisk(signals({ customerId: "medio", tickets: [ticket("a"), ticket("b"), ticket("c")] }), NOW),
    scoreChurnRisk(signals({ customerId: "alto", invoices: [invoice("2026-05-01"), invoice("2026-05-02"), invoice("2026-05-03")] }), NOW),
  ]);
  assert.deepEqual(fila.map((r) => r.customerId), ["alto", "medio"]);
  assert.ok(!fila.some((r) => r.customerId === "sem-risco"), "fila cheia de score zero esconderia quem precisa de atenção");
});

test("fila respeita o limite pedido", () => {
  const muitos = Array.from({ length: 30 }, (_, i) => scoreChurnRisk(signals({ customerId: `c${i}`, tickets: [ticket("a")] }), NOW));
  assert.equal(buildActionQueue(muitos, 5).length, 5);
});

test("'Assunto não informado' não vira recorrência — é ausência de dado, não sinal", () => {
  // Achado contra a base real: 13 das 20 OS de um cadastro vinham assim, e o
  // texto é gerado pelo nosso próprio mapper quando o campo do IXC está vazio.
  // Sem excluir, viravam "mesmo problema repetido 13 vezes" e somavam peso máximo.
  const semAssunto = Array.from({ length: 13 }, () => ticket("Assunto não informado"));
  const risk = scoreChurnRisk(signals({ tickets: semAssunto }), NOW);
  assert.ok(!risk.factors.some((f) => /repetido/i.test(f.reason)), "ausência de informação não pode virar sinal forte");
  assert.equal(risk.score, 40, "os chamados ainda contam pelo volume, mas sem o peso falso de recorrência");
});

test("as ressalvas de leitura acompanham o serviço", () => {
  assert.ok(SCORE_CAVEATS.some((c) => /taxa de acerto/i.test(c)));
  assert.ok(SCORE_CAVEATS.some((c) => /instalação/i.test(c)), "a tela precisa dizer que OS administrativa conta como chamado");
});
