const { test: base, expect } = require("@playwright/test");

// Browser UI tests only: fake session, HTTP responses and Phoenix messages.
// No Supabase imports, real credentials, admin client or integration fixtures.
const USER_ID = "00000000-0000-4000-8000-000000000501";
const HOUSEHOLD_ID = "00000000-0000-4000-8000-000000000502";
const SOURCE_ID = "00000000-0000-4000-8000-000000000503";
const SUBSCRIPTION_DIAGNOSTIC_PREFIX = "[notifications][realtime] subscription_status ";
const UNKNOWN_ERROR_MARKER = "MOCK_PRIVATE_ERROR_MESSAGE";
const CLOSE_REASON_MARKER = "MOCK_PRIVATE_CLOSE_REASON";
const notification = (suffix, overrides = {}) => ({
  id: `00000000-0000-4000-8000-000000000${suffix}`,
  householdId: HOUSEHOLD_ID,
  type: "HOUSEHOLD_MEMBER_REMOVED",
  title: `Aviso simulado ${suffix}`,
  body: "Contenido ficticio para pruebas de interfaz.",
  metadata: {},
  sourceEntityType: "HOUSEHOLD_MEMBER",
  sourceEntityId: SOURCE_ID,
  createdAt: "2026-01-01T12:00:00Z",
  readAt: null,
  ...overrides,
});

function captureSubscriptionDiagnostics(page) {
  const messages = [];
  page.on("console", (message) => {
    if (message.type() === "info" && message.text().startsWith(SUBSCRIPTION_DIAGNOSTIC_PREFIX)) {
      messages.push(message.text());
    }
  });
  return messages;
}

function subscriptionDiagnosticEntries(messages) {
  return messages.map((message) => JSON.parse(message.slice(SUBSCRIPTION_DIAGNOSTIC_PREFIX.length)));
}

async function expectSubscriptionDiagnostic(messages, status, category) {
  await expect.poll(() => subscriptionDiagnosticEntries(messages).some((entry) => entry.status === status && entry.category === category)).toBe(true);
  return subscriptionDiagnosticEntries(messages).find((entry) => entry.status === status && entry.category === category);
}

