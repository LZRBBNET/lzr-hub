#!/usr/bin/env node
/**
 * Mineração do backup de WhatsApp das atendentes. Cada backup é um LOTE (uma loja/atendente), com pasta própria em
 * data/backup-analise/<lote>/ (fora do git). Todas as etapas são retomáveis.
 *
 *   node --experimental-strip-types scripts/mine-whatsapp-backup.mjs ingest-db <msgstore.db> --lote itabaiana [--gap 6]
 *   node --experimental-strip-types scripts/mine-whatsapp-backup.mjs ingest    <pasta-com-.txt> --lote x [--atendente "Nome"]
 *   node --experimental-strip-types scripts/mine-whatsapp-backup.mjs custo      --lote itabaiana [--desde 2025-01-01]
 *   node --experimental-strip-types scripts/mine-whatsapp-backup.mjs transcribe --lote itabaiana --midia <pasta do celular> [--quem cliente|todos]
 *   node --experimental-strip-types scripts/mine-whatsapp-backup.mjs extract    --lote itabaiana [--desde 2025-01-01] [--limite N]
 *   node --experimental-strip-types scripts/mine-whatsapp-backup.mjs report     --lote itabaiana   (ou --todos: junta os lotes)
 *
 * ingest-db  lê o banco do WhatsApp (já aberto com a chave), separa em conversas, ANONIMIZA e grava só a versão limpa.
 *            Também grava, sem modelo nenhum: estatísticas (volume, horário, tempo de resposta), o roteiro de fato da
 *            atendente (as mensagens que ela repete), as respostas rápidas do WhatsApp Business e a lista de áudios.
 * transcribe transcreve os áudios (OpenAI) e grava o texto JÁ anonimizado; rode o ingest-db de novo depois.
 * extract    manda cada conversa, uma por uma, ao modelo e grava a análise. Falha é refeita na próxima rodada.
 * report     junta tudo em relatório e em padrões.
 *
 * O texto bruto do backup nunca é gravado nem sai da máquina: só a versão anonimizada.
 * Precisa de OPENAI_API_KEY só em transcribe e extract.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  EXTRACTION_SYSTEM, androidKind, anonymize, detectAttendant, leftoverPii, parseWhatsAppExport, segmentConversations, toAnonymousConversation, validateAnalysis,
} from "../lib/platform/chat-mining-shared.ts";
import { isBusinessHours } from "../lib/platform/triage-shared.ts";

const ROOT = resolve("data/backup-analise");
const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(`--${name}`);
const LOTE = flag("lote");
const OUT = LOTE ? join(ROOT, LOTE.replace(/[^\w-]/g, "")) : ROOT;
const CONVERSAS = join(OUT, "conversas.jsonl");
const ANALISE = join(OUT, "analise.jsonl");
const COBERTURA = join(OUT, "cobertura.json");
const AUDIOS = join(OUT, "audios.jsonl");
const TRANSCRICOES = join(OUT, "transcricoes.jsonl");
const MODEL = flag("modelo", process.env.MINING_MODEL || "gpt-5.4-mini");
const EFFORT = flag("esforco", process.env.MINING_EFFORT || "low");
const MAX_CHARS = 60000;
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

/** Hora de Brasília (UTC−3, sem horário de verão desde 2019) no formato que o resto da ferramenta usa. */
const local = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 16);
const median = (values) => { const v = [...values].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const quantile = (values, q) => { const v = [...values].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : null; };
const count = (items) => { const map = new Map(); for (const item of items) map.set(item, (map.get(item) ?? 0) + 1); return [...map.entries()].sort((a, b) => b[1] - a[1]); };
const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : "—");
const normalizeLine = (text) => text.toLowerCase().replace(/\s+/g, " ").replace(/^[\s.,!?:;-]+|[\s.,!?:;-]+$/g, "").trim();

function listTxt(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listTxt(path));
    else if (/\.txt$/i.test(entry)) files.push(path);
  }
  return files;
}

