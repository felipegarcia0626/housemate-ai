"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/infrastructure/auth/supabase-browser.client";
import { LoginForm } from "@/components/auth/login-form";
import { createHouseholdRequest, type CreatedHousehold } from "@/components/household/household-client";

type Household = { householdId: string; householdName: string; selected?: boolean };
type Member = { membershipId: string; displayName: string; role: "OWNER" | "MEMBER"; status: "ACTIVE" | "LEFT" | "REMOVED"; isCurrentUser?: boolean };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? "No fue posible completar la operación."), { status: response.status, code: body?.error?.code });
  return body.data as T;
}

export function HouseholdPage() {
  const [sessionReady, setSessionReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [households, setHouseholds] = useState<Household[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const preparedAuthUserId = useRef<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true); setError("");
    try {
      const options = await request<Household[]>("/api/auth/households");
      setHouseholds(options);
      const selected = options.find((item) => item.selected) ?? (options.length === 1 ? options[0] : undefined);
      setMembers(selected ? await request<Member[]>(`/api/auth/households/${selected.householdId}/members`) : []);
    }
    catch (cause) {
      const status = cause && typeof cause === "object" && "status" in cause ? (cause as { status?: number }).status : 500;
      setError(status === 403 ? "Tu cuenta todavía no está vinculada a un hogar." : "No fue posible cargar tus hogares.");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const applySession = (session: { user?: { id?: string } } | null) => {
      const authUserId = session?.user?.id ?? null;
      setSessionReady(true);
      if (!authUserId) {
        preparedAuthUserId.current = null;
        setAuthenticated(false);
        setLoading(false);
        return;
      }
      setAuthenticated(true);
      if (preparedAuthUserId.current === authUserId) return;
      preparedAuthUserId.current = authUserId;
      void load();
    };
    void supabase.auth.getSession().then(({ data }) => {
      applySession(data.session);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => applySession(nextSession));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) setModalOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalOpen, busy]);

  async function select(householdId: string): Promise<void> {
    setBusy(true); setError("");
    try { await request("/api/auth/household-selection", { method: "POST", body: JSON.stringify({ householdId }) }); await load(); }
    catch { setError("No fue posible seleccionar ese hogar."); }
    finally { setBusy(false); }
  }

  async function create(): Promise<void> {
    if (!name.trim()) { setError("Ingresa el nombre del hogar."); return; }
    setBusy(true); setError("");
    try {
      const created = await createHouseholdRequest(name);
      const options = await request<Household[]>("/api/auth/households");
      setHouseholds(options);
      await request("/api/auth/household-selection", { method: "POST", body: JSON.stringify({ householdId: created.householdId }) });
      await load(); setName(""); setModalOpen(false);
    } catch { setError("No fue posible crear el hogar. Inténtalo de nuevo."); }
    finally { setBusy(false); }
  }

  async function invite(): Promise<void> {
    if (!inviteEmail.trim() || !current) { setError("Selecciona un household e ingresa un correo."); return; }
    setBusy(true); setError(""); setInviteUrl("");
    try {
      const result = await request<{ status: string; inviteUrl: string }>(`/api/auth/households/${current.householdId}/invitations`, { method: "POST", body: JSON.stringify({ email: inviteEmail }) });
      setInviteUrl(result.inviteUrl); setInviteEmail("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No fue posible crear la invitación."); }
    finally { setBusy(false); }
  }

  async function lifecycle(path: string, method: "POST" | "DELETE", body?: object): Promise<void> {
    if (!current) return;
    setBusy(true); setError("");
    try { await request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No fue posible completar la operación."); }
    finally { setBusy(false); }
  }

  if (!sessionReady) return <main className="shell"><p className="loading" role="status">Cargando…</p></main>;
  if (!authenticated) return <LoginForm onError={setError} />;
  const current = households.find((item) => item.selected) ?? (households.length === 1 ? households[0] : undefined);
  const currentHouseholdId = current?.householdId;
  const currentMember = members.find((member) => member.isCurrentUser);
  const currentIsOwner = currentMember?.role === "OWNER" && currentMember.status === "ACTIVE";
  const currentIsMember = currentMember?.role === "MEMBER" && currentMember.status === "ACTIVE";
  return (
    <main className="shell">
      <section className="panel" aria-labelledby="household-title">
        <p className="eyebrow">HOUSEMATE AI</p>
        <h1 id="household-title">Household</h1>
        <p className="muted">Household actual</p>
        <p className="active-household">{current?.householdName ?? "Sin household seleccionado"}</p>
        <h2>Mis households</h2>
        {error && <p className="alert" role="alert">{error}</p>}
        {loading ? <p className="loading" role="status">Cargando tus hogares…</p> : (
          <div className="form">
            {households.map((item) => <button key={item.householdId} className={item.selected ? "primary" : "refresh"} type="button" disabled={busy || item.selected} onClick={() => void select(item.householdId)}>{item.householdName}{item.selected ? " (actual)" : ""}</button>)}
            <button className="refresh" type="button" onClick={() => { setError(""); setModalOpen(true); }} disabled={busy}>+ Crear household</button>
            <label>Invitar por email<input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} disabled={busy} placeholder="persona@example.com" /></label>
            <button className="primary" type="button" onClick={() => void invite()} disabled={busy || !current}>{busy ? "Generando…" : "Generar invitación"}</button>
            {inviteUrl && <p role="status">Enlace generado: <button className="refresh" type="button" onClick={() => void navigator.clipboard?.writeText(inviteUrl)}>Copiar enlace</button></p>}
            <h3>Integrantes</h3>
            {members.length === 0 ? <p className="muted">No hay integrantes activos.</p> : members.map((member) => <div className="member-row" key={member.membershipId}><span>{member.displayName} {member.role === "OWNER" ? "(owner)" : ""}</span>{currentIsOwner && member.role === "MEMBER" && member.status === "ACTIVE" && currentHouseholdId && <span className="form"><button className="refresh" type="button" disabled={busy} onClick={() => { if (window.confirm(`¿Transferir ownership a ${member.displayName}?`)) void lifecycle(`/api/auth/households/${currentHouseholdId}/transfer-owner`, "POST", { targetMemberId: member.membershipId }); }}>Transferir ownership</button><button className="refresh" type="button" disabled={busy} onClick={() => { if (window.confirm(`¿Remover a ${member.displayName}?`)) void lifecycle(`/api/auth/households/${currentHouseholdId}/members/${member.membershipId}`, "DELETE"); }}>Remover</button></span>}</div>)}
            {currentIsMember && currentHouseholdId && <button className="refresh" type="button" disabled={busy} onClick={() => { if (window.confirm("¿Salir de este household?")) void lifecycle(`/api/auth/households/${currentHouseholdId}/leave`, "POST"); }}>Salir del household</button>}
          </div>
        )}
      </section>
      {modalOpen && <div className="modal-backdrop" role="presentation"><section className="panel" role="dialog" aria-modal="true" aria-labelledby="create-household-title"><h2 id="create-household-title">Crear household</h2><label>Nombre<input autoFocus value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /></label><div className="form"><button className="refresh" type="button" onClick={() => setModalOpen(false)} disabled={busy}>Cancelar</button><button className="primary" type="button" onClick={() => void create()} disabled={busy}>{busy ? "Creando…" : "Crear"}</button></div></section></div>}
    </main>
  );
}
