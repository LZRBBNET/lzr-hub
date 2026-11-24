/**
 * Tirar nome de gente do texto do backup — sem saber os nomes.
 *
 * Na exportação em texto o nome do cliente vem no cabeçalho de cada mensagem e a limpeza sabe o que procurar.
 * No banco do WhatsApp (`msgstore.db`) não: o backup da atendente de Itabaiana veio com a agenda vazia
 * (`wa_contacts` com 0 linhas), e o nome só aparece dentro da conversa ("Bom dia Maria", "o titular é JOSÉ
 * DOS SANTOS"). Então o nome é achado por três caminhos:
 *
 * 1. lista dos prenomes mais comuns no Brasil (e em Sergipe), com sobrenome logo depois;
 * 2. posição: depois de cumprimento ("Boa tarde, Jailson"), de tratamento ("dona Quitéria") e de "meu nome é";
 * 3. maiúsculas: "MARIA JOSÉ DOS SANTOS" quando uma das palavras é prenome ou sobrenome conhecido.
 *
 * Não é perfeito — prenome raro escrito em minúscula passa. Por isso o texto continua indo ao modelo só sem
 * CPF, telefone, endereço e números (a limpeza dura), e o nome é a camada de cima. Cidade de atendimento
 * (Glória, Aparecida, Frei Paulo) é protegida: ela é dado de operação, não de pessoa.
 */

const fold = (word: string) => word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const FIRST_NAMES = new Set(`
maria jose ana joao antonio francisco carlos paulo pedro lucas luiz luis marcos gabriel rafael francisca daniel marcelo
bruno eduardo felipe raimundo rodrigo antonia adriana juliana marcia fernanda patricia aline sandra camila amanda bruna
jessica leticia julia luciana vanessa mariana gabriela larissa claudia beatriz rita luana sonia renata eliane josefa simone
natalia cristiane carla debora rosangela jaqueline daniela marlene terezinha raimunda andreia andrea fabiana lucia raquel
angela rafaela joana luzia elaine daiane cristina carolina tatiane priscila sueli isabela roberta viviane edna edilene
eliana silvia regina solange rosana kelly karina michele michelle lais gisele valeria ivone cleide neide rosilene rosimeire
rosemeire alessandra joseane josiane jociane joelma quiteria maiara mayara thais tais taina ingrid emilly emily alice laura
helena sofia sophia manuela valentina heloisa livia lorena cecilia elisangela gilvania gilvanete lucineide marileide
edileuza edileide jailma josilene josineide nadja nubia poliana rayane raiane rayssa sabrina samara samanta tamires tamara
vania vanda wilma zelia zilda zuleide iara ilma irene isabel ivete jane janaina jeane jenifer jennifer jordana joyce katia
keila kelli lidiane lilian lindalva luciene lucilene lucimara madalena margarida marilene marilia marinalva marta miriam
monica nair nathalia neusa nilda nilza odete olga paula rejane rose rosemary selma silvana tania telma teresa tereza
valdirene vilma adriele adrielle agatha alana alessa alexsandra aliane amelia ana-paula andressa angelica antonieta
ariane aurea barbara bianca carmen celia cicera cintia clarice cleonice creusa dalva damiana dayane deise denise dilma
dulce edjane edlene edneia elen eliene elisa elizabete elza ester eunice evelyn fatima flavia geane gilda girlene glaucia
greice heloise hilda iolanda ivania ivanilde jacqueline jamile jandira jeniffer joice josefina jucilene jussara karla
kaline lara leila lena lenilda lidia lindinalva lourdes luana lucelia luiza maisa marcela margareth mariza marli marlucia
maura mirian naiara nayara neide nicole noemia norma rafaella regiane rosalia rosilda rosimere roseane rosiane rozana
samira silvania stefany suelen sueli suzana tatiana thamires valquiria vanusa vera vitoria yasmin yara zenaide
jose-carlos adailton ailton adelmo agnaldo aldo alisson almir amaro arnaldo augusto benedito cicero cleiton cleber cosme
damiao danilo davi denilson deivid edinaldo edivaldo edmilson edvaldo elias elton emerson enzo erick erik everton evandro
ezequiel fabricio flavio gean genivaldo gerson gilberto gilson gilmar givaldo hugo humberto igor isaac ismael israel
italo ivan jailson jadson jamerson jean jefferson joel jonatas jonathan jorge josenildo josivaldo juliano junior kaique
kleber laercio lauro luan luciano manoel manuel mario mauricio mauro miguel moises murilo natan nelson nilton osvaldo
otavio pablo raul reginaldo reinaldo roberval robson romario ronaldo ruan rubens samuel saulo silvio tarcisio thiago tiago
ulisses valter walter wagner washington wesley weslley wilson yuri sebastiao andre fernando fabio leonardo gustavo
guilherme leandro anderson ricardo marcio alex alexandre roberto edson diego vitor victor sergio claudio matheus mateus
renato geraldo adriano julio renan rogerio valdir joaquim jonas wellington douglas wendel breno vinicius valberto celio
alan allan alessandro alcides aloisio altair amauri anselmo antonio-carlos arthur artur benicio caio carlito cassio
cesar charles cleverton clodoaldo clovis cristiano davidson deivison dener diogo djalma edilson edimilson edinho
edmundo eduardo elenilson eliseu elivelton emanuel erivaldo erisvaldo euclides fagner felix francinaldo gabriel genilson
geovane gildo gileno giovani gleidson heitor helio heraldo hercules iago irineu isaias jackson jailton jair jairo
jamesson jardel jeferson jhonatan joabe joao-pedro jociel jorginho josue juarez kauan kauã kelvin lazaro leomar levi
lindomar lourival luciano marcone marconi mariano marlon marinaldo maxwell micael milton nailson nathan neilton nivaldo
odair orlando oseas paulinho rafael raimundo ramon reinan riquelme rivaldo robert robertinho rodolfo romildo rony
rosivaldo sidney silas sinval tadeu tiago uelington uilian vagner valdeci valdemir valmir vanderlei vinicios wanderson
welington wendell weverton willian william wilian zacarias manoela manuella emanuela emanuele emanuelly
`.trim().split(/\s+/).flatMap((name) => name.split("-")).filter((name) => name.length >= 3));

