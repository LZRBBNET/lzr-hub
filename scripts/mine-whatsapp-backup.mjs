#!/usr/bin/env node
/**
 * Mineração do backup de WhatsApp da atendente. Três etapas, todas retomáveis:
 *
 *   node --experimental-strip-types scripts/mine-whatsapp-backup.mjs ingest  <pasta-com-os-.txt> [--atendente "Nome"] [--gap 6]
 *   node --experimental-strip-types scripts/mine-whatsapp-backup.mjs extract [--limite N]
 *   node --experimental-strip-types scripts/mine-whatsapp-backup.mjs report
 *
 * ingest  lê cada exportação, separa em conversas, ANONIMIZA e grava só a versão limpa. O texto bruto nunca é gravado.
 * extract manda cada conversa, uma por uma, ao modelo e grava a análise. Falha vira "falha" no controle e é refeita na
 *         próxima rodada: a conta só fecha quando toda conversa tem análise ou um motivo registrado.
 * report  junta tudo em relatório e em padrões.
 *
 * Saída em data/backup-analise/ (fora do git). Precisa de OPENAI_API_KEY só no extract.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  EXTRACTION_SYSTEM, detectAttendant, leftoverPii, parseWhatsAppExport, segmentConversations, toAnonymousConversation, validateAnalysis,
} from "../lib/platform/chat-mining-shared.ts";

const OUT = resolve("data/backup-analise");
const CONVERSAS = join(OUT, "conversas.jsonl");
const ANALISE = join(OUT, "analise.jsonl");
const COBERTURA = join(OUT, "cobertura.json");
const MODEL = process.env.MINING_MODEL || "gpt-5.4-mini";
const EFFORT = process.env.MINING_EFFORT || "medium";
const MAX_CHARS = 60000;

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

function listTxt(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listTxt(path));
    else if (/\.txt$/i.test(entry)) files.push(path);
  }
  return files;
}

/* ------------------------------------------------------------------- ingest --- */
function ingest() {
  const dir = args[1];
  if (!dir || !existsSync(dir)) { console.error("Informe a pasta com as exportações (.txt)."); process.exit(1); }
  const files = listTxt(dir);
  if (files.length === 0) { console.error("Nenhum .txt encontrado. Se o backup é .zip, extraia antes."); process.exit(1); }
  const parsed = files.map((file) => ({ file, ...parseWhatsAppExport(readFileSync(file, "utf8")) }));
  const guess = detectAttendant(parsed.map((item) => item.messages.filter((m) => m.kind !== "system").map((m) => m.author)));
  const attendant = flag("atendente", guess?.name);
  if (!attendant) { console.error("Não consegui identificar a atendente. Use --atendente \"Nome como aparece no backup\"."); process.exit(1); }
  if (!flag("atendente") && (guess?.share ?? 0) < 0.8) {
    console.error(`A atendente provável é "${guess?.name}", mas só aparece em ${Math.round((guess?.share ?? 0) * 100)}% dos arquivos. Confirme com --atendente.`);
    process.exit(1);
  }
  const gap = Number(flag("gap", "6"));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(CONVERSAS, "");
  const coverage = { arquivos: files.length, mensagens: 0, linhasNaoLidas: 0, conversas: 0, semAtendente: 0, midia: {}, atendente: attendant, intervaloHoras: gap };
  for (const item of parsed) {
    coverage.mensagens += item.messages.length;
    coverage.linhasNaoLidas += item.unparsedLines;
    // O id vem do hash do caminho: o nome do arquivo costuma ser o nome do cliente.
    const base = createHash("sha256").update(item.file).digest("hex").slice(0, 10);
    segmentConversations(item.messages, gap).forEach((messages, index) => {
      const conversation = toAnonymousConversation(`${base}-${String(index + 1).padStart(3, "0")}`, messages, attendant);
      // Conversa em que a atendente nunca falou continua no controle: é dado (cliente sem resposta), não lixo.
      if (conversation.attendantMessages === 0) coverage.semAtendente++;
      for (const [kind, count] of Object.entries(conversation.media)) coverage.midia[kind] = (coverage.midia[kind] ?? 0) + count;
      const leaked = leftoverPii(conversation.transcript);
      if (leaked.length > 0) { conversation.transcript = conversation.transcript.replace(/\d{8,}/g, "[NÚMERO]"); conversation.limpezaExtra = leaked; }
      appendFileSync(CONVERSAS, `${JSON.stringify(conversation)}\n`);
      coverage.conversas++;
    });
  }
  writeFileSync(COBERTURA, JSON.stringify(coverage, null, 2));
  console.log(`Arquivos: ${coverage.arquivos} | mensagens: ${coverage.mensagens} | conversas: ${coverage.conversas} | linhas que não consegui ler: ${coverage.linhasNaoLidas}`);
  console.log(`Atendente: "${attendant}" | conversas sem fala da atendente: ${coverage.semAtendente} | mídia:`, coverage.midia);
  console.log(`Gravado em ${CONVERSAS} (anonimizado).`);
}

