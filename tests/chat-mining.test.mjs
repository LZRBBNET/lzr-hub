import test from "node:test";
import assert from "node:assert/strict";
import { androidKind, anonymize, detectAttendant, leftoverPii, parseWhatsAppExport, segmentConversations, toAnonymousConversation, validateAnalysis } from "../lib/platform/chat-mining-shared.ts";
import { scrubCodes, scrubNames } from "../lib/platform/chat-mining-names.ts";

const ANDROID = `18/11/2026 09:00 - As mensagens e ligações são protegidas com a criptografia de ponta a ponta.
18/11/2026 09:01 - Maria Souza: Bom dia minha internet ta sem funcionar
tem 3 dias já
18/11/2026 09:02 - Ana (BBNET): Bom dia Maria! Qual seu CPF? 
18/11/2026 09:03 - Maria Souza: 529.982.247-25 moro na Rua das Flores, 120 bairro Centro cel 79 99830-7232
18/11/2026 09:04 - Maria Souza: PTT-20261118-WA0001.opus (arquivo anexado)
18/11/2026 09:05 - Maria Souza: <Mídia oculta>
18/11/2026 09:06 - Ana (BBNET): Esta mensagem foi apagada
18/11/2026 18:00 - Maria Souza: boa noite voltou obrigada
19/11/2026 08:00 - José Lima: oi quero cancelar`;

const IOS = `[18/11/2026 09:01:10] Maria Souza: oi
[18/11/2026 09:02:00] Ana (BBNET): ‎imagem ocultada`;

test("lê a exportação do Android: continuação de linha, sistema e mídia", () => {
  const { messages } = parseWhatsAppExport(ANDROID);
  assert.equal(messages.length, 9);
  assert.equal(messages[0].kind, "system");
  assert.equal(messages[1].text, "Bom dia minha internet ta sem funcionar\ntem 3 dias já", "linha sem data continua a mensagem");
  assert.equal(messages[4].kind, "audio");
  assert.equal(messages[5].kind, "image");
  assert.equal(messages[6].kind, "deleted");
  assert.equal(messages[1].at, "2026-11-18T09:01");
});

test("lê a exportação do iPhone", () => {
  const { messages } = parseWhatsAppExport(IOS);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].kind, "image");
});

test("separa conversas pelo silêncio e não perde mensagem", () => {
  const { messages } = parseWhatsAppExport(ANDROID);
  const conversations = segmentConversations(messages, 6);
  assert.equal(conversations.length, 3, "manhã, noite do mesmo dia e dia seguinte");
  assert.equal(conversations.flat().length, messages.filter((m) => m.kind !== "system").length);
});

test("anonimização tira CPF, telefone, endereço, bairro e nome — e a limpeza se confere", () => {
  const out = anonymize("Maria Souza: 529.982.247-25 moro na Rua das Flores, 120 bairro Centro cel 79 99830-7232 e-mail a@b.com CEP 49500-000", ["Maria Souza"]);
  assert.deepEqual(leftoverPii(out), []);
  assert.doesNotMatch(out, /Maria|Flores|Centro|529|99830/);
  assert.match(out, /\[NOME\]/);
  assert.match(anonymize("sem internet há 3 dias, luz LOS vermelha"), /sem internet há 3 dias, luz LOS vermelha/, "texto sem dado pessoal passa intacto");
});

test("a conversa anonimizada marca quem falou e a mídia, sem o texto bruto", () => {
  const { messages } = parseWhatsAppExport(ANDROID);
  const first = segmentConversations(messages, 6)[0];
  const conversation = toAnonymousConversation("x-001", first, "Ana (BBNET)");
  assert.equal(conversation.attendantMessages, 2);
  assert.equal(conversation.media.audio, 1);
  assert.match(conversation.transcript, /CLIENTE: \[áudio\]/);
  assert.match(conversation.transcript, /ATENDENTE: Bom dia \[NOME\]/);
  assert.deepEqual(leftoverPii(conversation.transcript), []);
  assert.doesNotMatch(conversation.transcript, /Maria|Souza|529|Flores/);
});

test("nome sem saber o nome: lista de prenomes, cumprimento, maiúsculas e 'meu nome é'", () => {
  assert.equal(scrubNames("Bom dia Maria! Tudo bem?"), "Bom dia [NOME]! Tudo bem?");
  assert.equal(scrubNames("Boa tarde, Jailsom"), "Boa tarde, [NOME]", "prenome fora da lista, depois de cumprimento");
  assert.equal(scrubNames("o titular é JOSÉ DOS SANTOS"), "o titular é [NOME]");
  assert.equal(scrubNames("JAILSOM SANTOS SEM INTERNET"), "[NOME] SEM INTERNET", "maiúsculas não engolem o resto da frase");
  assert.equal(scrubNames("meu nome é kauã ferreira"), "meu nome é [NOME]");
  assert.equal(scrubNames("dona Quitéria Bispo ligou"), "dona [NOME] ligou");
  assert.equal(scrubNames("Maria José da Silva Santos"), "[NOME]");
  assert.equal(scrubNames("Bom dia Jailsom tudo bem?"), "Bom dia [NOME] tudo bem?");
  assert.equal(scrubNames("bom dia,atend:fulaninha"), "bom dia,atend:[NOME]");
  assert.equal(scrubNames("Fulaninha Da Silva Costa?"), "[NOME]?", "prenome raro com sobrenome");
  assert.equal(scrubNames("é kauanzinho dos santos"), "é [NOME]");
});

