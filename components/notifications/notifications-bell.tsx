"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";

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
};

type NotificationsResponse = {
  notifications: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
};

type ApiError = Error & { status?: number };

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

export function NotificationsBell({ userId }: { userId?: string | null }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [busyNotificationIds, setBusyNotificationIds] = useState<Set<string>>(new Set());
  const [markAllBusy, setMarkAllBusy] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const loadedUserId = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = "notifications-panel";

  useEffect(() => {
    generation.current += 1;
    controller.current?.abort();
    controller.current = null;
    if (!userId || loadedUserId.current === userId) return;
    const requestGeneration = generation.current;
    const requestController = new AbortController();
    controller.current = requestController;
    setLoading(true);
    setError("");
    void request<NotificationsResponse>("/api/notifications?limit=20&unreadOnly=false", { signal: requestController.signal })
      .then((result) => {
        if (requestController.signal.aborted || requestGeneration !== generation.current || userId !== loadedUserId.current) return;
        setNotifications(result.notifications);
        setUnreadCount(result.unreadCount);
        setNextCursor(result.nextCursor);
        loadedUserId.current = userId;
      })
      .catch((cause: unknown) => {
        if (requestController.signal.aborted || requestGeneration !== generation.current) return;
        setError(cause instanceof Error ? cause.message : "No fue posible cargar las notificaciones.");
        loadedUserId.current = null;
      })
      .finally(() => {
        if (!requestController.signal.aborted && requestGeneration === generation.current) setLoading(false);
      });
    return () => {
      requestController.abort();
      controller.current = null;
    };
  }, [userId, retryNonce]);

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
      const result = await request<NotificationsResponse>(`/api/notifications?limit=20&cursor=${encodeURIComponent(cursor)}&unreadOnly=false`);
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
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt: result.readAt ?? new Date().toISOString() } : item));
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
      setNotifications((current) => current.map((item) => item.readAt ? item : { ...item, readAt: now }));
      setUnreadCount(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible marcar todas las notificaciones.");
    } finally { setMarkAllBusy(false); }
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
          <div className="notifications-panel-header"><h2>Notifications</h2><button type="button" className="notifications-mark-all" onClick={() => void markAllRead()} disabled={markAllBusy || unreadCount === 0}>{markAllBusy ? "Marcando…" : "Marcar todas como leídas"}</button></div>
          {loading && <p className="loading" role="status">Cargando notificaciones…</p>}
          {error && <div className="notifications-error" role="alert"><span>{error}</span><button type="button" onClick={() => { loadedUserId.current = null; setError(""); setRetryNonce((current) => current + 1); }}>Reintentar</button></div>}
          {!loading && !error && notifications.length === 0 && <p className="empty-state">No tienes notificaciones.</p>}
          {!loading && notifications.length > 0 && <div className="notifications-list">{notifications.map((notification) => <button className={`notification-item${notification.readAt ? "" : " is-unread"}`} key={notification.id} type="button" onClick={() => void markRead(notification)} disabled={busyNotificationIds.has(notification.id)} aria-label={`${notification.readAt ? "Leída" : "No leída"}: ${notification.title}`}><span className="notification-item-content"><strong>{notification.title}</strong><span>{notification.body}</span><small>{formatDate(notification.createdAt)}</small></span>{!notification.readAt && <span className="notification-unread-indicator" aria-hidden="true" />}</button>)}</div>}
          {nextCursor && !loading && <button className="notifications-more" type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Cargando…" : "Ver más"}</button>}
        </section>
      )}
    </div>
  );
}