/* ------------------------------------------------------------------ extract --- */
async function ask(transcript) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("Falta OPENAI_API_KEY.");
  const response = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, reasoning_effort: EFFORT, max_completion_tokens: 4000, response_format: { type: "json_object" },
      messages: [{ role: "system", content: EXTRACTION_SYSTEM }, { role: "user", content: transcript }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 429 ? " (limite de taxa)" : ""}`);
  return { text: body.choices?.[0]?.message?.content ?? "", usage: body.usage ?? {} };
}

async function extract() {
  const conversations = readJsonl(CONVERSAS);
  if (conversations.length === 0) { console.error("Rode o ingest antes."); process.exit(1); }
  const done = new Map(readJsonl(ANALISE).map((record) => [record.id, record]));
  const todo = conversations.filter((conversation) => done.get(conversation.id)?.status !== "ok").slice(0, Number(flag("limite", String(conversations.length))));
  console.log(`${conversations.length} conversas | já analisadas: ${conversations.length - conversations.filter((c) => done.get(c.id)?.status !== "ok").length} | agora: ${todo.length}`);
  let tokens = 0;
  let index = 0;
  const workers = Array.from({ length: Number(flag("paralelo", "4")) }, async () => {
    while (index < todo.length) {
      const conversation = todo[index++];
      let record;
      for (let attempt = 1; attempt <= 3 && !record; attempt++) {
        try {
          const truncated = conversation.transcript.length > MAX_CHARS;
          const { text, usage } = await ask(truncated ? conversation.transcript.slice(0, MAX_CHARS) : conversation.transcript);
          tokens += (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
          const checked = validateAnalysis(JSON.parse(text));
          record = checked.ok
            ? { id: conversation.id, status: "ok", truncada: truncated, notas: checked.notes, analise: checked.analysis }
            : { id: conversation.id, status: "falha", motivo: checked.reason };
          if (!checked.ok && attempt < 3) record = undefined;
        } catch (error) {
          if (attempt === 3) record = { id: conversation.id, status: "falha", motivo: String(error.message).slice(0, 160) };
          else await new Promise((done) => setTimeout(done, 1500 * attempt));
        }
      }
      appendFileSync(ANALISE, `${JSON.stringify(record)}\n`);
      done.set(record.id, record);
      if (done.size % 25 === 0) console.log(`  ${done.size}/${conversations.length}`);
    }
  });
  await Promise.all(workers);
  const failed = conversations.filter((c) => done.get(c.id)?.status !== "ok");
  console.log(`Concluído. Análises ok: ${conversations.length - failed.length}/${conversations.length} | falhas: ${failed.length} | tokens: ${tokens}`);
  if (failed.length > 0) console.log("Rode `extract` de novo: só as que falharam são refeitas.");
}

/* ------------------------------------------------------------------- report --- */
const count = (items) => { const map = new Map(); for (const item of items) map.set(item, (map.get(item) ?? 0) + 1); return [...map.entries()].sort((a, b) => b[1] - a[1]); };
const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : "—");

function report() {
  const conversations = readJsonl(CONVERSAS);
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const latest = new Map(readJsonl(ANALISE).map((record) => [record.id, record]));
  const ok = [...latest.values()].filter((record) => record.status === "ok");
  const failed = conversations.length - ok.length;
  const coverage = existsSync(COBERTURA) ? JSON.parse(readFileSync(COBERTURA, "utf8")) : {};
  const lines = [];
  const out = (text = "") => lines.push(text);
  out("# Análise do backup de atendimento da BBNET\n");
  out(`- Conversas encontradas: **${conversations.length}** (de ${coverage.arquivos ?? "?"} arquivos, ${coverage.mensagens ?? "?"} mensagens)`);
  out(`- Analisadas: **${ok.length}** | pendentes ou com falha: **${failed}** ${failed ? "← rode `extract` de novo antes de confiar nos números" : "(cobertura total)"}`);
  out(`- Linhas do arquivo que não consegui ler: ${coverage.linhasNaoLidas ?? "?"} | conversas sem fala da atendente: ${coverage.semAtendente ?? "?"}\n`);
  const items = ok.map((record) => ({ ...record.analise, id: record.id, conv: byId.get(record.id) }));
  out("## Do que o cliente fala\n");
  out("| Família | Conversas | % |\n|---|---|---|");
  for (const [family, n] of count(items.map((item) => item.familia))) out(`| ${family} | ${n} | ${pct(n, items.length)} |`);
  out("\n## Como terminam\n");
  for (const [outcome, n] of count(items.map((item) => item.desfecho))) out(`- ${outcome}: ${n} (${pct(n, items.length)})`);
  const fit = count(items.map((item) => item.iaPoderiaResolver));
  out("\n## A IA poderia conduzir?\n");
  for (const [value, n] of fit) out(`- ${value}: ${n} (${pct(n, items.length)})`);
  out("\n## Assuntos mais frequentes (maior primeiro)\n");
  const subjects = new Map();
  for (const item of items) { const list = subjects.get(item.assunto) ?? []; list.push(item); subjects.set(item.assunto, list); }
  const ranked = [...subjects.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [subject, list] of ranked.slice(0, 40)) {
    out(`### ${subject} — ${list.length} (${pct(list.length, items.length)})`);
    out(`- Família: ${count(list.map((i) => i.familia))[0][0]} | desfecho mais comum: ${count(list.map((i) => i.desfecho))[0][0]} | OS aberta em ${pct(list.filter((i) => i.os.aberta).length, list.length)}`);
    out(`- Jeito do cliente falar: ${count(list.flatMap((i) => i.jeitoDeFalar)).slice(0, 8).map(([w, n]) => `"${w}"${n > 1 ? ` ×${n}` : ""}`).join(", ") || "—"}`);
    out(`- Perguntas da atendente (mais comuns): ${count(list.flatMap((i) => i.perguntasDaAtendente)).slice(0, 6).map(([q]) => q).join(" · ") || "—"}`);
    out(`- Resolução (mais comum): ${count(list.flatMap((i) => i.resolucao)).slice(0, 6).map(([r]) => r).join(" · ") || "—"}`);
    const model = list.find((i) => i.boaRespostaModelo);
    if (model) out(`- Conversa-modelo: \`${model.id}\` (em data/backup-analise/conversas.jsonl)`);
    out();
  }
  out("## O que a atendente concede (a IA NÃO deve repetir sem regra)\n");
  for (const [concession, n] of count(items.flatMap((item) => item.concessoes)).slice(0, 30)) out(`- ${concession} ×${n}`);
  out("\n## Onde a atendente errou ou deixou de perguntar\n");
  for (const [gap, n] of count(items.flatMap((item) => item.lacunas)).slice(0, 20)) out(`- ${gap} ×${n}`);
  out("\n## Urgência\n");
  for (const [level, n] of count(items.map((item) => item.urgencia))) out(`- ${level}: ${n}`);
  for (const [reason, n] of count(items.map((item) => item.motivoUrgencia).filter(Boolean)).slice(0, 10)) out(`  - ${reason} ×${n}`);
  out("\n## Quando chega (horário e dia)\n");
  const hours = count(conversations.map((c) => c.startedAt.slice(11, 13))).sort((a, b) => a[0].localeCompare(b[0]));
  out(`- Por hora de início: ${hours.map(([h, n]) => `${h}h:${n}`).join(" ")}`);
  const weekday = count(conversations.map((c) => ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][new Date(`${c.startedAt.slice(0, 10)}T12:00:00Z`).getUTCDay()]));
  out(`- Por dia da semana: ${weekday.map(([d, n]) => `${d}:${n}`).join(" ")}`);
  writeFileSync(join(OUT, "relatorio.md"), lines.join("\n"));
  writeFileSync(join(OUT, "padroes.json"), JSON.stringify(ranked.map(([subject, list]) => ({ assunto: subject, conversas: list.length, familia: count(list.map((i) => i.familia))[0][0] })), null, 2));
  console.log(`Relatório em ${join(OUT, "relatorio.md")} — cobertura ${ok.length}/${conversations.length}.`);
}

const commands = { ingest, extract, report };
if (!commands[command]) { console.error("Uso: ingest <pasta> | extract | report"); process.exit(1); }
await commands[command]();