/* ------------------------------------------------------------- ingest (texto) --- */
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
  const coverage = { fonte: "exportação de texto", lote: LOTE ?? null, arquivos: files.length, mensagens: 0, linhasNaoLidas: 0, conversas: 0, semAtendente: 0, midia: {}, atendente: attendant, intervaloHoras: gap };
  for (const item of parsed) {
    coverage.mensagens += item.messages.length;
    coverage.linhasNaoLidas += item.unparsedLines;
    // O id vem do hash do caminho: o nome do arquivo costuma ser o nome do cliente.
    const base = createHash("sha256").update(item.file).digest("hex").slice(0, 10);
    segmentConversations(item.messages, gap).forEach((messages, index) => {
      const conversation = toAnonymousConversation(`${base}-${String(index + 1).padStart(3, "0")}`, messages, attendant);
      // Conversa em que a atendente nunca falou continua no controle: é dado (cliente sem resposta), não lixo.
      if (conversation.attendantMessages === 0) coverage.semAtendente++;
      for (const [kind, n] of Object.entries(conversation.media)) coverage.midia[kind] = (coverage.midia[kind] ?? 0) + n;
      guardPii(conversation);
      appendFileSync(CONVERSAS, `${JSON.stringify(conversation)}\n`);
      coverage.conversas++;
    });
  }
  writeFileSync(COBERTURA, JSON.stringify(coverage, null, 2));
  console.log(`Arquivos: ${coverage.arquivos} | mensagens: ${coverage.mensagens} | conversas: ${coverage.conversas} | linhas que não consegui ler: ${coverage.linhasNaoLidas}`);
  console.log(`Atendente: "${attendant}" | conversas sem fala da atendente: ${coverage.semAtendente} | mídia:`, coverage.midia);
  console.log(`Gravado em ${CONVERSAS} (anonimizado).`);
}

/** Última rede de segurança antes de gravar: número longo que escapou vira marcador. */
function guardPii(conversation) {
  const leaked = leftoverPii(conversation.transcript);
  if (leaked.length > 0) {
    conversation.transcript = conversation.transcript.replace(/\d{8,}/g, "[NÚMERO]").replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[DOCUMENTO]")
      .replace(/\b(?:\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-\s]?\d{4}\b/g, "[NÚMERO]").replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]");
    conversation.limpezaExtra = leaked;
  }
}

