"use client";
import { useState } from "react";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

        <form onSubmit={submit} noValidate>
          {error && <p className="login-error" role="alert"><i aria-hidden="true">⚠</i><span>{error}</span></p>}

          <label className="login-field" htmlFor="login-email">
            <span>E-mail</span>
            <input id="login-email" name="email" type="email" autoComplete="username" placeholder="voce@bbnet.com.br"
              required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>

          <label className="login-field" htmlFor="login-password">
            <span>Senha</span>
            <input id="login-password" name="password" type="password" autoComplete="current-password" placeholder="••••••••"
              required value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>

          <button className="button login-submit" type="submit" disabled={busy}>
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>

        <p className="login-note">
          Esqueceu a senha ou precisa de acesso? Fale com um administrador — as contas são criadas internamente.
        </p>
      </section>
    </main>
  </div>;
}