test("nome: frase depois de cumprimento não é vocativo (anúncio da Meta: 'Olá! Quero ter mais informações')", () => {
  assert.equal(scrubNames("Olá! Quero ter mais informações sobre isso."), "Olá! Quero ter mais informações sobre isso.");
  assert.equal(scrubNames("Olá! Tenho interesse e queria mais informações"), "Olá! Tenho interesse e queria mais informações");
  assert.equal(scrubNames("*N. S DA GLORIA* - link"), "*N. S DA GLORIA* - link", "cidade sem acento e em maiúsculas");
  assert.equal(scrubNames("Gloria"), "Gloria");
});

test("nome: o que não é gente passa intacto (cidade, luz vermelha, sigla, frase comum)", () => {
  for (const text of ["Luz vermelha piscando", "Graças a Deus voltou", "sou a titular", "moro em Nossa Senhora da Glória",
    "atendo Aparecida e Frei Paulo", "seu CPF por favor", "LOS VERMELHA", "Ok Vou verificar", "em nome de quem está?", "Campo do Brito"]) {
    assert.equal(scrubNames(text), text);
  }
});

test("ficha colada entre lojas: endereço rotulado, login sem número e número da casa (casos reais do backup)", () => {
  const out = anonymize("Local: Rua sem nome perto da padaria\nLogin:casafulana\nSenha: abc\no login é o transmissao\nmora no nº 33");
  assert.doesNotMatch(out, /padaria|casafulana|transmissao|33/);
  assert.match(out, /Local: \[ENDEREÇO\]/);
  assert.equal(anonymize("tanto o login como a senha é o CPF"), "tanto o login como a senha é o CPF", "frase de instrução passa");
  assert.equal(anonymize("login e senha de acesso é o cpf"), "login e senha de acesso é o cpf");
});

test("login e senha de Wi-Fi viram marcador", () => {
  assert.equal(scrubCodes("a senha do wifi é casa2024 e o login mariasilva123"), "a senha do wifi é [SENHA] e o login [CÓDIGO]");
  assert.equal(scrubCodes("internet de 300 mega"), "internet de 300 mega");
});

test("banco do WhatsApp: tipo de mensagem e quem falou vêm do banco, não do nome", () => {
  assert.equal(androidKind(0), "text");
  assert.equal(androidKind(2), "audio");
  assert.equal(androidKind(90), "call");
  assert.equal(androidKind(15), "deleted");
  assert.equal(androidKind(999), "other");
  const conversation = toAnonymousConversation("itabaiana-x", [
    { at: "2026-11-24T08:00", author: "CLIENTE", staff: false, kind: "text", text: "Bom dia, estou sem internet" },
    { at: "2026-11-24T08:01", author: "ATENDENTE", staff: true, kind: "text", text: "Bom dia Maria! Qual a cor da luz?" },
    { at: "2026-11-24T08:02", author: "CLIENTE", staff: false, kind: "audio", text: "", transcript: "tá vermelha, meu CPF é 529.982.247-25" },
    { at: "2026-11-24T08:03", author: "CLIENTE", staff: false, kind: "contact", text: "José da Silva" },
    { at: "2026-11-24T08:04", author: "CLIENTE", staff: false, kind: "call", text: "" },
  ], "ATENDENTE");
  assert.equal(conversation.attendantMessages, 1);
  assert.match(conversation.transcript, /CLIENTE: \[áudio\] tá vermelha/);
  assert.match(conversation.transcript, /CLIENTE: \[contato\]$/m, "o texto do contato é o nome da pessoa: não entra");
  assert.match(conversation.transcript, /CLIENTE: \[ligação\]/);
  assert.doesNotMatch(conversation.transcript, /Maria|José|529/);
  assert.equal(validateAnalysis({ tipo_conversa: "interno", assunto: "escala" }).analysis.tipoConversa, "interno");
  assert.equal(validateAnalysis({ assunto: "x" }).analysis.tipoConversa, "cliente");
});

test("a atendente é quem aparece em (quase) todos os arquivos", () => {
  const found = detectAttendant([["Ana", "Cliente 1"], ["Ana", "Cliente 2"], ["Cliente 3", "Ana"]]);
  assert.deepEqual(found, { name: "Ana", share: 1 });
});

test("valida a análise: enum fora da lista vira neutro; dado pessoal é recusado", () => {
  const ruim = validateAnalysis({ assunto: "SEM INTERNET", familia: "xyz", desfecho: "feito", os: { aberta: true, tipo: "visita" }, jeito_de_falar: ["ta sem net"], urgencia: "extrema" });
  assert.equal(ruim.ok, true);
  assert.equal(ruim.analysis.assunto, "sem internet");
  assert.equal(ruim.analysis.familia, "outro");
  assert.equal(ruim.analysis.urgencia, "baixa");
  assert.ok(ruim.notes.includes("familia_invalida"));
  assert.equal(ruim.analysis.os.aberta, true);
  assert.equal(validateAnalysis({ assunto: "fatura", resolucao: ["mandou para 79998307232"] }).ok, false);
  assert.equal(validateAnalysis("texto").ok, false);
});
