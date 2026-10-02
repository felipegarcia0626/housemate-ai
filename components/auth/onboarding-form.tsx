"use client";

import { FormEvent, useState } from "react";

export function OnboardingForm({
  onComplete,
  onLogout,
}: {
  onComplete: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!displayName.trim() || !householdName.trim()) {
      setError("Completa tu nombre y el nombre de tu hogar.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, householdName }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = body?.error?.code;
        if (response.status === 401 || code === "UNAUTHENTICATED") {
          await onLogout();
          return;
        }
        setError(
          response.status === 400
            ? "Revisa los datos ingresados."
            : "No fue posible completar el registro. Inténtalo de nuevo.",
        );
        return;
      }
      await onComplete();
    } catch {
      setError("No fue posible completar el registro. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell auth-shell">
      <section className="panel auth-panel" aria-labelledby="onboarding-title">
        <p className="eyebrow">HOUSEMATE AI</p>
        <h1 id="onboarding-title">Configura tu hogar</h1>
        <p className="muted">Completa estos datos para comenzar a usar HouseMate AI.</p>
        {error && <p className="alert" role="alert">{error}</p>}
        <form className="form" onSubmit={submit}>
          <label>
            Tu nombre
            <input
              type="text"
              autoComplete="name"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            Nombre del hogar
            <input
              type="text"
              required
              value={householdName}
              onChange={(event) => setHouseholdName(event.target.value)}
              disabled={busy}
            />
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Configurando…" : "Continuar"}
          </button>
          <button className="refresh" type="button" onClick={() => void onLogout()} disabled={busy}>
            Cerrar sesión
          </button>
        </form>
      </section>
    </main>
  );
}