/* -------------------------------------------------------- ingest (banco SQLite) --- */
async function ingestDb() {
  const file = args[1];
  if (!file || !existsSync(file)) { console.error("Informe o msgstore.db já aberto (descriptografado)."); process.exit(1); }
  if (!LOTE) { console.error("Informe o lote: --lote itabaiana (cada backup fica na sua pasta)."); process.exit(1); }
  const gapMs = Number(flag("gap", "6")) * 3600 * 1000;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });

  // Só conversa individual: telefone (s.whatsapp.net) e o identificador novo do WhatsApp (lid). Grupo, lista de
  // transmissão, status, canal e robô ficam de fora — e são contados, não somem.
  const servers = db.prepare("SELECT j.server server, count(*) n FROM message m JOIN chat c ON c._id = m.chat_row_id JOIN jid j ON j._id = c.jid_row_id GROUP BY 1").all();
  const rows = db.prepare(`
    SELECT m._id id, c.jid_row_id jid, m.from_me me, m.timestamp ts, m.message_type type, m.text_data text,
           mm.media_caption caption, mm.file_path path, mm.media_duration duration
    FROM message m JOIN chat c ON c._id = m.chat_row_id JOIN jid j ON j._id = c.jid_row_id
    LEFT JOIN message_media mm ON mm.message_row_id = m._id
    WHERE j.server IN ('s.whatsapp.net', 'lid') AND m.timestamp > 0`).all();
  // O mesmo cliente pode aparecer pelo telefone e pelo lid: `jid_map` junta os dois numa linha do tempo só.
  const lidToPhone = new Map(db.prepare("SELECT lid_row_id lid, jid_row_id phone FROM jid_map").all().map((row) => [row.lid, row.phone]));
  const quickReplies = (() => { try { return db.prepare("SELECT title, content FROM quick_replies").all(); } catch { return []; } })();
  db.close();

  const transcripts = new Map(readJsonl(TRANSCRICOES).filter((row) => row.texto).map((row) => [row.id, row.texto]));
  const threads = new Map();
  for (const row of rows) {
    const key = lidToPhone.get(row.jid) ?? row.jid;
    (threads.get(key) ?? threads.set(key, []).get(key)).push(row);
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(CONVERSAS, "");
  writeFileSync(AUDIOS, "");
  const coverage = {
    fonte: "banco do WhatsApp (msgstore.db)", lote: LOTE, mensagens: rows.length, porServidor: Object.fromEntries(servers.map((s) => [s.server, s.n])),
    contatos: threads.size, conversas: 0, comDoisLados: 0, semAtendente: 0, soAtendente: 0, midia: {}, intervaloHoras: gapMs / 3600000,
    audiosTranscritos: transcripts.size, limpezaExtra: 0,
  };
  const stats = { starts: [], firstResponse: { business: [], offHours: [] }, staffLines: [], openings: [], byMonth: [], customerAudio: 0, customerText: 0, calls: 0 };

  // Mensagem automática (saudação, ausência): o mesmo texto saindo até 5 s depois da fala do cliente, 30 vezes ou
  // mais. Sem separar, a "primeira resposta" mediria o robô do WhatsApp Business (mediana zero), não a atendente.
  for (const list of threads.values()) list.sort((a, b) => a.ts - b.ts || a.id - b.id);
  // A atendente também responde "viu"/"certo" em 3 segundos: o automático é o texto que sai quase SEMPRE na hora.
  const instant = new Map();
  const sent = new Map();
  for (const list of threads.values()) {
    let lastCustomer = -Infinity;
    for (const row of list) {
      if (!row.me) { lastCustomer = row.ts; continue; }
      if (!row.text) continue;
      const key = row.text.trim().toLowerCase();
      sent.set(key, (sent.get(key) ?? 0) + 1);
      if (row.ts - lastCustomer <= 5000) instant.set(key, (instant.get(key) ?? 0) + 1);
    }
  }
  const automatic = new Set([...instant.entries()].filter(([text, n]) => n >= 30 && text.length >= 15 && n / sent.get(text) >= 0.8).map(([text]) => text));
  // Saudação e ausência do WhatsApp Business saem atrasadas quando o celular está sem rede (a das 6h51 chegou 10 min
  // depois): o texto também denuncia. Só conta com repetição, para não pegar uma frase digitada uma vez.
  const signature = /bem-vindo|hor[aá]rio de funcionamento|agradece seu contato|n[aã]o estamos dispon[ií]veis no momento/i;
  for (const [text, n] of sent) if (n >= 30 && signature.test(text)) automatic.add(text);
  const isAuto = (row) => row.me === 1 && !!row.text && automatic.has(row.text.trim().toLowerCase());
  coverage.mensagensAutomaticas = rows.filter(isAuto).length;

  for (const [key, list] of threads) {
    const segments = [];
    for (const row of list) {
      const current = segments.at(-1);
      if (current && row.ts - current.at(-1).ts <= gapMs) current.push(row); else segments.push([row]);
    }
    for (const segment of segments) {
      const real = segment.filter((row) => androidKind(row.type) !== "system");
      if (real.length === 0) continue;
      const id = `${LOTE}-${createHash("sha256").update(`${LOTE}:${key}:${real[0].ts}`).digest("hex").slice(0, 12)}`;
      const messages = real.map((row) => ({
        at: local(row.ts), author: row.me ? "ATENDENTE" : "CLIENTE", staff: row.me === 1, kind: androidKind(row.type),
        text: row.text ?? row.caption ?? "", transcript: transcripts.get(row.id), auto: isAuto(row),
      }));
      const conversation = { ...toAnonymousConversation(id, messages, "ATENDENTE"), lote: LOTE };
      guardPii(conversation);
      if (conversation.limpezaExtra) coverage.limpezaExtra++;
      const customerRows = real.filter((row) => !row.me);
      // Só a resposta de gente conta: conversa que recebeu apenas a saudação automática ficou sem atendimento.
      const staffRows = real.filter((row) => row.me && !isAuto(row));
      if (customerRows.length === 0) { coverage.soAtendente++; continue; } // aviso, cobrança ou contato da atendente: não é atendimento
      conversation.respostaHumana = staffRows.length > 0;
      if (staffRows.length === 0) coverage.semAtendente++;
      else coverage.comDoisLados++;
      for (const [kind, n] of Object.entries(conversation.media)) coverage.midia[kind] = (coverage.midia[kind] ?? 0) + n;

      // Medidas sem modelo: quando chega, quanto demora a primeira resposta, o que a atendente repete.
      const first = customerRows[0];
      const business = isBusinessHours(new Date(first.ts));
      conversation.horarioComercial = business;
      const reply = staffRows.find((row) => row.ts >= first.ts && !isAuto(row));
      if (reply) {
        conversation.primeiraRespostaMin = Math.round((reply.ts - first.ts) / 60000);
        (business ? stats.firstResponse.business : stats.firstResponse.offHours).push(conversation.primeiraRespostaMin);
      }
      stats.starts.push(local(first.ts));
      for (const row of customerRows) { const kind = androidKind(row.type); if (kind === "audio") stats.customerAudio++; if (kind === "text") stats.customerText++; if (kind === "call") stats.calls++; }
      for (const row of staffRows) if (androidKind(row.type) === "text" && row.text && !isAuto(row)) stats.staffLines.push(normalizeLine(anonymize(row.text)));
      const opening = customerRows.find((row) => androidKind(row.type) === "text" && row.text);
      if (opening) stats.openings.push(normalizeLine(anonymize(opening.text)));
      for (const row of real) {
        if (androidKind(row.type) === "audio" && row.path) {
          appendFileSync(AUDIOS, `${JSON.stringify({ id: row.id, conversa: id, atendente: row.me === 1, segundos: row.duration ?? null, arquivo: row.path, transcrito: transcripts.has(row.id) })}\n`);
        }
      }
      appendFileSync(CONVERSAS, `${JSON.stringify(conversation)}\n`);
      coverage.conversas++;
    }
  }
  writeFileSync(COBERTURA, JSON.stringify(coverage, null, 2));
  writeStats(stats, coverage);
  // Respostas rápidas do WhatsApp Business: os textos prontos que a própria atendente cadastrou.
  writeFileSync(join(OUT, "respostas-rapidas.json"), JSON.stringify(quickReplies.map((row) => ({
    atalho: anonymize(String(row.title ?? "")), texto: anonymize(String(row.content ?? "")),
    vezesEnviada: stats.staffLines.filter((line) => line === normalizeLine(anonymize(String(row.content ?? "")))).length,
  })), null, 2));
  console.log(`Mensagens: ${coverage.mensagens} | contatos: ${coverage.contatos} | conversas com cliente: ${coverage.conversas} (dois lados: ${coverage.comDoisLados}, sem resposta: ${coverage.semAtendente}) | só a atendente falou: ${coverage.soAtendente}`);
  console.log(`Áudios listados em ${AUDIOS} | transcritos: ${transcripts.size} | conversas com limpeza extra: ${coverage.limpezaExtra}`);
  console.log(`Gravado em ${OUT} (anonimizado): conversas.jsonl, estatisticas.md, roteiro-da-atendente.md, respostas-rapidas.json.`);
}