function expectSubscriptionDiagnosticMetadata(entry) {
  expect(entry.instanceId).toEqual(expect.any(String));
  expect(entry.instanceId.length).toBeGreaterThan(0);
  expect(Number.isFinite(entry.elapsedMs)).toBe(true);
  expect(entry.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(entry.elapsedMs).toBeLessThan(120_000);
}

const test = base.extend({
  mockNotifications: async ({ context, baseURL }, use, testInfo) => {
    const server = Array.isArray(testInfo.config.webServer) ? testInfo.config.webServer[0] : testInfo.config.webServer;
    const env = server?.env;
    if (testInfo.config.globalSetup || testInfo.config.globalTeardown ||
        baseURL !== "http://127.0.0.1:3200" || server?.reuseExistingServer !== false ||
        env?.NODE_ENV !== "test" || env?.E2E_WRITE_ENABLED !== "0" ||
        env?.SUPABASE_URL !== "http://127.0.0.1:9" || env?.NEXT_PUBLIC_SUPABASE_URL !== "http://127.0.0.1:9" ||
        [env?.SUPABASE_ANON_KEY, env?.SUPABASE_SERVICE_ROLE_KEY, env?.NEXT_PUBLIC_SUPABASE_ANON_KEY].some((key) => key !== "playwright-readonly")) {
      throw new Error("READONLY_ISOLATION_REQUIRED: use the dedicated readonly configuration without setup or real credentials.");
    }

    const origin = new URL(baseURL).origin;
    const violations = [];
    const state = { items: [notification("511")], gets: [], writes: [], paginated: false, failNextGet: false, channel: null, realtimeMode: "success" };
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const session = {
      access_token: `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: USER_ID, exp: expiresAt, role: "authenticated" })}.mock-signature`,
      refresh_token: "mock-not-a-real-refresh-token", token_type: "bearer", expires_in: 3600, expires_at: expiresAt,
      user: { id: USER_ID, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
    };
    // @supabase/ssr uses base64url cookies and sb-<hostname first segment>-auth-token.
    await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${encode(session)}`, url: baseURL }]);

    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        violations.push("unexpected non-application HTTP request");
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      const reply = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ data }) });
      if (url.pathname === "/api/notifications" && request.method() === "GET") {
        state.gets.push({ unreadOnly: url.searchParams.get("unreadOnly"), cursor: url.searchParams.get("cursor") });
        if (state.failNextGet) {
          await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Error simulado de notificaciones." } }) });
          return;
        }
        const items = state.items.filter((item) => url.searchParams.get("unreadOnly") !== "true" || !item.readAt);
        const cursor = url.searchParams.get("cursor");
        await reply({ notifications: state.paginated ? (cursor ? items.slice(1) : items.slice(0, 1)) : items,
          unreadCount: state.items.filter((item) => !item.readAt).length,
          nextCursor: state.paginated && !cursor && items.length > 1 ? "mock-next-page" : null });
        return;
      }
      if (request.method() === "POST") {
        state.writes.push(url.pathname);
        if (url.pathname === "/api/notifications/read-all") {
          state.items = state.items.map((item) => ({ ...item, readAt: "2026-01-02T00:00:00Z" }));
          await reply({ updatedCount: state.items.length }); return;
        }
        const mark = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
        if (mark && state.items.some((item) => item.id === mark[1])) {
          state.items = state.items.map((item) => item.id === mark[1] ? { ...item, readAt: "2026-01-02T00:00:00Z" } : item);
          await reply({ id: mark[1], readAt: "2026-01-02T00:00:00Z" }); return;
        }
        if (url.pathname === `/api/auth/households/invitations/${SOURCE_ID}/accept`) {
          state.items = state.items.map((item) => ({ ...item, actionState: "ACCEPTED" }));
          await reply({ householdId: HOUSEHOLD_ID }); return;
        }
      }
      const reads = {
        "/api/auth/households": [{ householdId: HOUSEHOLD_ID, householdName: "Hogar simulado", selected: true }],
        "/api/dashboard/summary": { totalIncome: 0, totalSpent: 0, netAmount: 0, expenseCount: 0, memberIncome: [], byCategory: [] },
        "/api/categories": [], "/api/categories/hierarchical": [], "/api/household-members": [], "/api/sharing-rules": [],
        "/api/balance": { members: [] },
      };
      if (request.method() === "GET" && url.pathname in reads) { await reply(reads[url.pathname]); return; }
      if (request.method() === "GET" && ["/api/expenses", "/api/incomes"].includes(url.pathname)) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 }, summary: { totalCount: 0, totalAmount: 0 } }) }); return;
      }
      violations.push("unexpected application API request (blocked)");
      await route.abort();
    });

    await context.routeWebSocket(/.*/, (socket) => {
      const url = new URL(socket.url());
      if (url.hostname === "127.0.0.1" && url.port === "3200") { socket.connectToServer(); return; }
      if (url.hostname !== "127.0.0.1" || url.port !== "9" || url.pathname !== "/realtime/v1/websocket") {
        violations.push("unexpected WebSocket destination (blocked)"); socket.close(); return;
      }
      // Deliberately never connectToServer: simulate the installed SDK's protocol.
      socket.onMessage((message) => {
        const [joinRef, ref, topic, event, payload] = JSON.parse(String(message));
        if (event === "phx_join") {
          const filters = payload.config?.postgres_changes;
          if (!Array.isArray(filters) || filters.length !== 1 || filters[0].event !== "INSERT" || filters[0].schema !== "public" || filters[0].table !== "tb_notifications") {
            violations.push("unexpected Realtime subscription"); socket.close(); return;
          }
          state.channel = { socket, topic, joinRef };
          if (state.realtimeMode === "channel_error") {
            socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "error", response: { reason: UNKNOWN_ERROR_MARKER, detail: "MOCK_PRIVATE_ERROR_DETAIL" } }]));
            return;
          }
          const serverFilter = state.realtimeMode === "bindings_mismatch" ? { ...filters[0], event: "UPDATE" } : filters[0];
          socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: { postgres_changes: [{ ...serverFilter, id: 1 }] } }]));
          if (state.realtimeMode === "close_event") {
            setTimeout(() => { void socket.close({ code: 4001, reason: CLOSE_REASON_MARKER }); }, 0);
          }
        } else if (event === "heartbeat" || event === "phx_leave") {
          if (event === "heartbeat" && state.realtimeMode === "heartbeat_timeout") return;
          socket.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]));
        }
      });
    });
    state.insert = (item) => {
      if (!state.channel) throw new Error("MOCK_CHANNEL_NOT_SUBSCRIBED");
      state.items.unshift(item);
      const { socket, topic, joinRef } = state.channel;
      socket.send(JSON.stringify([joinRef, null, topic, "postgres_changes", { ids: [1], data: {
        schema: "public", table: "tb_notifications", type: "INSERT", commit_timestamp: "2026-01-02T00:00:00Z",
        columns: [{ name: "id", type: "uuid" }], record: { id: item.id }, old_record: {}, errors: null,
      } }]));
    };
    try { await use(state); } finally { expect(violations, "Isolation failed: unexpected requests were blocked, never forwarded.").toEqual([]); }
  },
});

test("mocked list, pagination, mark-read, unread empty state and filter persistence", async ({ page, mockNotifications: state }) => {
  state.items.push(notification("512")); state.paginated = true;
  await page.goto("/");
  const bell = page.getByRole("button", { name: "Notificaciones", exact: true });
  await expect(bell).toBeVisible();
  await expect(page.locator(".notifications-badge")).toHaveText("2");
  await bell.click();
  const panel = page.getByRole("region", { name: "Notificaciones", exact: true });
  await expect(panel.getByText("Aviso simulado 511", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Ver más", exact: true }).click();
  await expect(panel.getByText("Aviso simulado 512", { exact: true })).toBeVisible();
  expect(state.gets.some((get) => get.cursor === "mock-next-page")).toBe(true);
  await panel.getByRole("button", { name: "No leída: Aviso simulado 511", exact: true }).click();
  await expect(page.locator(".notifications-badge")).toHaveText("1");
  await panel.getByRole("button", { name: "Marcar todas como leídas", exact: true }).click();
  await expect(page.locator(".notifications-badge")).toHaveCount(0);
  const markAll = panel.getByRole("button", { name: "Marcar todas como leídas", exact: true });
  await expect(markAll).toBeDisabled();
  await expect(markAll).toHaveCSS("cursor", "not-allowed");
  await panel.getByRole("button", { name: "No leídas", exact: true }).click();
  await expect(panel.getByText("No tienes notificaciones sin leer.", { exact: true })).toBeVisible();
  expect(state.gets.at(-1).unreadOnly).toBe("true");
  await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0);
  await bell.click();
  await expect(panel.getByRole("button", { name: "No leídas", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByText("No tienes notificaciones sin leer.", { exact: true })).toBeVisible();
});

test("mocked error/retry and invitation accepted state", async ({ page, mockNotifications: state }) => {
  state.items = [notification("511", { type: "HOUSEHOLD_INVITATION_RECEIVED", sourceEntityType: "HOUSEHOLD_INVITATION", actionState: "PENDING" })];
  state.failNextGet = true;
  await page.goto("/");
  await page.getByRole("button", { name: "Notificaciones", exact: true }).click();
  const panel = page.getByRole("region", { name: "Notificaciones", exact: true });
  await expect(panel.getByRole("alert")).toContainText("Error simulado de notificaciones.");
  state.failNextGet = false;
  await panel.getByRole("button", { name: "Reintentar", exact: true }).click();
  await panel.getByRole("button", { name: "Aceptar invitación", exact: true }).click();
  await expect(panel.getByText("Aceptada", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Aceptar invitación", exact: true })).toHaveCount(0);
  expect(state.writes).toContain(`/api/auth/households/invitations/${SOURCE_ID}/accept`);
  await page.reload();
  await page.getByRole("button", { name: "Notificaciones", exact: true }).click();
  await expect(panel.getByText("Aceptada", { exact: true })).toBeVisible();
});

test("simulated INSERT reconciles the closed bell through mocked GET", async ({ page, mockNotifications: state }) => {
  await page.goto("/");
  const bell = page.getByRole("button", { name: "Notificaciones", exact: true });
  await expect(page.locator(".notifications-badge")).toHaveText("1");
  await expect.poll(() => Boolean(state.channel)).toBe(true);
  const priorGets = state.gets.length;
  state.insert(notification("513"));
  await expect.poll(() => state.gets.length).toBeGreaterThan(priorGets);
  await expect(page.locator(".notifications-badge")).toHaveText("2");
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: "Notificaciones", exact: true })).toHaveCount(0);
  await bell.click();
  await expect(page.getByText("Aviso simulado 513", { exact: true })).toBeVisible();
});

test("Realtime subscription diagnostics are opt-in and report a sanitized SUBSCRIBED event", async ({ page, mockNotifications: state }) => {
  const messages = captureSubscriptionDiagnostics(page);
  await page.addInitScript(() => { window.__HOUSEMATE_REALTIME_SUBSCRIPTION_DIAGNOSTICS__ = true; });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Notificaciones", exact: true })).toBeVisible();

  const entry = await expectSubscriptionDiagnostic(messages, "SUBSCRIBED", "absent");
  expectSubscriptionDiagnosticMetadata(entry);
  expect(messages.join("\n")).not.toContain(USER_ID);
  expect(messages.join("\n")).not.toContain(SOURCE_ID);
  expect(state.realtimeMode).toBe("success");
});

test("Realtime subscription diagnostics remain disabled by default", async ({ page, mockNotifications: state }) => {
  const messages = captureSubscriptionDiagnostics(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Notificaciones", exact: true })).toBeVisible();
  await expect.poll(() => Boolean(state.channel)).toBe(true);
  await page.waitForTimeout(100);

  expect(await page.evaluate(() => window.__HOUSEMATE_REALTIME_SUBSCRIPTION_DIAGNOSTICS__)).toBeUndefined();
  expect(messages).toEqual([]);
});

test("Realtime diagnostics classify a recognized socket CloseEvent without its reason", async ({ page, mockNotifications: state }) => {
  state.realtimeMode = "close_event";
  const messages = captureSubscriptionDiagnostics(page);
  await page.addInitScript(() => { window.__HOUSEMATE_REALTIME_SUBSCRIPTION_DIAGNOSTICS__ = true; });
  await page.goto("/");

  const entry = await expectSubscriptionDiagnostic(messages, "CHANNEL_ERROR", "socket_close");
  expect(entry.closeCode).toBe(4001);
  expect(typeof entry.wasClean).toBe("boolean");
  expectSubscriptionDiagnosticMetadata(entry);
  expect(messages.join("\n")).not.toContain(CLOSE_REASON_MARKER);
});

test("Realtime diagnostics classify a heartbeat timeout without transport details", async ({ page, mockNotifications: state }) => {
  state.realtimeMode = "heartbeat_timeout";
  await page.clock.install();
  const messages = captureSubscriptionDiagnostics(page);
  await page.addInitScript(() => { window.__HOUSEMATE_REALTIME_SUBSCRIPTION_DIAGNOSTICS__ = true; });
  await page.goto("/");
  await expectSubscriptionDiagnostic(messages, "SUBSCRIBED", "absent");
  await page.clock.fastForward(25_000);
  await page.clock.fastForward(25_000);

  const entry = await expectSubscriptionDiagnostic(messages, "CHANNEL_ERROR", "heartbeat_timeout");
  expectSubscriptionDiagnosticMetadata(entry);
});

test("Realtime diagnostics classify binding mismatches and omit SDK error details", async ({ page, mockNotifications: state }) => {
  state.realtimeMode = "bindings_mismatch";
  const messages = captureSubscriptionDiagnostics(page);
  await page.addInitScript(() => { window.__HOUSEMATE_REALTIME_SUBSCRIPTION_DIAGNOSTICS__ = true; });
  await page.goto("/");

  const entry = await expectSubscriptionDiagnostic(messages, "CHANNEL_ERROR", "bindings_mismatch");
  expectSubscriptionDiagnosticMetadata(entry);
});

test("Realtime diagnostics classify unknown errors without logging messages or error objects", async ({ page, mockNotifications: state }) => {
  state.realtimeMode = "channel_error";
  const messages = captureSubscriptionDiagnostics(page);
  await page.addInitScript(() => { window.__HOUSEMATE_REALTIME_SUBSCRIPTION_DIAGNOSTICS__ = true; });
  await page.goto("/");

  const entry = await expectSubscriptionDiagnostic(messages, "CHANNEL_ERROR", "error_unclassified");
  expectSubscriptionDiagnosticMetadata(entry);
  expect(messages.join("\n")).not.toContain(UNKNOWN_ERROR_MARKER);
  expect(messages.join("\n")).not.toContain("MOCK_PRIVATE_ERROR_DETAIL");
});