/**
 * Prenomes que também são palavra comum ("rosa", "socorro") ou cidade: só contam com inicial maiúscula.
 * "Luz", "Graça", "Paz" ficam de fora de vez: "Luz vermelha" e "Graças a Deus" abrem frase o tempo todo aqui.
 */
const CAPITALIZED_ONLY = new Set([
  "rosa", "gloria", "aparecida", "vitoria", "clara", "socorro", "conceicao", "dores", "lourdes", "branca", "vera",
  "aurora", "sara", "fatima", "regina", "lena", "norma", "dulce", "junior", "levi", "lara", "elisa", "alice", "rose",
  "cesar", "felix", "silas", "jane", "mario",
]);
for (const word of CAPITALIZED_ONLY) FIRST_NAMES.add(word);

const SURNAMES = new Set(`
silva santos oliveira souza sousa lima pereira ferreira costa rodrigues almeida nascimento alves carvalho araujo ribeiro
gomes martins rocha barbosa melo mello cardoso mendonca menezes meneses andrade batista jesus conceicao dias teixeira
vieira monteiro moura correia correa freitas barros pinto cavalcante cavalcanti fontes prata bispo reis matos mattos nunes
machado lopes soares fernandes goncalves moreira mendes ramos cruz campos rezende resende sobral garcez feitosa tavares
farias faria siqueira xavier pires porto brito guimaraes macedo medeiros marques miranda moraes morais neves nogueira
paiva queiroz sales salles sampaio santana silveira torres vasconcelos valenca aragao amorim aquino azevedo bezerra braga
cabral calazans chagas coelho cunha damasceno dantas duarte esteves figueiredo franca freire galvao garcia gois goes hora
leite leal lisboa lobo maciel magalhaes maia montes mota motta nobre novais novaes passos prado rios rosario sena serafim
silvestre tenorio trindade valadares viana vianna vilela junior filho neto sobrinho fonseca lacerda
`.trim().split(/\s+/));

const CONNECTORS = new Set(["de", "da", "do", "dos", "das", "e"]);

/** Palavras que aparecem com maiúscula no começo de frase e não são nome. */
const COMMON_CAPS = new Set(`
a o e os as um uma eu tu ele ela nos voce voces sim nao ok tudo bem bom boa dia tarde noite oi ola obrigado obrigada
por favor segue vou pode ja agora certo perfeito entendi entendo claro aguarde aguardo beleza blz valeu bbnet internet
cliente senhor senhora vamos estou esta estamos sera seria qual quando onde como porque pq que se mas mais muito muita
desde hoje amanha ontem favor pix boleto fatura os protocolo tecnico tecnica equipe loja suporte atendimento
quem minha meu minhas meus sua seu suas seus dele dela mae pai esposa marido filho filha irma irmao titular responsavel
empresa sem com para pra no na em net wifi luz casa rua pessoal gente moco moca
`.trim().split(/\s+/));

