"use client";

import { FormEvent, useState } from "react";
import { createSupabaseBrowserClient } from "@/infrastructure/auth/supabase-browser.client";

const recoveryRedirect = () => `${window.location.origin}/auth/recovery`;

export function PasswordRecoveryForm({
  initialEmail = "",
  onBack,
}: {
  initialEmail?: string;
  onBack: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim()) {
      setError("Escribe tu correo electrónico.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: requestError } = await createSupabaseBrowserClient().auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: recoveryRedirect() },
      );
      if (requestError) {
        setError("No fue posible procesar la solicitud. Inténtalo de nuevo.");
      } else {
        setSent(true);
      }
    } catch {
      setError("No fue posible procesar la solicitud. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell auth-shell">
      <section className="panel auth-panel">
        <p className="eyebrow">HOUSEMATE AI</p>
        <h1>Recuperar contraseña</h1>
        {sent ? (
          <>
            <p className="muted" role="status">
              Si existe una cuenta asociada a ese correo, recibirás instrucciones para restablecer tu contraseña.
            </p>
            <button className="refresh" type="button" onClick={onBack}>
              Volver a iniciar sesión
            </button>
          </>
        ) : (
          <form className="form" onSubmit={submit}>
            {error && <p className="alert" role="alert">{error}</p>}
            <p className="muted">Indica tu correo y te enviaremos instrucciones para restablecerla.</p>
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
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Enviando…" : "Enviar instrucciones"}
            </button>
            <button className="refresh" type="button" onClick={onBack} disabled={busy}>
              Volver a iniciar sesión
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
