"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/infrastructure/auth/supabase-browser.client";
import { LoginForm } from "@/components/auth/login-form";
import { createHouseholdRequest, type CreatedHousehold } from "@/components/household/household-client";

type Household = { householdId: string; householdName: string; selected?: boolean };
type Member = { membershipId: string; displayName: string; role: "OWNER" | "MEMBER"; status: "ACTIVE" | "LEFT" | "REMOVED"; isCurrentUser?: boolean };
type PendingAction = { kind: "transfer" | "remove" | "leave"; member?: Member };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? "No fue posible completar la operación."), { status: response.status, code: body?.error?.code });
  return body.data as T;
}

export function HouseholdPage() {
  const router = useRouter();
  const [sessionReady, setSessionReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [households, setHouseholds] = useState<Household[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [inviteGeneratedOpen, setInviteGeneratedOpen] = useState(false);
  const transferIdempotencyKey = useRef<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const preparedAuthUserId = useRef<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

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
    if (!modalOpen && !inviteGeneratedOpen && !pendingAction) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { setModalOpen(false); setInviteGeneratedOpen(false); setPendingAction(null); } };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalOpen, inviteGeneratedOpen, pendingAction, busy]);

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
      setInviteUrl(result.inviteUrl); setInviteEmail(""); setCopyFeedback(""); setInviteGeneratedOpen(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No fue posible crear la invitación."); }
    finally { setBusy(false); }
  }

  async function copyInviteLink(): Promise<void> {
    if (!inviteUrl) return;
    try { await navigator.clipboard.writeText(inviteUrl); setCopyFeedback("Link copied"); }
    catch { setCopyFeedback("No fue posible copiar el enlace."); }
    window.setTimeout(() => setCopyFeedback(""), 3000);
  }

  async function confirmPendingAction(): Promise<void> {
    if (!pendingAction || busy || !current) return;
    const action = pendingAction;
    setBusy(true); setError("");
    try {
      const path = action.kind === "transfer"
        ? `/api/auth/households/${current.householdId}/transfer-owner`
        : action.kind === "remove"
          ? `/api/auth/households/${current.householdId}/members/${action.member?.membershipId}`
          : `/api/auth/households/${current.householdId}/leave`;
      const method = action.kind === "remove" ? "DELETE" : "POST";
      const transferKey = action.kind === "transfer" ? (transferIdempotencyKey.current ??= crypto.randomUUID()) : undefined;
      await request(path, { method, ...(action.kind === "transfer" ? { body: JSON.stringify({ targetMemberId: action.member?.membershipId }), headers: { "Idempotency-Key": transferKey! } } : {}) });
      if (action.kind === "transfer") transferIdempotencyKey.current = null;
      setPendingAction(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible completar la operación.");
    } finally { setBusy(false); }
  }

  if (!sessionReady) return <main className="shell"><p className="loading" role="status">Cargando…</p></main>;
  if (!authenticated) return <LoginForm onError={setError} />;
  const current = households.find((item) => item.selected) ?? (households.length === 1 ? households[0] : undefined);
  const currentHouseholdId = current?.householdId;
  const currentMember = members.find((member) => member.isCurrentUser);
  const currentIsOwner = currentMember?.role === "OWNER" && currentMember.status === "ACTIVE";
  const currentIsMember = currentMember?.role === "MEMBER" && currentMember.status === "ACTIVE";
  return (
    <main className="shell household-shell">
      <button className="refresh household-back" type="button" onClick={() => {
        const returnTo = window.sessionStorage.getItem("housemate.household.returnTo");
        window.sessionStorage.removeItem("housemate.household.returnTo");
        const validReturnTo = returnTo === "dashboard" || returnTo === "expenses" || returnTo === "incomes" || returnTo === "balance" || returnTo === "agent";
        router.push(validReturnTo ? `/?section=${returnTo}` : "/");
      }} aria-label="Volver a la vista anterior">← Volver</button>
      <header className="household-header">
        <div><p className="eyebrow">HOUSEMATE AI</p><h1 id="household-title">Household</h1><p className="muted">Administra tus hogares y sus integrantes.</p></div>
        <button className="primary" type="button" onClick={() => { setError(""); setModalOpen(true); }} disabled={busy}>+ Crear household</button>
      </header>
      {error && <p className="alert" role="alert">{error}</p>}
      {loading ? <p className="loading" role="status">Cargando tus hogares…</p> : <>
        <section className="household-current-card" aria-labelledby="current-household-title">
          <div><p className="eyebrow">HOUSEHOLD ACTUAL</p><h2 id="current-household-title">{current?.householdName ?? "Sin household seleccionado"}</h2><p className="muted">{currentMember ? `${currentMember.role === "OWNER" ? "Owner" : "Member"}${currentMember.isCurrentUser ? " · You" : ""}` : "Selecciona un household para continuar"}</p></div>
          <span className="status-pill">{current ? "Activo" : "Pendiente"}</span>
        </section>
        <section className="household-section" aria-labelledby="my-households-title">
          <div className="section-heading"><div><p className="eyebrow">SELECCIÓN</p><h2 id="my-households-title">Mis households</h2></div><span className="section-count">{households.length}</span></div>
          <div className="household-options">
            {households.map((item) => <button key={item.householdId} className={`household-option${item.selected ? " is-selected" : ""}`} type="button" disabled={busy || item.selected} aria-current={item.selected ? "true" : undefined} onClick={() => void select(item.householdId)}><span><strong>{item.householdName}</strong><small>{item.selected ? "Activo" : "Seleccionar household"}</small></span><span aria-hidden="true">{item.selected ? "✓" : "→"}</span></button>)}
          </div>
        </section>
        <section className="household-section" aria-labelledby="members-title">
          <div className="section-heading"><div><p className="eyebrow">PARTICIPANTES</p><h2 id="members-title">Miembros</h2></div><span className="section-count">{members.length}</span></div>
          <div className="members-list">
            {members.length === 0 ? <p className="empty-state">No hay integrantes activos.</p> : members.map((member) => <div className="member-row" key={member.membershipId}><div className="member-identity"><span><strong>{member.displayName}</strong><small><span className={`role-badge ${member.role === "OWNER" ? "owner" : "member"}`}>{member.role === "OWNER" ? "Owner" : "Member"}</span>{member.isCurrentUser && <span className="you-badge">You</span>}</small></span></div>{currentIsOwner && member.role === "MEMBER" && currentHouseholdId && <span className="member-actions"><button className="icon-button" type="button" aria-label={`Transfer ownership to ${member.displayName}`} data-tooltip="Transfer ownership" disabled={busy} onClick={() => setPendingAction({ kind: "transfer", member })}>⇄</button><button className="icon-button danger" type="button" aria-label={`Remove ${member.displayName}`} data-tooltip="Remove member" disabled={busy} onClick={() => setPendingAction({ kind: "remove", member })}>−</button></span>}{currentIsMember && member.isCurrentUser && currentHouseholdId && <button className="icon-button" type="button" aria-label="Leave household" data-tooltip="Leave household" disabled={busy} onClick={() => setPendingAction({ kind: "leave" })}>↪</button>}</div>)}
          </div>
        </section>
        <section className="household-section invite-section" aria-labelledby="invite-title"><div><p className="eyebrow">INVITATIONS</p><h2 id="invite-title">Invite a member</h2><p className="muted">Enter the email address of the person you want to invite.</p></div><div className="invite-form"><label>Email<input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} disabled={busy} placeholder="email@example.com" /></label><button className="refresh" type="button" onClick={() => void invite()} disabled={busy || !current || !inviteEmail.trim()}>{busy ? "Generating…" : "Generate invitation"}</button></div></section>
      </>}
      {modalOpen && <div className="modal-backdrop" role="presentation"><section className="panel" role="dialog" aria-modal="true" aria-labelledby="create-household-title"><h2 id="create-household-title">Crear household</h2><p className="muted">Crea un nuevo hogar para organizar tus gastos.</p><label>Nombre<input autoFocus value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /></label><div className="form"><button className="refresh" type="button" onClick={() => setModalOpen(false)} disabled={busy}>Cancelar</button><button className="primary" type="button" onClick={() => void create()} disabled={busy}>{busy ? "Creando…" : "Crear"}</button></div></section></div>}
      {inviteGeneratedOpen && <div className="modal-backdrop" role="presentation"><section className="panel invite-modal" role="dialog" aria-modal="true" aria-labelledby="invite-generated-title" aria-describedby="invite-generated-description"><h2 id="invite-generated-title">Invitation created</h2><p id="invite-generated-description" className="muted">Comparte este enlace con el nuevo miembro.</p><p className="invite-link" role="status">{inviteUrl}</p><div className="form"><button className="refresh" type="button" onClick={() => void copyInviteLink()} disabled={busy}>Copy link</button><button className="refresh" type="button" onClick={() => { setInviteGeneratedOpen(false); setInviteUrl(""); }}>Close</button></div></section></div>}
      {copyFeedback && <p className={`floating-feedback ${copyFeedback === "Link copied" ? "success" : "error"}`} role="status">{copyFeedback}</p>}
      {pendingAction && <div className="modal-backdrop" role="presentation"><section className="panel" role="dialog" aria-modal="true" aria-labelledby="member-action-title" aria-describedby="member-action-description"><h2 id="member-action-title">Confirmar acción</h2><p id="member-action-description">{pendingAction.kind === "transfer" ? `Transferir ownership a ${pendingAction.member?.displayName}. Dejarás de ser owner.` : pendingAction.kind === "remove" ? `Remover a ${pendingAction.member?.displayName} de este household.` : "Abandonar este household."}</p><div className="form"><button className="refresh" type="button" onClick={() => setPendingAction(null)} disabled={busy}>Cancelar</button><button autoFocus className="primary" type="button" onClick={() => void confirmPendingAction()} disabled={busy}>{busy ? "Procesando…" : "Confirmar"}</button></div></section></div>}
    </main>
  );
}