function writeStats(stats, coverage) {
  const lines = [];
  const out = (text = "") => lines.push(text);
  const total = stats.starts.length;
  out(`# Lote ${LOTE}: números do backup (sem modelo)\n`);
  out(`- Conversas com cliente: **${total}** | a atendente respondeu: ${coverage.comDoisLados} | ficaram sem resposta: ${coverage.semAtendente}`);
  out(`- Falas do cliente: ${stats.customerText} em texto, **${stats.customerAudio} em áudio** (${pct(stats.customerAudio, stats.customerText + stats.customerAudio)}), ${stats.calls} ligações pelo WhatsApp\n`);
  out("## Quando chega\n");
  const business = stats.starts.filter((at) => isBusinessHours(new Date(`${at}:00-03:00`))).length;
  out(`- No horário comercial: ${business} (${pct(business, total)}) | fora dele (noite, almoço, fim de semana, feriado): **${total - business} (${pct(total - business, total)})**`);
  const hours = count(stats.starts.map((at) => at.slice(11, 13))).sort((a, b) => a[0].localeCompare(b[0]));
  out(`- Por hora (Brasília): ${hours.map(([h, n]) => `${h}h ${n}`).join(" · ")}`);
  const weekday = count(stats.starts.map((at) => ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][new Date(`${at.slice(0, 10)}T12:00:00Z`).getUTCDay()]));
  out(`- Por dia: ${weekday.map(([d, n]) => `${d} ${n}`).join(" · ")}`);
  const months = count(stats.starts.map((at) => at.slice(0, 7))).sort((a, b) => a[0].localeCompare(b[0]));
  out(`- Por mês: ${months.map(([m, n]) => `${m}: ${n}`).join(" · ")}\n`);
  out("## Quanto o cliente espera a primeira resposta (minutos)\n");
  for (const [label, values] of [["Começou no horário comercial", stats.firstResponse.business], ["Começou fora do horário", stats.firstResponse.offHours]]) {
    out(`- ${label}: mediana **${median(values) ?? "—"}**, 75% até ${quantile(values, 0.75) ?? "—"}, 90% até ${quantile(values, 0.9) ?? "—"} (${values.length} conversas)`);
  }
  out("\n## Como o cliente abre a conversa (primeira mensagem de texto, mais comuns)\n");
  for (const [text, n] of count(stats.openings.filter((text) => text.length >= 2)).slice(0, 80)) out(`- ${n}× "${text.slice(0, 160)}"`);
  writeFileSync(join(OUT, "estatisticas.md"), lines.join("\n"));

  // O roteiro de fato: mensagens que a atendente manda igual (ou quase) muitas vezes. É o "texto pronto" dela.
  const script = [];
  script.push(`# Lote ${LOTE}: o que a atendente repete (o roteiro de fato)\n`);
  script.push("Mensagens enviadas pela atendente 5 vezes ou mais, já anonimizadas. As longas são instrução e informação; as curtas, o jeito de conduzir.\n");
  const repeated = count(stats.staffLines.filter((text) => text.length >= 3)).filter(([, n]) => n >= 5);
  script.push("## Textos longos (instrução, aviso, informação)\n");
  for (const [text, n] of repeated.filter(([text]) => text.length >= 60).slice(0, 120)) script.push(`- **${n}×** ${text.slice(0, 700)}`);
  script.push("\n## Frases curtas (condução da conversa)\n");
  for (const [text, n] of repeated.filter(([text]) => text.length < 60).slice(0, 150)) script.push(`- ${n}× "${text}"`);
  writeFileSync(join(OUT, "roteiro-da-atendente.md"), script.join("\n"));
}

