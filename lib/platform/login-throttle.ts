/**
 * Freio de tentativas de login.
 *
 * Sem isso, força bruta contra a lista de e-mails da BBNET não encontra
 * resistência nenhuma: o atacante testa senha atrás de senha no mesmo endereço
 * até acertar.
 *
 * Duas chaves, de propósito:
 *  - **por e-mail**, curta, para proteger uma conta específica de ataque dirigido;
 *  - **por IP**, mais larga, para conter varredura em muitas contas de uma vez —
 *    o limite por e-mail sozinho não pega quem tenta uma senha em mil endereços.
 *
 * É memória do processo. Com mais de uma instância, cada uma conta a sua parte,
 * então o limite efetivo é o dobro/triplo — ainda muito melhor que nenhum. O
 * dia em que houver várias instâncias, isto migra para Redis (a mesma peça que
 * as filas já usam).
 */
export interface ThrottleRule { max: number; windowMs: number }

export const EMAIL_RULE: ThrottleRule = { max: 5, windowMs: 15 * 60 * 1000 };
export const IP_RULE: ThrottleRule = { max: 30, windowMs: 15 * 60 * 1000 };

export class LoginThrottle {
  private readonly attempts = new Map<string, number[]>();
  private readonly now: () => number;
  constructor(now: () => number = () => Date.now()) { this.now = now; }

  private recent(key: string, windowMs: number) {
    const cutoff = this.now() - windowMs;
    const kept = (this.attempts.get(key) ?? []).filter((time) => time > cutoff);
    if (kept.length === 0) this.attempts.delete(key); else this.attempts.set(key, kept);
    return kept;
  }

  /** Segundos a esperar, ou 0 se pode tentar. Não registra nada: só consulta. */
  retryAfterSeconds(email: string, ip: string): number {
    const checks: Array<[string, ThrottleRule]> = [[`email:${email.trim().toLowerCase()}`, EMAIL_RULE], [`ip:${ip}`, IP_RULE]];
    let wait = 0;
    for (const [key, rule] of checks) {
      const times = this.recent(key, rule.windowMs);
      if (times.length < rule.max) continue;
      // A liberação vem quando a tentativa mais antiga da janela sair dela.
      const releaseAt = times[times.length - rule.max] + rule.windowMs;
      wait = Math.max(wait, Math.ceil((releaseAt - this.now()) / 1000));
    }
    return Math.max(wait, 0);
  }

  /** Só a falha conta. Login certo não deve gastar a cota de ninguém. */
  recordFailure(email: string, ip: string) {
    for (const key of [`email:${email.trim().toLowerCase()}`, `ip:${ip}`]) {
      this.attempts.set(key, [...(this.attempts.get(key) ?? []), this.now()]);
    }
  }

  /** Entrou: a conta volta a ter a cota cheia, para não ficar travada por engano do próprio dono. */
  clear(email: string) { this.attempts.delete(`email:${email.trim().toLowerCase()}`); }

  get size() { return this.attempts.size; }
}

/** Uma instância por processo — o freio precisa ser lembrado entre requisições. */
export const loginThrottle = new LoginThrottle();

/**
 * IP de origem. Atrás do proxy do Railway o socket é sempre interno, então o
 * valor útil vem do cabeçalho. Sem cabeçalho, cai num balde único: pior que
 * separar por IP, melhor que não limitar.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "desconhecido";
}
