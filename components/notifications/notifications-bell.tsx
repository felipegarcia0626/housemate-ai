"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useRouter } from "next/navigation";

type NotificationItem = {
  id: string;
  householdId: string;
  type: string;
  title: string;
  body: string;
  metadata: unknown;
  sourceEntityType: string;
  sourceEntityId: string;
  createdAt: string;
  readAt: string | null;
  actionState?: "PENDING" | "ACCEPTED" | "EXPIRED" | "UNAVAILABLE";
};

type NotificationsResponse = {
  notifications: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
};

type ApiError = Error & { status?: number };
type NotificationFilter = "all" | "unread";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) } });
  const body = (await response.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? "No fue posible completar la operación.") as ApiError;
    error.status = response.status;
    throw error;
  }
  return body?.data as T;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short" }).format(date);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isActionableNotification(notification: NotificationItem): boolean {
  if (!UUID.test(notification.sourceEntityId)) return false;
  return (
    (notification.type === "HOUSEHOLD_INVITATION_ACCEPTED" && notification.sourceEntityType === "HOUSEHOLD_INVITATION") ||
    (notification.type === "HOUSEHOLD_MEMBER_LEFT" && notification.sourceEntityType === "HOUSEHOLD_MEMBER") ||
    (notification.type === "HOUSEHOLD_OWNERSHIP_TRANSFERRED" && notification.sourceEntityType === "HOUSEHOLD")
  );
}

function isInvitationReceived(notification: NotificationItem): boolean {
  return notification.type === "HOUSEHOLD_INVITATION_RECEIVED" && notification.sourceEntityType === "HOUSEHOLD_INVITATION" && UUID.test(notification.sourceEntityId);
}