/** Cidades e lugares da área da BBNET: dado de operação. Ficam protegidos antes da caça ao nome. */
const PLACES = [
  "Nossa Senhora da Glória", "Nossa Senhora Aparecida", "Nossa Senhora das Dores", "Nossa Senhora de Lourdes",
  "Nossa Senhora do Socorro", "Santa Rosa de Lima", "São Miguel do Aleixo", "Campo do Brito", "Frei Paulo", "São Paulo",
  "São Domingos", "Moita Bonita", "Feira Nova", "Areia Branca", "Simão Dias", "Divina Pastora", "Graccho Cardoso",
  "Monte Alegre", "Porto da Folha", "Rosário do Catete", "General Maynard", "Glória", "Aparecida", "Dores", "Lourdes",
  "Socorro", "Nossa Senhora",
];
// Procurada no texto sem acento ("GLORIA", "gloria"), com as posições do original: tirar o acento letra por letra
// mantém o comprimento.
const PLACE_PATTERN = new RegExp(`(?<![\\p{L}])(?:${PLACES.map((place) => fold(place).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}])`, "gu");
const foldKeepingLength = (text: string) => [...text].map((char) => { const base = char.normalize("NFD").replace(/[̀-ͯ]/g, ""); return base.length === char.length ? base.toLowerCase() : char; }).join("");

const GREETINGS = /(?:^|[\s,.!?])(?:oi|ola|olá|bom\s+dia|boa\s+tarde|boa\s+noite|obrigad[oa]|ok|certo|perfeito|prezad[oa])[\s,!.]*$/iu;
const TITLES = new Set(["sr", "sra", "srta", "senhor", "senhora", "dona", "seu", "dr", "dra", "doutor", "doutora", "tia", "tio", "dna"]);
// Depois destes, o nome pode vir em minúscula ("meu nome é jailsom", "bom dia, atend: fulana").
const STRONG_TRIGGER = /(?:meu\s+nome\s+(?:é|e)|me\s+chamo|nome\s+do\s+titular\s+(?:é|e)|titular\s+(?:é|e)|em\s+nome\s+d[eoa]|atend(?:ente)?\s*:)[\s:,]*$/iu;
/** O que pode vir depois de um vocativo sem que ele deixe de ser nome: "Bom dia Jailson tudo bem?". */
const VOCATIVE_FOLLOWERS = new Set(["tudo", "td", "como", "bom", "boa", "blz", "beleza", "tranquilo", "joia"]);
// Depois destes, só com maiúscula: "sou a titular" não é nome, "sou a Jéssica" é.
const SOFT_TRIGGER = /(?:aqui\s+(?:é|e)\s+(?:a|o)|sou\s+(?:a|o)|fala\s+(?:a|o)|com\s+(?:a|o))[\s:,]*$/iu;

interface Token { text: string; start: number; end: number; key: string }

const isCapitalized = (word: string) => /^\p{Lu}/u.test(word);
const isAllCaps = (word: string) => word.length >= 2 && word === word.toUpperCase() && /\p{Lu}/u.test(word);
const isFirstName = (token: Token) => FIRST_NAMES.has(token.key) && (!CAPITALIZED_ONLY.has(token.key) || isCapitalized(token.text));
const isNamePart = (token: Token) => FIRST_NAMES.has(token.key) || SURNAMES.has(token.key);
// Sigla curta em maiúsculas ("seu CPF", "a ONU") não é nome.
const looseCapital = (token: Token) => isCapitalized(token.text) && !COMMON_CAPS.has(token.key) && token.text.length >= 3
  && (!isAllCaps(token.text) || token.text.length >= 5);

