"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/infrastructure/auth/supabase-browser.client";
import { LoginForm } from "@/components/auth/login-form";

export default function HouseholdInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void params.then(({ token: nextToken }) => setToken(nextToken));
    const supabase = createSupabaseBrowserClient();
    const apply = (session: unknown) => { setAuthenticated(Boolean(session)); setReady(true); };
    void supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => apply(session));
    return () => listener.subscription.unsubscribe();
  }, [params]);

  async function accept(): Promise<void> {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/auth/households/invitations/${encodeURIComponent(token)}/accept`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? "No fue posible aceptar la invitación.");
      setMessage(body.data?.alreadyAccepted ? "La invitación ya estaba aceptada." : "Invitación aceptada correctamente.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No fue posible aceptar la invitación."); }
    finally { setBusy(false); }
  }

  if (!ready) return <main className="shell"><p className="loading" role="status">Cargando invitación…</p></main>;
  if (!authenticated) return <><meta name="referrer" content="no-referrer" /><LoginForm onError={setError} oauthRedirectTo={`${window.location.origin}/auth/callback?next=${encodeURIComponent(`/household/invitations/${token}`)}`} /></>;
  return <main className="shell"><meta name="referrer" content="no-referrer" /><section className="panel" aria-labelledby="invitation-title"><p className="eyebrow">HOUSEMATE AI</p><h1 id="invitation-title">Invitación a Household</h1>{error && <p className="alert" role="alert">{error}</p>}{message ? <p role="status">{message}</p> : <><p className="muted">Tienes una invitación pendiente. Puedes aceptarla con tu cuenta actual.</p><button className="primary" type="button" onClick={() => void accept()} disabled={busy || !token}>{busy ? "Aceptando…" : "Aceptar invitación"}</button></>}</section></main>;
}
