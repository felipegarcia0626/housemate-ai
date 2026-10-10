const { test, expect } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
const { createServerClient } = require("@supabase/ssr");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Realtime subscription E2E requires ${name}.`);
  return value;
}

function rejectKnownAdministrativeKey(key) {
  const configuredAdministrativeKeys = [
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ].map((value) => value?.trim()).filter(Boolean);
  if (configuredAdministrativeKeys.includes(key) || key.startsWith("sb_secret_")) {
    throw new Error("Realtime subscription E2E requires a confirmed public Supabase key.");
  }

  const segments = key.split(".");
  if (segments.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
      if (payload?.role === "service_role") {
        throw new Error("Realtime subscription E2E requires a confirmed public Supabase key.");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Realtime subscription E2E requires a confirmed public Supabase key.") throw error;
    }
  }
}

function createCookieStore() {
  const cookies = new Map();
  return {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    setAll: (values) => {
      for (const { name, value } of values) cookies.set(name, value);
    },
    values: () => [...cookies].map(([name, value]) => ({ name, value })),
  };
}

async function createAuthenticatedSession({ supabaseUrl, anonKey, email, password }) {
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data.session?.user?.id) {
    throw new Error("Realtime subscription E2E authentication failed.");
  }

  const cookieStore = createCookieStore();
  const serverClient = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: cookieStore.getAll, setAll: cookieStore.setAll },
  });
  const { error: sessionError } = await serverClient.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  const cookies = cookieStore.values();
  if (sessionError || cookies.length === 0) {
    throw new Error("Realtime subscription E2E session cookie creation failed.");
  }
  return { userId: data.session.user.id, cookies };
}

function mockApiResponse(pathname, url) {
  const data = {
    "/api/auth/households": [
      { householdId: "00000000-0000-4000-8000-000000000502", householdName: "E2E read-only household", selected: true },
    ],
    "/api/dashboard/summary": { totalIncome: 0, totalSpent: 0, netAmount: 0, expenseCount: 0, memberIncome: [], byCategory: [] },
    "/api/categories": [],
    "/api/household-members": [],
    "/api/sharing-rules": [],
    "/api/balance": { members: [] },
    "/api/notifications": { notifications: [], unreadCount: 0, nextCursor: null },
  };

  if (pathname === "/api/auth/households" || pathname === "/api/dashboard/summary" ||
      pathname === "/api/categories" || pathname === "/api/household-members" ||
      pathname === "/api/sharing-rules" || pathname === "/api/balance") {
    if (url.search || url.hash) return null;
  }
  if (pathname === "/api/notifications") {
    if (url.searchParams.size !== 2 || url.searchParams.get("limit") !== "20" ||
        url.searchParams.get("unreadOnly") !== "false") return null;
  }
  if (pathname === "/api/categories/hierarchical") {
    if (url.searchParams.size !== 1) return null;
    const movementType = url.searchParams.get("movementType");
    return movementType === "EXPENSE" || movementType === "INCOME" ? [] : null;
  }
  if (pathname === "/api/expenses" || pathname === "/api/incomes") {
    const allowedParameters = pathname === "/api/expenses"
      ? new Set(["page", "pageSize", "sort", "sortDirection"])
      : new Set(["page", "pageSize", "sortBy", "sortOrder"]);
    if ([...url.searchParams.keys()].some((key) => !allowedParameters.has(key))) return null;
    return {
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 },
      summary: { totalCount: 0, totalAmount: 0 },
    };
  }
  return Object.hasOwn(data, pathname) ? data[pathname] : null;
}

function diagnosticDestination(rawUrl, appOrigin, supabaseOrigin) {
  try {
    const url = new URL(rawUrl);
    if (url.origin === appOrigin) {
      if (url.pathname.startsWith("/api/")) return "app:/api/[redacted]";
      return url.pathname === "/" ? "app:/" : "app:[resource]";
    }
    if (url.origin === supabaseOrigin) {
      if (url.pathname === "/auth/v1/user") return "supabase:/auth/v1/user";
      if (url.pathname === "/auth/v1/token") return "supabase:/auth/v1/token";
      if (url.pathname === "/realtime/v1/websocket") return "supabase:/realtime/v1/websocket";
      return "supabase:[resource]";
    }
  } catch { /* An invalid URL is still reported without its contents. */ }
  return "external-or-invalid:[redacted]";
}

function diagnosticErrorKind(value) {
  const message = String(value ?? "");
  if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|aborted/i.test(message)) return "blocked-or-aborted";
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  if (/network|fetch|connection|DNS|ERR_/i.test(message)) return "network";
  return "other";
}

function diagnosticErrorMessage(kind) {
  return {
    "blocked-or-aborted": "Request blocked or aborted",
    timeout: "Request timed out",
    network: "Network or transport error",
    other: "Unclassified error (original text redacted)",
  }[kind];
}

function observePageFailures(page, { baseURL, supabaseUrl }) {
  const appOrigin = new URL(baseURL).origin;
  const supabaseOrigin = new URL(supabaseUrl).origin;
  const state = { pageErrors: [], requestFailures: [], pageErrorCount: 0, requestFailureCount: 0 };
  page.on("pageerror", (error) => {
    state.pageErrorCount += 1;
    if (state.pageErrors.length < 10) {
      const kind = diagnosticErrorKind(error?.message);
      state.pageErrors.push({ kind, message: diagnosticErrorMessage(kind) });
    }
  });
  page.on("requestfailed", (request) => {
    state.requestFailureCount += 1;
    if (state.requestFailures.length < 10) {
      const kind = diagnosticErrorKind(request.failure()?.errorText);
      state.requestFailures.push({
        method: request.method(),
        destination: diagnosticDestination(request.url(), appOrigin, supabaseOrigin),
        kind,
        message: diagnosticErrorMessage(kind),
      });
    }
  });
  return state;
}

async function observeDashboardBranch(page) {
  const selectors = {
    checkingSession: "p.loading:has-text('Comprobando sesión')",
    login: "h1:has-text('Iniciar sesión')",
    onboarding: "#onboarding-title",
    householdSelection: "#household-selection-title",
    contextError: "section.auth-panel[role='alert']",
    dashboard: "main.shell h1:has-text('Finanzas del hogar')",
  };
  const observed = {};
  for (const [branch, selector] of Object.entries(selectors)) {
    observed[branch] = await page.locator(selector).count() > 0;
  }
  return observed;
}

async function installNetworkGuard(context, { baseURL, supabaseUrl, anonKey }) {
  const appOrigin = new URL(baseURL).origin;
  const supabase = new URL(supabaseUrl);
  const violations = [];

  function block(request, url, reason) {
    violations.push({
      method: request.method(),
      destination: diagnosticDestination(url.href, appOrigin, supabase.origin),
      reason,
    });
  }

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.origin === appOrigin) {
      if (url.pathname.startsWith("/api/")) {
        if (method !== "GET") {
          block(request, url, "application API mutation blocked");
          await route.abort();
          return;
        }
        const data = mockApiResponse(url.pathname, url);
        if (data === null) {
          block(request, url, "unclassified application API request blocked");
          await route.abort();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data }),
        });
        return;
      }
      const isRequiredApplicationResource = url.pathname === "/" ||
        url.pathname.startsWith("/_next/") || url.pathname === "/favicon.ico";
      if (["GET", "HEAD"].includes(method) && isRequiredApplicationResource) {
        await route.continue();
        return;
      }
      block(request, url, "non-read application request blocked");
      await route.abort();
      return;
    }

    const headers = request.headers();
    const isAuthUserRead = url.origin === supabase.origin &&
      url.pathname === "/auth/v1/user" && method === "GET" && headers.apikey === anonKey;
    const isAuthRefresh = url.origin === supabase.origin &&
      url.pathname === "/auth/v1/token" && method === "POST" &&
      url.searchParams.size === 1 && url.searchParams.get("grant_type") === "refresh_token" &&
      headers.apikey === anonKey;
    const isAllowedAuthPreflight = url.origin === supabase.origin && method === "OPTIONS" &&
      headers.origin === appOrigin &&
      ((url.pathname === "/auth/v1/user" && headers["access-control-request-method"] === "GET") ||
        (url.pathname === "/auth/v1/token" && url.searchParams.size === 1 &&
          url.searchParams.get("grant_type") === "refresh_token" &&
          headers["access-control-request-method"] === "POST")) &&
      (headers["access-control-request-headers"] ?? "").split(",").map((name) => name.trim().toLowerCase())
        .filter(Boolean).every((name) => ["apikey", "authorization", "content-type", "x-client-info"].includes(name));
    if (isAuthUserRead || isAuthRefresh || isAllowedAuthPreflight) {
      await route.continue();
      return;
    }

    block(request, url, "unapproved external HTTP request blocked");
    await route.abort();
  });

  await context.routeWebSocket(/.*/, (socket) => {
    const url = new URL(socket.url());
    const isRealtime = url.protocol === "wss:" && url.hostname === supabase.hostname &&
      url.port === supabase.port && !url.username && !url.password &&
      url.pathname === "/realtime/v1/websocket" &&
      url.searchParams.get("apikey") === anonKey &&
      [...url.searchParams.keys()].every((key) => ["apikey", "vsn"].includes(key));
    const isNextHmr = url.protocol === "ws:" && url.hostname === "127.0.0.1" &&
      url.port === new URL(baseURL).port && !url.username && !url.password &&
      url.pathname === "/_next/hmr" && url.searchParams.size === 1 &&
      Boolean(url.searchParams.get("id"));

    if (isRealtime || isNextHmr) {
      socket.connectToServer();
      return;
    }
    violations.push({
      method: "WEBSOCKET",
      destination: diagnosticDestination(url.href, appOrigin, supabase.origin),
      reason: "unapproved WebSocket destination blocked",
    });
    socket.close();
  });

  return violations;
}

function observeRealtimeDiagnostics(page) {
  const state = { bellMounted: false, userIdPresent: false, reachedSubscribed: false, currentStatus: null };
  page.on("console", (message) => {
    const text = message.text();
    const prefix = "[notifications][realtime] ";
    const markerIndex = text.indexOf(prefix);
    if (markerIndex < 0) return;
    const diagnostic = text.slice(markerIndex + prefix.length);
    const separator = diagnostic.indexOf(" ");
    const event = separator < 0 ? diagnostic : diagnostic.slice(0, separator);
    let details = {};
    if (separator >= 0) {
      try { details = JSON.parse(diagnostic.slice(separator + 1)); } catch { return; }
    }
    if (event === "bell_mounted") {
      state.bellMounted = true;
      state.userIdPresent = details.user_id_present === true;
    }
    if (event === "channel_status" && typeof details.status === "string") {
      state.currentStatus = details.status;
      if (details.status === "SUBSCRIBED") state.reachedSubscribed = true;
    }
  });
  return state;
}

function observeSessionDiagnostics(page) {
  const state = { events: [] };
  page.on("console", (message) => {
    const prefix = "[notifications][session] ";
    const text = message.text();
    const markerIndex = text.indexOf(prefix);
    if (markerIndex < 0) return;
    const diagnostic = text.slice(markerIndex + prefix.length);
    const separator = diagnostic.indexOf(" ");
    const event = separator < 0 ? diagnostic : diagnostic.slice(0, separator);
    if (!["get_session_started", "get_session_finished", "auth_state_changed"].includes(event)) return;
    let details = {};
    if (separator >= 0) {
      try { details = JSON.parse(diagnostic.slice(separator + 1)); } catch { return; }
    }
    state.events.push({
      event,
      ...(event === "get_session_finished" && Number.isFinite(details.durationMs)
        ? { durationMs: details.durationMs } : {}),
      ...(event === "auth_state_changed" && typeof details.authEvent === "string"
        ? { authEvent: ["INITIAL_SESSION", "SIGNED_IN", "SIGNED_OUT", "TOKEN_REFRESHED", "USER_UPDATED", "PASSWORD_RECOVERY", "MFA_CHALLENGE_VERIFIED"].includes(details.authEvent)
          ? details.authEvent : "OTHER" } : {}),
    });
  });
  return state;
}

test("two existing users establish independent authenticated Realtime subscriptions", async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const supabaseUrl = required("E2E_SUPABASE_URL");
  const anonKey = required("E2E_SUPABASE_ANON_KEY");
  rejectKnownAdministrativeKey(anonKey);
  const [firstSession, secondSession] = await Promise.all([
    createAuthenticatedSession({
      supabaseUrl,
      anonKey,
      email: required("E2E_TEST_EMAIL"),
      password: required("E2E_TEST_PASSWORD"),
    }),
    createAuthenticatedSession({
      supabaseUrl,
      anonKey,
      email: required("E2E_NOTIFICATION_B_EMAIL"),
      password: required("E2E_NOTIFICATION_B_PASSWORD"),
    }),
  ]);
  if (firstSession.userId === secondSession.userId) {
    throw new Error("Realtime subscription E2E accounts must be distinct users.");
  }

  const contexts = [];
  try {
    for (const session of [firstSession, secondSession]) {
      const context = await browser.newContext({ serviceWorkers: "block" });
      contexts.push(context);
      await context.addCookies(session.cookies.map(({ name, value }) => ({ name, value, url: baseURL })));
      await context.addInitScript(() => {
        window.__HOUSEMATE_REALTIME_E2E_DIAGNOSTICS__ = true;
      });
    }

    const violations = await Promise.all(contexts.map((context) =>
      installNetworkGuard(context, { baseURL, supabaseUrl, anonKey }),
    ));
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const realtimeStates = pages.map(observeRealtimeDiagnostics);
    const sessionStates = pages.map(observeSessionDiagnostics);
    const pageFailures = pages.map((page) => observePageFailures(page, { baseURL, supabaseUrl }));

    await Promise.all(pages.map((page) => page.goto(`${baseURL}/`)));
    try {
      await Promise.all(pages.map((page) =>
        expect(page.getByRole("button", { name: "Notificaciones", exact: true }))
          .toHaveAttribute("aria-expanded", "false"),
      ));
    } catch {
      const diagnostics = await Promise.all(pages.map(async (page, index) => ({
        context: index === 0 ? "A" : "B",
        branches: await observeDashboardBranch(page).catch(() => ({ inspectionFailed: true })),
        bellMounted: realtimeStates[index].bellMounted,
        userIdPresent: realtimeStates[index].userIdPresent,
        reachedSubscribed: realtimeStates[index].reachedSubscribed,
        currentStatus: realtimeStates[index].currentStatus,
        sessionEvents: sessionStates[index].events.slice(0, 20),
        ...pageFailures[index],
        blockedRequests: violations[index].slice(0, 10),
        blockedRequestCount: violations[index].length,
      })));
      throw new Error(`Notifications button unavailable; sanitized diagnostics: ${JSON.stringify(diagnostics)}`);
    }
    await Promise.all(realtimeStates.map((state) =>
      expect.poll(() => state.bellMounted && state.userIdPresent &&
        state.reachedSubscribed && state.currentStatus === "SUBSCRIBED", {
        timeout: 25_000,
        message: "Each authenticated browser session must mount NotificationsBell and reach SUBSCRIBED.",
      }).toBe(true),
    ));

    expect(violations.flat()).toEqual([]);
    for (const state of realtimeStates) {
      expect(state.reachedSubscribed).toBe(true);
      expect(state.currentStatus).toBe("SUBSCRIBED");
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
