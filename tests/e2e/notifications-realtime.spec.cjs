const { test, expect } = require("@playwright/test");
const { createAuthenticatedCookieHeader } = require("./agent-authenticated.cjs");
const { assertWriteE2EContext, createE2EClient, assertRecoverableE2EOperation } = require("./fixtures.cjs");

// Deliberately fail discovery, including under alternative Playwright configs.
// A lost creation response and unverified DELETE privileges have no safe recovery.
assertRecoverableE2EOperation("notifications");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Realtime E2E requires ${name}.`);
  return value;
}

function cookieList(header) {
  return header.split(/;\s*/).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return { name: part.slice(0, separator), value: part.slice(separator + 1), domain: "127.0.0.1", path: "/" };
  });
}

function invitationToken(inviteUrl) {
  const token = new URL(inviteUrl).pathname.split("/").at(-1);
  if (!token) throw new Error("Realtime E2E invitation response did not include a token.");
  return decodeURIComponent(token);
}

function diagnosticDetails(entry) {
  const start = entry.text.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(entry.text.slice(start)); } catch { return null; }
}

async function adminResult(operation, result) {
  if (result.error) throw new Error(`Realtime E2E ${operation} failed (${result.error.code ?? "UNKNOWN"}).`);
  return result.data;
}

test("delivers a new notification through Realtime without opening the bell", async ({ browser, baseURL }) => {
  assertRecoverableE2EOperation("notifications");
  test.setTimeout(60_000);
  const context = assertWriteE2EContext();
  const supabaseUrl = context.supabaseUrl;
  const anonKey = required("E2E_SUPABASE_ANON_KEY");
  const householdId = context.householdId;
  const actorEmail = required("E2E_TEST_EMAIL");
  const actorPassword = required("E2E_TEST_PASSWORD");
  const recipientEmail = required("E2E_NOTIFICATION_B_EMAIL");
  const recipientPassword = required("E2E_NOTIFICATION_B_PASSWORD");
  const admin = createE2EClient(context);
  let invitationId = null;
  let notificationId = null;
  let tokenHash = null;
  let creationAttempted = false;
  let primaryError = null;
  const actorContext = await browser.newContext();
  const recipientContext = await browser.newContext();
  await actorContext.addInitScript(() => { window.__HOUSEMATE_REALTIME_E2E_DIAGNOSTICS__ = true; });
  await recipientContext.addInitScript(() => { window.__HOUSEMATE_REALTIME_E2E_DIAGNOSTICS__ = true; });
  const actorPage = await actorContext.newPage();
  const recipientPage = await recipientContext.newPage();
  const recipientLogs = [];
  const notificationResponses = [];
  recipientPage.on("console", (message) => {
    const text = message.text();
    if (text.includes("[notifications][realtime]")) recipientLogs.push({ text, time: Date.now() });
  });
  recipientPage.on("response", (response) => {
    const url = new URL(response.url());
    if (response.request().method() === "GET" && url.pathname === "/api/notifications" && url.searchParams.get("unreadOnly") === "false") {
      notificationResponses.push({ response, requestId: response.request().headers()["x-housemate-realtime-request-id"] ?? null });
    }
  });

  try {
    const [actorCookie, recipientCookie] = await Promise.all([
      createAuthenticatedCookieHeader({ supabaseUrl, anonKey, email: actorEmail, password: actorPassword }),
      createAuthenticatedCookieHeader({ supabaseUrl, anonKey, email: recipientEmail, password: recipientPassword }),
    ]);
    await actorContext.addCookies(cookieList(actorCookie));
    await recipientContext.addCookies(cookieList(recipientCookie));
    await actorPage.goto(`${baseURL}/`);

    const initialGet = recipientPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === "/api/notifications" && url.searchParams.get("unreadOnly") === "false";
    });
    await recipientPage.goto(`${baseURL}/`);
    const initialResponse = await initialGet;
    if (initialResponse.status() !== 200) throw new Error(`REALTIME_SUBSCRIPTION_SETUP_FAILED: initial notifications GET returned ${initialResponse.status()}.`);
    const initialData = (await initialResponse.json()).data;
    const initialUnreadCount = Number(initialData?.unreadCount ?? 0);
    const initialBadgeText = await recipientPage.locator(".notifications-badge").textContent().catch(() => null);

    await expect.poll(() => recipientLogs.some(({ text }) => text.includes("channel_status") && text.includes("SUBSCRIBED")), { timeout: 15_000, message: "REALTIME_SUBSCRIPTION_FAILED: channel did not reach SUBSCRIBED." }).toBe(true);

    creationAttempted = true;
    const creation = await actorPage.evaluate(async ({ householdId, email }) => {
      const response = await fetch(`/api/auth/households/${householdId}/invitations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    }, { householdId, email: recipientEmail });
    // Capture the only recovery reference exposed by this endpoint before assertions.
    if (creation.body?.data?.inviteUrl) {
      const token = invitationToken(creation.body.data.inviteUrl);
      tokenHash = require("node:crypto").createHash("sha256").update(token).digest("hex");
    }
    if (creation.status !== 201 || !tokenHash) throw new Error(`NOTIFICATION_CREATION_FAILED: invitation API returned ${creation.status}.`);
    const invitation = await adminResult("invitation lookup", await admin.from("tb_household_invitations").select("id").eq("household_id", householdId).eq("token_hash", tokenHash).single());
    invitationId = invitation.id;
    const recipient = await adminResult("recipient lookup", await admin.from("tb_users").select("id").eq("email", recipientEmail.toLowerCase()).single());
    const notification = await adminResult("notification lookup", await admin.from("tb_notifications").select("id").eq("household_id", householdId).eq("source_entity_id", invitationId).eq("recipient_user_id", recipient.id).single());
    notificationId = notification.id;

    await expect.poll(
      () => recipientLogs.some(({ text }) => text.includes("insert_received")),
      { timeout: 15_000, message: "REALTIME_EVENT_NOT_RECEIVED: no INSERT callback was observed." },
    ).toBeTruthy();
    const insertLog = recipientLogs.find(({ text }) => text.includes("insert_received"));
    if (!insertLog || !insertLog.text.includes(notificationId)) {
      throw new Error("REALTIME_EVENT_UNCORRELATED: the available instrumentation does not expose the created notification ID.");
    }
    await expect.poll(
      () => recipientLogs.some(({ text }) => {
        if (!text.includes("reconciliation_executed")) return false;
        const details = diagnosticDetails({ text });
        return details?.eventIds?.includes(notificationId);
      }),
      { timeout: 15_000, message: "REALTIME_RECONCILIATION_UNCORRELATED: no reconciliation covered the created notification." },
    ).toBe(true);
    const reconciliationLog = recipientLogs.find(({ text }) => text.includes("reconciliation_executed") && diagnosticDetails({ text })?.eventIds?.includes(notificationId));
    const reconciliationDetails = diagnosticDetails(reconciliationLog);
    if (!reconciliationDetails?.reconciliationId) throw new Error("REALTIME_RECONCILIATION_UNCORRELATED: missing reconciliation ID.");
    await expect.poll(
      () => recipientLogs.some(({ text }) => text.includes("notifications_get_started") && diagnosticDetails({ text })?.reconciliationId === reconciliationDetails.reconciliationId),
      { timeout: 15_000, message: "REALTIME_GET_UNCORRELATED: no GET start was linked to the reconciliation." },
    ).toBe(true);
    const requestStarted = recipientLogs.find(({ text }) => text.includes("notifications_get_started") && diagnosticDetails({ text })?.reconciliationId === reconciliationDetails.reconciliationId);
    const requestDetails = diagnosticDetails(requestStarted);
    if (!requestDetails?.requestId) throw new Error("REALTIME_GET_UNCORRELATED: missing request ID.");
    expect(requestDetails.instanceId).toBe(reconciliationDetails.instanceId);
    expect(requestDetails.reconciliationId).toBe(reconciliationDetails.reconciliationId);
    expect(Array.isArray(requestDetails.eventIds)).toBe(true);
    expect(requestDetails.eventIds).toContain(notificationId);
    expect([...new Set(requestDetails.eventIds)].sort()).toEqual([...new Set(reconciliationDetails.eventIds ?? [])].sort());
    await expect.poll(
      () => notificationResponses.some(({ requestId }) => requestId === requestDetails.requestId),
      { timeout: 15_000, message: "REALTIME_RECONCILIATION_FAILED: no response matched the correlated request ID." },
    ).toBe(true);
    const reconciliationEntry = notificationResponses.find(({ requestId }) => requestId === requestDetails.requestId);
    const reconciliationResponse = reconciliationEntry.response;
    if (reconciliationResponse.status !== 200) throw new Error(`REALTIME_RECONCILIATION_FAILED: automatic GET returned ${reconciliationResponse.status}.`);
    const reconciled = (await reconciliationResponse.json()).data;
    expect(reconciled.notifications.some((item) => item.id === notificationId)).toBe(true);
    expect(reconciled.unreadCount).toBeGreaterThan(initialUnreadCount);
    await expect.poll(
      () => recipientLogs.some(({ text }) => {
        const details = diagnosticDetails({ text });
        return text.includes("reconciliation_response_applied") && details?.instanceId === requestDetails.instanceId && details?.reconciliationId === requestDetails.reconciliationId && details?.requestId === requestDetails.requestId;
      }),
      { timeout: 15_000, message: "REALTIME_RESPONSE_NOT_ACCEPTED: correlated response was not accepted by fencing." },
    ).toBe(true);
    const appliedLog = recipientLogs.find(({ text }) => text.includes("reconciliation_response_applied") && diagnosticDetails({ text })?.instanceId === requestDetails.instanceId && diagnosticDetails({ text })?.reconciliationId === requestDetails.reconciliationId && diagnosticDetails({ text })?.requestId === requestDetails.requestId);
    const appliedDetails = diagnosticDetails(appliedLog);
    expect(Array.isArray(appliedDetails?.eventIds)).toBe(true);
    expect([...new Set(appliedDetails.eventIds)].sort()).toEqual([...new Set(reconciliationDetails.eventIds ?? [])].sort());
    expect(appliedDetails.eventIds).toContain(notificationId);
    expect(recipientLogs.some(({ text }) => {
      const details = diagnosticDetails({ text });
      return text.includes("reconciliation_response_discarded") && details?.instanceId === requestDetails.instanceId && details?.reconciliationId === requestDetails.reconciliationId && details?.requestId === requestDetails.requestId;
    })).toBe(false);
    expect(recipientLogs.some(({ text }) => text.includes("reconciliation_scheduled") && diagnosticDetails({ text })?.reconciliationId === reconciliationDetails.reconciliationId)).toBe(true);
    expect(recipientLogs.some(({ text }) => text.includes("notifications_get_started") && diagnosticDetails({ text })?.reconciliationId === reconciliationDetails.reconciliationId)).toBe(true);
    expect(recipientLogs.some(({ text }) => text.includes("notifications_get_finished") && diagnosticDetails({ text })?.requestId === requestDetails.requestId)).toBe(true);
    const uiAppliedLog = recipientLogs.find(({ text }) => text.includes("ui_state_applied") && diagnosticDetails({ text })?.instanceId === requestDetails.instanceId && diagnosticDetails({ text })?.reconciliationId === requestDetails.reconciliationId && diagnosticDetails({ text })?.requestId === requestDetails.requestId);
    expect(uiAppliedLog).toBeTruthy();
    const uiAppliedDetails = diagnosticDetails(uiAppliedLog);
    expect(Array.isArray(uiAppliedDetails?.eventIds)).toBe(true);
    expect([...new Set(uiAppliedDetails.eventIds)].sort()).toEqual([...new Set(reconciliationDetails.eventIds ?? [])].sort());
    expect(uiAppliedDetails.eventIds).toContain(notificationId);
    const expectedBadgeText = reconciled.unreadCount > 99 ? "99+" : String(reconciled.unreadCount);
    await expect.poll(() => recipientPage.locator(".notifications-badge").textContent().catch(() => null), { timeout: 5_000, message: "UI_BADGE_NOT_UPDATED: badge did not reflect the correlated unreadCount." }).toBe(expectedBadgeText);
    expect(expectedBadgeText).not.toBe(initialBadgeText);
    await expect(recipientPage.locator(".notifications-badge")).toBeVisible({ timeout: 5_000 });
    expect(await recipientPage.locator(".notifications-trigger").getAttribute("aria-expanded")).toBe("false");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    if (creationAttempted && (!invitationId || !notificationId)) {
      cleanupErrors.push(
        `INCOMPLETE: exact invitation/notification IDs unavailable; no automatic deletion authorized. Administrative references: ${JSON.stringify({ invitationId, notificationId })}`,
      );
    }
    let notificationRemovalVerified = false;
    const exactResources = invitationId && notificationId
      ? [["tb_notifications", notificationId], ["tb_household_invitations", invitationId]]
      : [];
    for (const [table, id] of exactResources) {
      if (!id) continue;
      if (table === "tb_household_invitations" && !notificationRemovalVerified) {
        cleanupErrors.push(`invitation cleanup withheld until notification removal is verified; exact id=${id}`);
        continue;
      }
      try {
        const cleanup = await admin.from(table).delete().eq("household_id", householdId).eq("id", id);
        if (cleanup.error) {
          cleanupErrors.push(`${table} cleanup (${cleanup.error.code ?? "UNKNOWN"}); exact id=${id}`);
          continue;
        }
        const remaining = await admin.from(table).select("id").eq("household_id", householdId).eq("id", id);
        if (remaining.error || !Array.isArray(remaining.data) || remaining.data.length !== 0) {
          cleanupErrors.push(`${table} cleanup unverified (${remaining.error?.code ?? "ROW_REMAINS"}); exact id=${id}`);
        } else if (table === "tb_notifications") {
          notificationRemovalVerified = true;
        }
      } catch {
        cleanupErrors.push(`${table} cleanup failed unexpectedly; exact id=${id}`);
      }
    }
    try { await actorContext.close(); } catch (error) { cleanupErrors.push(`actor context (${error.message})`); }
    try { await recipientContext.close(); } catch (error) { cleanupErrors.push(`recipient context (${error.message})`); }
    if (cleanupErrors.length > 0) {
      const cleanupMessage = `Realtime E2E cleanup failed: ${cleanupErrors.join(", ")}.`;
      if (primaryError) console.error(`${cleanupMessage} Primary error preserved: ${primaryError.message}`);
      else throw new Error(cleanupMessage);
    }
  }
});
