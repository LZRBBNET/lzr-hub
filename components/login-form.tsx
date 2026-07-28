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

  return <main className="content">
    <div className="page-heading"><div><h1>Entrar no LZR HUB</h1><p>Acesso restrito à equipe do provedor.</p></div></div>
    <section className="data-card" style={{ maxWidth: 420 }}>
      <form onSubmit={submit}>
        <label htmlFor="login-email">E-mail</label>
        <input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
        <label htmlFor="login-password">Senha</label>
        <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        {error && <p className="protected-banner"><strong>Falha:</strong> {error}</p>}
        <button className="button" type="submit" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
      </form>
    </section>
  </main>;
}
