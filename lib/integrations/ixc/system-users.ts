import { basicCredential } from "./readonly-provider.ts";

/**
 * Leitura dos usuários do sistema IXC (funcionários do provedor), usada para
 * provisionar contas no LZR HUB.
 *
 * Fica separado do IxcReadonlyProvider de propósito: aquele protege dados de
 * clientes por allowlist de cadastro, e essa regra não se aplica aqui. Manter
 * junto obrigaria a furar a allowlist e enfraqueceria a proteção de lá.
 *
 * ⚠️ O endpoint `usuarios` do IXC devolve o campo `senha` com o hash da senha
 * de cada funcionário. Este módulo descarta esse campo explicitamente e nunca
 * o repassa adiante: só os cinco campos abaixo saem daqui.
 */
export interface IxcSystemUser {
  ixcId: string;
  name: string;
  email: string;
  groupId: string;
  active: boolean;
}

export interface IxcSystemUsersOptions {
  baseUrl: string;
  token: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Teto de páginas, para não girar sem fim se o IXC devolver paginação estranha. */
  maxPages?: number;
  pageSize?: number;
}

export class IxcSystemUsersError extends Error {
  constructor(code: string) { super(code); this.name = "IxcSystemUsersError"; }
}

function toSystemUser(row: Record<string, unknown>): IxcSystemUser | undefined {
  const email = String(row.email ?? "").trim().toLowerCase();
  const ixcId = String(row.id ?? "").trim();
  // Sem e-mail não há como casar a conta nem fazer login: o registro é ignorado.
  if (!email || !ixcId || !email.includes("@")) return undefined;
  return {
    ixcId,
    name: String(row.nome ?? "").trim() || email,
    email,
    groupId: String(row.id_grupo ?? "").trim(),
    active: String(row.status ?? "").trim().toUpperCase() === "A",
  };
}

export async function fetchIxcSystemUsers(options: IxcSystemUsersOptions): Promise<IxcSystemUser[]> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 20;
  const url = `${options.baseUrl.replace(/\/$/, "")}/webservice/v1/usuarios`;

  const collected: IxcSystemUser[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= maxPages; page += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let body: { total?: unknown; registros?: unknown };
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicCredential(options.token)}`,
          "Content-Type": "application/json",
          ixcsoft: "listar",
        },
        body: JSON.stringify({
          qtype: "usuarios.id", query: "", oper: ">",
          page: String(page), rp: String(pageSize),
          sortname: "usuarios.id", sortorder: "asc",
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new IxcSystemUsersError(`IXC_HTTP_${response.status}`);
      body = await response.json() as { total?: unknown; registros?: unknown };
    } catch (error) {
      if (error instanceof IxcSystemUsersError) throw error;
      throw new IxcSystemUsersError(error instanceof Error && error.name === "AbortError" ? "IXC_TIMEOUT" : "IXC_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }

    const rows = Array.isArray(body.registros) ? body.registros : [];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const user = toSystemUser(row as Record<string, unknown>);
      if (user && !seen.has(user.email)) { seen.add(user.email); collected.push(user); }
    }

    const total = Number(body.total ?? 0);
    if (rows.length < pageSize || (total > 0 && page * pageSize >= total)) break;
  }

  return collected;
}
