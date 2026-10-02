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
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [confirmationPending, setConfirmationPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    onError("");
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = mode === "signup"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        const message = mode === "signup"
          ? "No se pudo crear la cuenta. Revisa los datos e inténtalo de nuevo."
          : "No se pudo iniciar sesión. Verifica tus credenciales.";
        setError(message);
        onError(message);
      } else if (mode === "signup" && !data.session) {
        setConfirmationPending(true);
      }
    } catch {
      const message = "No se pudo iniciar sesión. Inténtalo de nuevo.";
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  if (confirmationPending) {
    return (
      <main className="shell auth-shell">
        <section className="panel auth-panel">
          <p className="eyebrow">HOUSEMATE AI</p>
          <h1>Confirma tu correo</h1>
          <p className="muted">
            Cuenta creada. Revisa tu correo electrónico para confirmar tu cuenta y luego inicia sesión.
          </p>
          <button
            className="primary"
            type="button"
            onClick={() => {
              setConfirmationPending(false);
              setMode("login");
              setError("");
              onError("");
            }}
          >
            Volver a iniciar sesión
          </button>
        </section>
      </main>
    );
  }

  async function continueWithGoogle() {
    setBusy(true);
    setError("");
    onError("");
    try {
      const { error } = await createSupabaseBrowserClient().auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) {
        const message = "No se pudo iniciar sesión con Google. Inténtalo de nuevo.";
        setError(message);
        onError(message);
        setBusy(false);
      }
    } catch {
      const message = "No se pudo iniciar sesión con Google. Inténtalo de nuevo.";
      setError(message);
      onError(message);
      setBusy(false);
    }
  }

  return (
    <main className="shell auth-shell">
      <section className="panel auth-panel">
        <p className="eyebrow">HOUSEMATE AI</p>
        <h1>{mode === "signup" ? "Crear cuenta" : "Iniciar sesión"}</h1>
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
            {busy
              ? mode === "signup" ? "Creando…" : "Iniciando…"
              : mode === "signup" ? "Crear cuenta" : "Iniciar sesión"}
          </button>
          {mode === "login" && (
            <button
              className="primary"
              type="button"
              onClick={() => void continueWithGoogle()}
              disabled={busy}
            >
              Continuar con Google
            </button>
          )}
          <button
            className="refresh"
            type="button"
            disabled={busy}
            onClick={() => {
              setMode((current) => current === "login" ? "signup" : "login");
              setError("");
              onError("");
            }}
          >
            {mode === "signup" ? "Ya tengo una cuenta" : "Crear una cuenta"}
          </button>
        </form>
      </section>
    </main>
  );
}