/* -------------------------------------------------------------------- custo --- */
// Preço por milhão de tokens (OpenAI, novembro de 2026): gpt-5.4-mini US$ 0,75 entrada / US$ 4,50 saída; nano 0,20 / 1,25.
const PRICES = { "gpt-5.4-mini": [0.75, 4.5], "gpt-5.4-nano": [0.2, 1.25] };
const REASONING = { minimal: 50, low: 250, medium: 700, high: 1500 };

function selection(conversations) {
  const since = flag("desde");
  const minimum = Number(flag("minimo", "3"));
  // Só o que é atendimento: os dois lados falaram e há pelo menos `minimo` mensagens.
  return conversations.filter((c) => (c.respostaHumana ?? c.attendantMessages > 0) && c.customerMessages > 0 && c.messageCount >= minimum && (!since || c.startedAt >= since));
}

function cost() {
  const chosen = selection(readJsonl(CONVERSAS));
  const systemTokens = Math.ceil(EXTRACTION_SYSTEM.length / 3.6);
  const input = chosen.reduce((sum, c) => sum + systemTokens + Math.ceil(Math.min(c.transcript.length, MAX_CHARS) / 3.6), 0);
  const audios = readJsonl(AUDIOS);
  const minutes = (who) => Math.round(audios.filter((a) => (who === "todos" || !a.atendente) && !a.transcrito).reduce((s, a) => s + (a.segundos ?? 0), 0) / 60);
  console.log(`Conversas selecionadas: ${chosen.length}${flag("desde") ? ` (desde ${flag("desde")})` : ""} | tokens de entrada ≈ ${(input / 1e6).toFixed(1)} mi`);
  for (const [model, [inPrice, outPrice]] of Object.entries(PRICES)) {
    for (const effort of ["low", "medium"]) {
      const output = chosen.length * (380 + REASONING[effort]);
      const usd = (input / 1e6) * inPrice + (output / 1e6) * outPrice;
      console.log(`  ${model} esforço ${effort}: ≈ US$ ${usd.toFixed(0)} (lote/Batch da OpenAI: ≈ US$ ${(usd / 2).toFixed(0)})`);
    }
  }
  console.log(`Áudio ainda sem transcrição: cliente ${minutes("cliente")} min, todos ${minutes("todos")} min (gpt-4o-mini-transcribe ≈ US$ 0,003/min: cliente ≈ US$ ${(minutes("cliente") * 0.003).toFixed(0)}, todos ≈ US$ ${(minutes("todos") * 0.003).toFixed(0)})`);
}