export function NotificationsBell({ userId }: { userId?: string | null }): ReactElement | null {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [busyNotificationIds, setBusyNotificationIds] = useState<Set<string>>(new Set());
  const [markAllBusy, setMarkAllBusy] = useState(false);
  const [notificationFilter, setNotificationFilter] = useState<NotificationFilter>("all");
  const [acceptBusyIds, setAcceptBusyIds] = useState<Set<string>>(new Set());
  const [acceptStatus, setAcceptStatus] = useState<Record<string, "accepted" | "unavailable" | "error">>({});
  const [retryNonce, setRetryNonce] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const loadedUserId = useRef<string | null>(null);
  const loadedFilter = useRef<NotificationFilter>("all");
  const currentUserId = useRef<string | null>(userId ?? null);
  const loadingRequest = useRef(false);
  const wasOpen = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = "notifications-panel";

  function changeFilter(nextFilter: NotificationFilter): void {
    if (nextFilter === notificationFilter) return;
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    loadingRequest.current = false;
    loadedUserId.current = null;
    setNotifications([]);
    setNextCursor(null);
    setError("");
    setNotificationFilter(nextFilter);
  }

  const loadNotifications = useCallback(async (requestUserId: string, filter: NotificationFilter = notificationFilter): Promise<void> => {
    if (loadingRequest.current) return;
    loadingRequest.current = true;
    generation.current += 1;
    controller.current?.abort();
    const requestGeneration = generation.current;
    const requestController = new AbortController();
    controller.current = requestController;
    setLoading(true);
    setError("");
    try {
      const result = await request<NotificationsResponse>(`/api/notifications?limit=20&unreadOnly=${filter === "unread"}`, { signal: requestController.signal });
      if (requestController.signal.aborted || requestGeneration !== generation.current || currentUserId.current !== requestUserId) return;
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
      setNextCursor(result.nextCursor);
      loadedUserId.current = requestUserId;
      loadedFilter.current = filter;
    } catch (cause: unknown) {
      if (requestController.signal.aborted || requestGeneration !== generation.current || currentUserId.current !== requestUserId) return;
      setError(cause instanceof Error ? cause.message : "No fue posible cargar las notificaciones.");
      loadedUserId.current = null;
      loadedFilter.current = filter;
    } finally {
      if (controller.current === requestController) controller.current = null;
      loadingRequest.current = false;
      if (!requestController.signal.aborted && requestGeneration === generation.current) setLoading(false);
    }
  }, [notificationFilter]);

  useEffect(() => {
    currentUserId.current = userId ?? null;
    if (!userId) {
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
      loadingRequest.current = false;
      loadedUserId.current = null;
      loadedFilter.current = "all";
      return;
    }
    if (loadedUserId.current === userId && loadedFilter.current === notificationFilter) return;
    controller.current?.abort();
    loadingRequest.current = false;
    void loadNotifications(userId, notificationFilter);
    return () => {
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
      loadingRequest.current = false;
    };
  }, [loadNotifications, userId, retryNonce, notificationFilter]);

  useEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    if (opened && userId) void loadNotifications(userId, notificationFilter);
  }, [loadNotifications, open, userId, notificationFilter]);

  useEffect(() => () => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    loadingRequest.current = false;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onPointerDown = (event: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => { document.removeEventListener("keydown", onKeyDown); document.removeEventListener("pointerdown", onPointerDown); };
  }, [open]);

  async function loadMore(): Promise<void> {
    if (!userId || !nextCursor || loadingMore) return;
    const requestGeneration = generation.current;
    const cursor = nextCursor;
    setLoadingMore(true);
    setError("");
    try {
      const result = await request<NotificationsResponse>(`/api/notifications?limit=20&cursor=${encodeURIComponent(cursor)}&unreadOnly=${notificationFilter === "unread"}`);
      if (requestGeneration !== generation.current || userId !== loadedUserId.current) return;
      setNotifications((current) => {
        const ids = new Set(current.map((item) => item.id));
        return [...current, ...result.notifications.filter((item) => !ids.has(item.id))];
      });
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (requestGeneration === generation.current) setError(cause instanceof Error ? cause.message : "No fue posible cargar más notificaciones.");
    } finally {
      if (requestGeneration === generation.current) setLoadingMore(false);
    }
  }

  async function markRead(notification: NotificationItem): Promise<void> {
    if (notification.readAt || busyNotificationIds.has(notification.id) || !userId) return;
    setBusyNotificationIds((current) => new Set(current).add(notification.id));
    setError("");
    try {
      const result = await request<{ id: string; readAt: string | null }>(`/api/notifications/${notification.id}/read`, { method: "POST", body: "" });
      setNotifications((current) => notificationFilter === "unread" ? current.filter((item) => item.id !== notification.id) : current.map((item) => item.id === notification.id ? { ...item, readAt: result.readAt ?? new Date().toISOString() } : item));
      setUnreadCount((current) => Math.max(0, current - 1));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible marcar la notificación.");
    } finally {
      setBusyNotificationIds((current) => { const next = new Set(current); next.delete(notification.id); return next; });
    }
  }

  async function markAllRead(): Promise<void> {
    if (markAllBusy || unreadCount === 0 || !userId) return;
    setMarkAllBusy(true);
    setError("");
    try {
      await request<{ updatedCount: number }>("/api/notifications/read-all", { method: "POST", body: "" });
      const now = new Date().toISOString();
      setNotifications((current) => notificationFilter === "unread" ? [] : current.map((item) => item.readAt ? item : { ...item, readAt: now }));
      setUnreadCount(0);
      if (notificationFilter === "unread") setNextCursor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible marcar todas las notificaciones.");
    } finally { setMarkAllBusy(false); }
  }

  function openNotification(notification: NotificationItem): void {
    if (!isActionableNotification(notification)) return;
    if (!notification.readAt) void markRead(notification);
    router.push("/household");
  }

  async function acceptInvitation(notification: NotificationItem): Promise<void> {
    if (!isInvitationReceived(notification) || notification.actionState !== "PENDING" || acceptBusyIds.has(notification.id) || acceptStatus[notification.id] === "accepted" || acceptStatus[notification.id] === "unavailable") return;
    setAcceptBusyIds((current) => new Set(current).add(notification.id));
    try {
      await request(`/api/auth/households/invitations/${notification.sourceEntityId}/accept`, { method: "POST", body: "" });
      await markRead(notification);
      setAcceptStatus((current) => ({ ...current, [notification.id]: "accepted" }));
    } catch (cause) {
      if (cause && typeof cause === "object" && "status" in cause && (cause as ApiError).status === 409) {
        await markRead(notification);
        setAcceptStatus((current) => ({ ...current, [notification.id]: "unavailable" }));
      } else {
        setError(cause instanceof Error ? cause.message : "No fue posible aceptar la invitación.");
        setAcceptStatus((current) => ({ ...current, [notification.id]: "error" }));
      }
    } finally {
      setAcceptBusyIds((current) => { const next = new Set(current); next.delete(notification.id); return next; });
    }
  }

  if (!userId) return null;
  return (
    <div className="notifications-bell" ref={rootRef}>
      <button className="refresh notifications-trigger" type="button" aria-label="Notificaciones" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((current) => !current)}>
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && <span className="notifications-badge" aria-label={`${unreadCount} sin leer`}>{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
      {open && (
        <section className="notifications-panel" id={panelId} aria-label="Notificaciones" role="region">
          <div className="notifications-panel-header"><h2>Notifications</h2><button type="button" className={`notifications-mark-all${markAllBusy ? " is-busy" : ""}`} onClick={() => void markAllRead()} disabled={markAllBusy || unreadCount === 0}>{markAllBusy ? "Marcando…" : "Marcar todas como leídas"}</button></div>
          <div className="notifications-filter" role="group" aria-label="Filtrar notificaciones"><button type="button" className={notificationFilter === "all" ? "is-selected" : ""} aria-pressed={notificationFilter === "all"} onClick={() => changeFilter("all")}>Todas</button><button type="button" className={notificationFilter === "unread" ? "is-selected" : ""} aria-pressed={notificationFilter === "unread"} onClick={() => changeFilter("unread")}>No leídas</button></div>
          {loading && <p className="loading" role="status">Cargando notificaciones…</p>}
          {error && <div className="notifications-error" role="alert"><span>{error}</span><button type="button" onClick={() => { loadedUserId.current = null; setError(""); setRetryNonce((current) => current + 1); }}>Reintentar</button></div>}
          {!loading && !error && notifications.length === 0 && <p className="empty-state">{notificationFilter === "unread" ? "No tienes notificaciones sin leer." : "No tienes notificaciones."}</p>}
          {!loading && notifications.length > 0 && <div className="notifications-list">{notifications.map((notification) => {
            if (isInvitationReceived(notification)) {
              const status = acceptStatus[notification.id];
              const actionState = notification.actionState ?? "UNAVAILABLE";
              const accepted = actionState === "ACCEPTED" || status === "accepted";
              const unavailable = actionState === "EXPIRED" || actionState === "UNAVAILABLE" || status === "unavailable";
              return <div className={`notification-item${notification.readAt ? "" : " is-unread"}`} key={notification.id}><span className="notification-item-content"><strong>{notification.title}</strong><span>{notification.body}</span><small>{formatDate(notification.createdAt)}</small>{accepted ? <span className="notification-action-status is-complete" role="status">Aceptada</span> : unavailable ? <span className="notification-action-status">No disponible</span> : <button className="notification-action" type="button" onClick={() => void acceptInvitation(notification)} disabled={acceptBusyIds.has(notification.id)}>{acceptBusyIds.has(notification.id) ? "Aceptando…" : status === "error" ? "Reintentar" : "Aceptar invitación"}</button>}</span>{!notification.readAt && <span className="notification-unread-indicator" aria-hidden="true" />}</div>;
            }
            const actionable = isActionableNotification(notification);
            return <button className={`notification-item${notification.readAt ? "" : " is-unread"}${actionable ? " is-actionable" : ""}`} key={notification.id} type="button" onClick={() => actionable ? openNotification(notification) : void markRead(notification)} disabled={busyNotificationIds.has(notification.id)} aria-label={`${notification.readAt ? "Leída" : "No leída"}${actionable ? ", abrir Household" : ""}: ${notification.title}`}><span className="notification-item-content"><strong>{notification.title}</strong><span>{notification.body}</span><small>{formatDate(notification.createdAt)}</small></span>{!notification.readAt && <span className="notification-unread-indicator" aria-hidden="true" />}</button>;
          })}</div>}
          {nextCursor && !loading && <button className="notifications-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Cargando…" : "Ver más"}</button>}
        </section>
      )}
    </div>
  );
}
