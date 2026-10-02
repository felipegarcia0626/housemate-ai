"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/infrastructure/auth/supabase-browser.client";

export function RecoveryPasswordForm({
  recoveryReady,
  initialError = "",
}: {
  recoveryReady: boolean;
  initialError?: string;
}) {
  const [recoverySession, setRecoverySession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [success, setSuccess] = useState(false);

  async function clearRecoveryMarker(): Promise<void> {
    await fetch("/auth/recovery", { method: "DELETE" }).catch(() => undefined);
  }

  useEffect(() => {
    if (!recoveryReady) {
      void clearRecoveryMarker();
      return;
    }
    const supabase = createSupabaseBrowserClient();
    void supabase.auth.getSession().then(({ data }) => {
      const valid = Boolean(data.session);
      setRecoverySession(valid);
      if (!valid) void clearRecoveryMarker();
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setRecoverySession(Boolean(session));
    });
    return () => subscription.subscription.unsubscribe();
  }, [recoveryReady]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    if (!recoverySession) {
      setError("El enlace de recuperación ya no es válido. Solicita uno nuevo.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: updateError } = await createSupabaseBrowserClient().auth.updateUser({ password });
      if (updateError) {
        setError("No fue posible actualizar la contraseña. Solicita un nuevo enlace.");
      } else {
        setPassword("");
        setConfirmation("");
        try {
          const { error: signOutError } = await createSupabaseBrowserClient().auth.signOut();
          if (signOutError) throw signOutError;
          await clearRecoveryMarker();
          setSuccess(true);
          setRecoverySession(false);
        } catch {
          await clearRecoveryMarker();
          setRecoverySession(false);
          setError("La contraseña se actualizó, pero no se pudo cerrar la sesión. Cierra esta ventana e inicia sesión nuevamente.");
        }
      }
    } catch {
      setError("No fue posible actualizar la contraseña. Solicita un nuevo enlace.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell auth-shell">
      <section className="panel auth-panel">
        <p className="eyebrow">HOUSEMATE AI</p>
        <h1>Nueva contraseña</h1>
        {success ? (
          <>
            <p className="muted" role="status">Tu contraseña fue actualizada. Ya puedes iniciar sesión.</p>
            <Link className="refresh" href="/">Volver a iniciar sesión</Link>
          </>
        ) : !recoveryReady || !recoverySession ? (
          <>
            {error && <p className="alert" role="alert">{error}</p>}
            <p className="muted">El enlace de recuperación no es válido o ya expiró.</p>
            <Link className="refresh" href="/">Volver a iniciar sesión</Link>
          </>
        ) : (
          <form className="form" onSubmit={submit}>
            {error && <p className="alert" role="alert">{error}</p>}
            <label>
              Nueva contraseña
              <input type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
            </label>
            <label>
              Confirmar contraseña
              <input type="password" autoComplete="new-password" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} />
            </label>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Actualizando…" : "Actualizar contraseña"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
