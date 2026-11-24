/**
 * Como a OS aberta pela IA fica igual à de uma atendente — e vai para o técnico certo.
 *
 * Tudo aqui foi medido no IXC da BBNET em 24/11/2026, não suposto:
 * - 26 OS de 9 atendentes, lidas no registro de INSERÇÃO (`ixc_logs`): 100% nascem com endereço
 *   (`endereco`, `bairro`, `id_cidade`), `liberado = 1`, `impresso = N`, `status_assinatura = A`,
 *   `gera_comissao = S` (o assunto tem comissão R$ 0,00: não gera dinheiro, só a contagem) e 81% com técnico.
 * - O endereço segue o login: `endereco_padrao_cliente` S = do cliente, C = do contrato, N = do próprio
 *   login (a armadilha que o SeeNet levou meses para achar: o "C" existia). O texto usa o molde do
 *   assunto (`formato_endereco`, hoje `#uf# #cidade# #cep# #bairro# - #endereco#, #numero#`).
 * - `melhor_horario_agenda`: M manhã, T tarde, Q qualquer (nas 1000 OS mais recentes só aparecem esses).
 * - Regras de técnico da operação (24/11): moto não sobe em poste; poste ou telhado → carro; cidade só
 *   de carro manda para o carro; no sábado moto e carro fazem tudo que não precisa de poste; entre vários,
 *   começa por quem tem menos OS aberta e alterna.
 *
 * Sem rede e sem banco: as decisões são testadas sozinhas.
 */

export type Vehicle = "moto" | "carro";
export type AddressSource = "customer" | "contract" | "login";

/** `endereco_padrao_cliente` do login: S cliente, C contrato, N (ou vazio) o próprio login. */
export function addressSourceOf(loginFlag: string | undefined | null): AddressSource {
  const flag = String(loginFlag ?? "").trim().toUpperCase();
  return flag === "S" ? "customer" : flag === "C" ? "contract" : "login";
}

export interface AddressParts {
  street: string; number: string; neighborhood: string; zip: string;
  cityId: string; cityName: string; state: string;
  complement: string; reference: string; latitude: string; longitude: string;
}

const clean = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text === "0" || /^0000-00-00/.test(text) ? "" : text;
};

/** Junta os campos da fonte escolhida; coordenadas preferem o login (é onde a ONU está). */
export function addressPartsFrom(source: Record<string, unknown>, login: Record<string, unknown> | undefined, city: { name: string; state: string } | undefined): AddressParts {
  const lat = clean(login?.latitude) || clean(source.latitude);
  const lng = clean(login?.longitude) || clean(source.longitude);
  return {
    street: clean(source.endereco), number: clean(source.numero), neighborhood: clean(source.bairro), zip: clean(source.cep),
    cityId: clean(source.cidade), cityName: city?.name ?? "", state: city?.state ?? "",
    complement: clean(source.complemento), reference: clean(source.referencia),
    latitude: lat && lng ? lat : "", longitude: lat && lng ? lng : "",
  };
}