/** Troca os nomes de pessoa por `[NOME]`. Cidade protegida volta como estava. */
export function scrubNames(input: string): string {
  const places: string[] = [];
  let text = input;
  const found = [...foldKeepingLength(input).matchAll(PLACE_PATTERN)];
  for (const match of found.reverse()) {
    places.unshift(input.slice(match.index!, match.index! + match[0].length));
    text = `${text.slice(0, match.index!)}\u0000${found.length - places.length}\u0000${text.slice(match.index! + match[0].length)}`;
  }
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\p{L}[\p{L}'’]*/gu)) tokens.push({ text: match[0], start: match.index!, end: match.index! + match[0].length, key: fold(match[0]) });
  const spans: Array<[number, number]> = [];
  const adjacent = (a: Token, b: Token) => /^[ \t]+$/.test(text.slice(a.end, b.start));
  // Continua o nome: sobrenome, outro prenome ("Maria José"), conector seguido de sobrenome, ou maiúscula solta logo
  // depois de um nome com maiúscula ("Maria Quitéria").
  const extend = (from: number, capitalStart: boolean) => {
    let end = from;
    for (let next = from + 1; next < tokens.length && adjacent(tokens[next - 1], tokens[next]); next++) {
      const token = tokens[next];
      if (isNamePart(token) || (capitalStart && looseCapital(token))) { end = next; continue; }
      if (CONNECTORS.has(token.key) && tokens[next + 1] && adjacent(token, tokens[next + 1]) && isNamePart(tokens[next + 1])) continue;
      break;
    }
    return end;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const before = text.slice(Math.max(0, token.start - 40), token.start);
    const previous = tokens[index - 1];
    const afterTitle = previous && TITLES.has(previous.key.replace(/\.$/, "")) && /^[.\s]+$/.test(text.slice(previous.end, token.start));
    const next = tokens[index + 1];
    const afterNext = tokens[index + 2];
    // "JAILSOM SANTOS", "JAILSOM DOS SANTOS": prenome que a lista não conhece, seguido de sobrenome em maiúsculas.
    const capsSurnameAhead = isAllCaps(token.text) && !COMMON_CAPS.has(token.key) && token.text.length >= 3 && !!next && adjacent(token, next)
      && ((isAllCaps(next.text) && SURNAMES.has(next.key))
        || (CONNECTORS.has(next.key) && !!afterNext && adjacent(next, afterNext) && isAllCaps(afterNext.text) && SURNAMES.has(afterNext.key)));
    // "Fulaninha Da Silva Costa", "kauan dos santos": prenome fora da lista, seguido de sobrenome (com ou sem conector).
    const surnameAhead = !COMMON_CAPS.has(token.key) && !CONNECTORS.has(token.key) && !SURNAMES.has(token.key) && token.text.length >= 4 && !!next && adjacent(token, next)
      && (SURNAMES.has(next.key) || (CONNECTORS.has(next.key) && next.key !== "e" && !!afterNext && adjacent(next, afterNext) && SURNAMES.has(afterNext.key)));
    let start = false;
    if (isFirstName(token)) start = true;
    else if (surnameAhead) start = true;
    else if ((afterTitle || SOFT_TRIGGER.test(before)) && looseCapital(token)) start = true;
    else if (GREETINGS.test(before) && looseCapital(token)) {
      // Vocativo fecha a saudação ("Boa tarde, Jailson!", "Bom dia Jailson tudo bem?"). Seguido de frase não é nome:
      // "Olá! Quero ter mais informações" é o texto do anúncio da Meta, e 473 aberturas viravam "[NOME] ter mais...".
      const end = extend(index, true);
      const after = /^[ \t]+(\p{Ll}+)/u.exec(text.slice(tokens[end].end));
      if (!after || VOCATIVE_FOLLOWERS.has(fold(after[1]))) { spans.push([token.start, tokens[end].end]); index = end; }
      continue;
    }
    else if (STRONG_TRIGGER.test(before) && !COMMON_CAPS.has(token.key) && token.text.length >= 3 && !CONNECTORS.has(token.key)) start = true;
    else if (capsSurnameAhead) start = true;
    if (!start) continue;
    // Em maiúsculas, só nome conhecido estende o trecho: "JOSÉ SANTOS SEM INTERNET" não pode virar um nome só.
    const end = extend(index, isCapitalized(token.text) && !isAllCaps(token.text));
    spans.push([token.start, tokens[end].end]);
    index = end;
  }
  let out = text;
  for (const [start, end] of spans.reverse()) out = `${out.slice(0, start)}[NOME]${out.slice(end)}`;
  return out.replace(/\[NOME\](?:\s+\[NOME\])+/g, "[NOME]").replace(/\u0000(\d+)\u0000/g, (_, index) => places[Number(index)]);
}

/** Login, senha de Wi-Fi, código de rede: palavra com letra e número misturados, e o que vem depois de "senha". */
export function scrubCodes(text: string): string {
  return text
    // "a senha é o CPF" é instrução, não senha: artigo e "CPF/mesma/igual" ficam.
    .replace(/\b(senha|password)((?:\s+(?:do|da|de)\s+(?:wi-?fi|rede|internet|roteador|app|aplicativo))?\s*(?:é|e|:|=|nova)\s*)((?:o|a|seu|sua)\s+)?(\S+)/giu,
      (all, label, middle, article, value) => (/^(cpf|mesm[oa]|igual|nova|antiga|do|da|de|n[uú]mero|data)\b/i.test(value) ? all : `${label}${middle}${article ?? ""}[SENHA]`))
    .replace(/\b(?=[\p{L}\d_.@-]*\d)(?=[\p{L}\d_.@-]*\p{L})[\p{L}\d_.@-]{6,}\b/gu, "[CÓDIGO]");
}
