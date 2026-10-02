"use client";

import { FormEvent, useState } from "react";
import { createSupabaseBrowserClient } from "@/infrastructure/auth/supabase-browser.client";

export function LoginForm({
  initialError = "",
  onError,
}: {
  initialError?: string;
  onError: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    onError("");
    try {
      const { error } = await createSupabaseBrowserClient().auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        const message = "No se pudo iniciar sesión. Verifica tus credenciales.";
        setError(message);
        onError(message);
      }
    } catch {
      const message = "No se pudo iniciar sesión. Inténtalo de nuevo.";
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell auth-shell">
      <section className="panel auth-panel">
        <p className="eyebrow">HOUSEMATE AI</p>
        <h1>Iniciar sesión</h1>
        <p className="muted">Accede a las finanzas de tu hogar.</p>
        {error && <p className="alert" role="alert">{error}</p>}
        <form className="form" onSubmit={submit}>
          <label>
            Correo electrónico
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Contraseña
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
            />
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Iniciando…" : "Iniciar sesión"}
          </button>
        </form>
      </section>
    </main>
  );
}