/** O texto que a tela do IXC grava em `endereco`, pelo molde do assunto. */
export function renderAddress(format: string, parts: AddressParts): string {
  const template = format.trim() || "#uf# #cidade# #cep# #bairro# - #endereco#, #numero#";
  const text = template
    .replace(/#uf#/g, parts.state).replace(/#cidade#/g, parts.cityName).replace(/#cep#/g, parts.zip)
    .replace(/#bairro#/g, parts.neighborhood).replace(/#endereco#/g, parts.street).replace(/#numero#/g, parts.number);
  // Campo vazio não pode deixar ", " ou " - " soltos no fim.
  return text.replace(/\s+/g, " ").replace(/\s+,/g, ",").replace(/[,\s-]+$/g, "").trim();
}

/** M manhã, T tarde, Q qualquer — o que o cliente disse na conversa. */
export function bestTimeCode(summary: string): "M" | "T" | "Q" {
  const text = normalize(summary);
  const morning = /\bmanha\b|\bde manha\b|periodo da manha|\bcedo\b/.test(text);
  const afternoon = /\btarde\b/.test(text);
  if (morning && !afternoon) return "M";
  if (afternoon && !morning) return "T";
  return "Q";
}

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Precisa subir em poste ou telhado? `true` = carro, `false` = moto, `undefined` = não deu para saber.
 * A ficha da IA traz a linha "Precisa subir em poste ou telhado: sim/não" (pergunta do roteiro técnico);
 * sem ela, os sinais de fio/fibra decidem. Sinal da fibra crítico também é problema de rede, não de casa.
 */
export function needsClimb(summary: string, fiberRxDbm?: number | null): boolean | undefined {
  const text = normalize(summary);
  // "não sei" não é "não": cai nos sinais abaixo.
  const stated = /poste ou telhado\s*:\s*(sim|nao)(?!\s*sei)/.exec(text);
  if (stated) return stated[1] === "sim";
  // A própria linha da ficha ("...poste ou telhado: não sei") não pode contar como sinal de poste.
  const body = text.replace(/precisa subir em poste ou telhado\s*:[^\n]*/g, "");
  if (/\bposte\b|telhado|\bescada\b|fio (caiu|caido|rompid|arrebent|cortad|solto|arrancad|partid)|cabo (caiu|caido|rompid|arrebent|cortad|solto|arrancad|partid)|drop (rompid|caid|cortad)|\blos\b|luz vermelha|sem sinal na fibra/.test(body)) return true;
  if (typeof fiberRxDbm === "number" && fiberRxDbm < -27) return true;
  if (/roteador|wi-?fi|senha|cabo de rede|dentro de casa|troca de (aparelho|equipamento)|aparelho novo|configur/.test(body)) return false;
  return undefined;
}

/** Sem internet tem dois assuntos no IXC: 9 SEM FUNCIONAR/TÉC. MOTO e 14 SEM FUNCIONAR/EQUIPE CARRO. */
export const NO_CONNECTION_SUBJECT: Record<Vehicle, string> = { moto: "9", carro: "14" };

/** Moto não leva escada. Sem saber se precisa subir, vai o carro, que faz os dois serviços. */
export function vehicleFor(climb: boolean | undefined): Vehicle {
  return climb === false ? "moto" : "carro";
}

export interface TechnicianRoute { cityId: string; vehicle: Vehicle; technicianId: string; technicianName?: string; active: boolean }

/**
 * Quem pode receber a OS, pelas regras da operação:
 * - poste ou telhado → só carro (no sábado também);
 * - no sábado, o que não precisa de poste vai para moto e carro;
 * - cidade sem o tipo pedido manda para o outro ("tem cidade que só tem carro, é só mandar"),
 *   menos poste para moto;
 * - cidade sem técnico cadastrado (Itabaiana: equipes que rodam conforme a necessidade) → ninguém,
 *   e o setor técnico distribui.
 */
export function technicianCandidates(routes: TechnicianRoute[], cityId: string, climb: boolean | undefined, saturday: boolean): string[] {
  const ofCity = routes.filter((route) => route.active && route.cityId === cityId);
  const ids = (vehicle: Vehicle) => [...new Set(ofCity.filter((route) => route.vehicle === vehicle).map((route) => route.technicianId))];
  const moto = ids("moto");
  const carro = ids("carro");
  if (climb !== false) return carro;
  if (saturday) return [...new Set([...moto, ...carro])];
  return moto.length ? moto : carro;
}

/** Menos OS aberta primeiro; empate alterna a partir de quem recebeu por último. */
export function pickTechnician(candidates: string[], openOrders: Map<string, number>, lastAssigned?: string | null): string | undefined {
  const known = candidates.filter((id) => openOrders.has(id));
  if (known.length === 0) return undefined;
  const least = Math.min(...known.map((id) => openOrders.get(id)!));
  const tied = known.filter((id) => openOrders.get(id) === least).sort((a, b) => Number(a) - Number(b));
  if (tied.length === 1 || !lastAssigned) return tied[0];
  return tied.find((id) => Number(id) > Number(lastAssigned)) ?? tied[0];
}

/** Sábado pelo relógio de Brasília (o servidor roda em UTC). */
export function isSaturdayInBrasilia(at: Date): boolean {
  return new Date(at.getTime() - 3 * 3600 * 1000).getUTCDay() === 6;
}