/* --------------------------------------------------------------- transcribe --- */
async function transcribe() {
  const media = flag("midia");
  if (!media || !existsSync(media)) { console.error("Informe a pasta copiada do celular que contém Media/: --midia <pasta>"); process.exit(1); }
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) { console.error("Falta OPENAI_API_KEY."); process.exit(1); }
  const who = flag("quem", "cliente");
  const done = new Set(readJsonl(TRANSCRICOES).map((row) => row.id));
  const todo = readJsonl(AUDIOS).filter((a) => (who === "todos" || !a.atendente) && !done.has(a.id)).slice(0, Number(flag("limite", "1000000")));
  console.log(`Áudios a transcrever: ${todo.length} (${who}) | já feitos: ${done.size}`);
  let index = 0;
  let ok = 0;
  const workers = Array.from({ length: Number(flag("paralelo", "4")) }, async () => {
    while (index < todo.length) {
      const audio = todo[index++];
      const path = join(media, audio.arquivo);
      let record;
      if (!existsSync(path)) record = { id: audio.id, texto: null, motivo: "arquivo não está na cópia" };
      for (let attempt = 1; attempt <= 3 && !record; attempt++) {
        try {
          const form = new FormData();
          form.append("file", new Blob([readFileSync(path)], { type: "audio/ogg" }), "audio.ogg");
          form.append("model", flag("modelo-audio", "gpt-4o-mini-transcribe"));
          form.append("language", "pt");
          const response = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/audio/transcriptions`, {
            method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(120000),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          // O texto é gravado já anonimizado: a transcrição crua de um áudio tem nome, endereço e CPF ditos em voz alta.
          record = { id: audio.id, texto: anonymize(String(body.text ?? "")).slice(0, 4000) };
          ok++;
        } catch (error) {
          if (attempt === 3) record = { id: audio.id, texto: null, motivo: String(error.message).slice(0, 120) };
          else await new Promise((wait) => setTimeout(wait, 2000 * attempt));
        }
      }
      // Falha não vira linha: a próxima rodada tenta de novo. Arquivo ausente vira, para não tentar para sempre.
      if (record.texto !== null || record.motivo === "arquivo não está na cópia") appendFileSync(TRANSCRICOES, `${JSON.stringify(record)}\n`);
      if ((ok + 1) % 200 === 0) console.log(`  ${ok} transcritos`);
    }
  });
  await Promise.all(workers);
  console.log(`Transcritos agora: ${ok}. Rode o ingest-db de novo para os textos entrarem nas conversas.`);
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
  const all = readJsonl(CONVERSAS);
  if (all.length === 0) { console.error("Rode o ingest antes."); process.exit(1); }
  const conversations = selection(all);
  const done = new Map(readJsonl(ANALISE).map((record) => [record.id, record]));
  const pending = conversations.filter((conversation) => done.get(conversation.id)?.status !== "ok");
  const todo = pending.slice(0, Number(flag("limite", String(conversations.length))));
  console.log(`${conversations.length} conversas selecionadas | já analisadas: ${conversations.length - pending.length} | agora: ${todo.length} | ${MODEL} esforço ${EFFORT}`);
  let tokens = 0;
  let index = 0;
  let finished = 0;
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
            ? { id: conversation.id, status: "ok", modelo: MODEL, truncada: truncated, notas: checked.notes, analise: checked.analysis }
            : { id: conversation.id, status: "falha", motivo: checked.reason };
          if (!checked.ok && attempt < 3) record = undefined;
        } catch (error) {
          if (attempt === 3) record = { id: conversation.id, status: "falha", motivo: String(error.message).slice(0, 160) };
          else await new Promise((wait) => setTimeout(wait, 1500 * attempt));
        }
      }
      appendFileSync(ANALISE, `${JSON.stringify(record)}\n`);
      done.set(record.id, record);
      if (++finished % 50 === 0) console.log(`  ${finished}/${todo.length} | tokens ${tokens}`);
    }
  });
  await Promise.all(workers);
  const failed = conversations.filter((c) => done.get(c.id)?.status !== "ok");
  console.log(`Concluído. Análises ok: ${conversations.length - failed.length}/${conversations.length} | falhas: ${failed.length} | tokens: ${tokens}`);
  if (failed.length > 0) console.log("Rode `extract` de novo: só as que falharam são refeitas.");
}

/* ------------------------------------------------------------------- report --- */
function lotDirs() {
  if (!has("todos")) return [OUT];
  return readdirSync(ROOT).map((entry) => join(ROOT, entry)).filter((path) => statSync(path).isDirectory() && existsSync(join(path, "conversas.jsonl")));
}

function report() {
  const dirs = lotDirs();
  const conversations = dirs.flatMap((dir) => selection(readJsonl(join(dir, "conversas.jsonl"))));
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const latest = new Map(dirs.flatMap((dir) => readJsonl(join(dir, "analise.jsonl"))).map((record) => [record.id, record]));
  const ok = [...latest.values()].filter((record) => record.status === "ok" && byId.has(record.id));
  const failed = conversations.length - ok.length;
  const lines = [];
  const out = (text = "") => lines.push(text);
  out(`# Análise do backup de atendimento da BBNET${has("todos") ? " (todos os lotes)" : LOTE ? ` — lote ${LOTE}` : ""}\n`);
  out(`- Lotes: ${dirs.map((dir) => dir.split(/[\\/]/).pop()).join(", ")}`);
  out(`- Conversas de atendimento (os dois lados falaram): **${conversations.length}**`);
  out(`- Analisadas: **${ok.length}** | pendentes ou com falha: **${failed}** ${failed ? "← rode `extract` de novo antes de confiar nos números" : "(cobertura total)"}\n`);
  const all = ok.map((record) => ({ ...record.analise, id: record.id, conv: byId.get(record.id) }));
  out("## Com quem é a conversa\n");
  for (const [type, n] of count(all.map((item) => item.tipoConversa ?? "cliente"))) out(`- ${type}: ${n} (${pct(n, all.length)})`);
  const items = all.filter((item) => (item.tipoConversa ?? "cliente") === "cliente");
  out("\n## Do que o cliente fala\n");
  out("| Família | Conversas | % |\n|---|---|---|");
  for (const [family, n] of count(items.map((item) => item.familia))) out(`| ${family} | ${n} | ${pct(n, items.length)} |`);
  out("\n## Como terminam\n");
  for (const [outcome, n] of count(items.map((item) => item.desfecho))) out(`- ${outcome}: ${n} (${pct(n, items.length)})`);
  out("\n## A IA poderia conduzir?\n");
  for (const [value, n] of count(items.map((item) => item.iaPoderiaResolver))) out(`- ${value}: ${n} (${pct(n, items.length)})`);
  out("\n## Assuntos mais frequentes (maior primeiro)\n");
  const subjects = new Map();
  for (const item of items) { const list = subjects.get(item.assunto) ?? []; list.push(item); subjects.set(item.assunto, list); }
  const ranked = [...subjects.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [subject, list] of ranked.slice(0, 50)) {
    out(`### ${subject} — ${list.length} (${pct(list.length, items.length)})`);
    out(`- Família: ${count(list.map((i) => i.familia))[0][0]} | desfecho mais comum: ${count(list.map((i) => i.desfecho))[0][0]} | OS aberta em ${pct(list.filter((i) => i.os.aberta).length, list.length)} | IA poderia: ${count(list.map((i) => i.iaPoderiaResolver)).map(([v, n]) => `${v} ${pct(n, list.length)}`).join(", ")}`);
    out(`- Jeito do cliente falar: ${count(list.flatMap((i) => i.jeitoDeFalar)).slice(0, 10).map(([w, n]) => `"${w}"${n > 1 ? ` ×${n}` : ""}`).join(", ") || "—"}`);
    out(`- Perguntas da atendente (mais comuns): ${count(list.flatMap((i) => i.perguntasDaAtendente)).slice(0, 8).map(([q]) => q).join(" · ") || "—"}`);
    out(`- Resolução (mais comum): ${count(list.flatMap((i) => i.resolucao)).slice(0, 8).map(([r]) => r).join(" · ") || "—"}`);
    const models = list.filter((i) => i.boaRespostaModelo).slice(0, 3);
    if (models.length) out(`- Conversas-modelo: ${models.map((m) => `\`${m.id}\``).join(", ")}`);
    out();
  }
  out("## O que a atendente concede (a IA NÃO deve repetir sem regra)\n");
  for (const [concession, n] of count(items.flatMap((item) => item.concessoes)).slice(0, 40)) out(`- ${concession} ×${n}`);
  out("\n## Onde a atendente errou ou deixou de perguntar\n");
  for (const [gap, n] of count(items.flatMap((item) => item.lacunas)).slice(0, 30)) out(`- ${gap} ×${n}`);
  out("\n## Urgência e tom\n");
  for (const [level, n] of count(items.map((item) => item.urgencia))) out(`- ${level}: ${n}`);
  for (const [reason, n] of count(items.map((item) => item.motivoUrgencia).filter(Boolean)).slice(0, 15)) out(`  - ${reason} ×${n}`);
  for (const [tone, n] of count(items.map((item) => item.tomCliente))) out(`- tom ${tone}: ${n} (${pct(n, items.length)})`);
  const target = has("todos") ? ROOT : OUT;
  writeFileSync(join(target, "relatorio.md"), lines.join("\n"));
  writeFileSync(join(target, "padroes.json"), JSON.stringify(ranked.map(([subject, list]) => ({
    assunto: subject, conversas: list.length, familia: count(list.map((i) => i.familia))[0][0],
    jeitoDeFalar: count(list.flatMap((i) => i.jeitoDeFalar)).slice(0, 20).map(([w]) => w),
    perguntas: count(list.flatMap((i) => i.perguntasDaAtendente)).slice(0, 12).map(([q]) => q),
    resolucao: count(list.flatMap((i) => i.resolucao)).slice(0, 12).map(([r]) => r),
  })), null, 2));
  console.log(`Relatório em ${join(target, "relatorio.md")} — cobertura ${ok.length}/${conversations.length}.`);
}

const commands = { ingest, "ingest-db": ingestDb, custo: cost, transcribe, extract, report };
if (!commands[command]) { console.error("Uso: ingest-db <msgstore.db> --lote X | ingest <pasta> | custo | transcribe | extract | report (veja o topo do arquivo)"); process.exit(1); }
await commands[command]();
