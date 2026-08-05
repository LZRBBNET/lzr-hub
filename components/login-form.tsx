"use client";
import { useState } from "react";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  /**
   * Não existe envio de e-mail no projeto, então não há link de redefinição: o
   * pedido é registrado e quem administra resolve. A resposta é sempre a mesma,
   * com ou sem conta — o contrário transformaria isto num verificador de quais
   * endereços têm conta na BBNET.
   */
  function requestReset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    fetch("/api/auth/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, note }) })
      .then(async (response) => {
        const payload = await response.json() as { error?: string; detail?: string };
        if (!response.ok) throw new Error(payload.error ?? "Não foi possível registrar o pedido");
        setSent(payload.detail ?? "Pedido registrado.");
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Não foi possível registrar o pedido"))
      .finally(() => setBusy(false));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
      .then(async (response) => {
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Não foi possível entrar");
        window.location.href = "/";
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Não foi possível entrar");
        setBusy(false);
      });
  }

  return <div className="login-shell">
    <aside className="login-aside">
      <div className="login-brand">
        <div className="brand-mark">L</div>
        <div><strong>LZR HUB</strong><small>BBNET Intelligence</small></div>
      </div>

      <div className="login-pitch">
        <h2>Atendimento inteligente, do primeiro contato à resolução.</h2>
        <p>Central única de atendimento, cobrança e comercial — com IA que resolve o que pode e chama gente quando precisa.</p>
        <ul className="login-points">
          <li><i>✓</i> Atendimento N1 com IA 24 horas por dia</li>
          <li><i>✓</i> Visão 360° do cliente integrada ao IXC</li>
          <li><i>✓</i> Transbordo para humano com contexto completo</li>
          <li><i>✓</i> Cada ação registrada e auditável</li>
        </ul>
      </div>

      <p className="login-foot">Acesso restrito à equipe do provedor. Todas as ações são auditadas.</p>
    </aside>

    <main className="login-main">
      <section className="login-card">
        <h1>Entrar</h1>
        <p>Use as credenciais fornecidas pela administração.</p>

        <form onSubmit={forgot ? requestReset : submit} noValidate>
          {error && <p className="login-error" role="alert"><i aria-hidden="true">⚠</i><span>{error}</span></p>}
          {sent && <p className="login-note" role="status" style={{ background: "var(--blue-soft)", padding: 12, borderRadius: 10, marginBottom: 12 }}>{sent}</p>}

          <label className="login-field" htmlFor="login-email">
            <span>E-mail</span>
            <input id="login-email" name="email" type="email" autoComplete="username" placeholder="voce@bbnet.com.br"
              required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>

          {forgot
            ? <label className="login-field" htmlFor="login-note">
                <span>Recado para quem administra (opcional)</span>
                <input id="login-note" name="note" type="text" placeholder="Ex.: perdi a senha do primeiro acesso"
                  value={note} onChange={(event) => setNote(event.target.value)} />
              </label>
            : <label className="login-field" htmlFor="login-password">
                <span>Senha</span>
                <input id="login-password" name="password" type="password" autoComplete="current-password" placeholder="••••••••"
                  required value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>}

          <button className="button login-submit" type="submit" disabled={busy || !!sent}>
            {busy ? (forgot ? "Registrando…" : "Entrando…") : forgot ? "Registrar pedido" : "Entrar"}
          </button>
        </form>

        <p className="login-note">
          {forgot
            ? <>Não enviamos e-mail: o LZR HUB não tem esse canal. O pedido aparece para quem administra, que gera uma senha nova e entrega a você. <button type="button" className="link-button" onClick={() => { setForgot(false); setSent(null); setError(null); }}>Voltar ao login</button></>
            : <>Esqueceu a senha? <button type="button" className="link-button" onClick={() => { setForgot(true); setError(null); }}>Registrar um pedido</button>. Precisa de acesso? Fale com um administrador — as contas são criadas internamente.</>}
        </p>
      </section>
    </main>
  </div>;
}
