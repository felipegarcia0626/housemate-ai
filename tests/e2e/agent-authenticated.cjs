const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const { createClient } = require("@supabase/supabase-js");
const { createServerClient } = require("@supabase/ssr");
const crypto = require("node:crypto");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`E2E requires ${name}`);
  return value;
}

function optional(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

function assertResponse(label, response) {
  if (!response.ok) {
    throw new Error(`E2E ${label} failed with HTTP ${response.status}.`);
  }
  return response;
}

function createCookieJar() {
  const values = new Map();
  return {
    getAll() {
      return [...values].map(([name, value]) => ({ name, value }));
    },
    setAll(cookies) {
      for (const { name, value } of cookies) values.set(name, value);
    },
    header() {
      return [...values].map(([name, value]) => `${name}=${value}`).join("; ");
    },
  };
}

async function createAuthenticatedCookieHeader({ supabaseUrl, anonKey, email, password }) {
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error("E2E authentication failed.");

  const jar = createCookieJar();
  const serverClient = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: jar.getAll, setAll: jar.setAll },
  });
  const { error: sessionError } = await serverClient.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (sessionError || !jar.header()) throw new Error("E2E session cookie creation failed.");
  return jar.header();
}

async function requestJson(baseUrl, cookie, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      cookie,
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function ensureHousehold(baseUrl, cookie) {
  let result = await requestJson(baseUrl, cookie, "/api/auth/households");
  if (result.response.status === 403) {
    result = await requestJson(baseUrl, cookie, "/api/auth/onboarding", {
      method: "POST",
      body: JSON.stringify({
        displayName: optional("E2E_TEST_DISPLAY_NAME", "Felipe"),
        householdName: optional("E2E_TEST_HOUSEHOLD_NAME", "HouseMate E2E"),
      }),
    });
    assertResponse("onboarding", result.response);
    result = await requestJson(baseUrl, cookie, "/api/auth/households");
  }
  assertResponse("household lookup", result.response);
  const households = Array.isArray(result.body?.data) ? result.body.data : [];
  if (households.length === 0) throw new Error("E2E household provisioning returned no household.");
  const requestedHouseholdId = process.env.E2E_AGENT_HOUSEHOLD_ID?.trim();
  const selected = requestedHouseholdId
    ? households.find((item) => item.householdId === requestedHouseholdId)
    : households[0];
  if (!selected) throw new Error("E2E_HOUSEHOLD_ID is not available to the authenticated user.");
  const selection = await requestJson(baseUrl, cookie, "/api/auth/household-selection", {
    method: "POST",
    body: JSON.stringify({ householdId: selected.householdId }),
  });
  assertResponse("household selection", selection.response);
  return selected.householdId;
}

async function sendAgent(baseUrl, cookie, message) {
  const requestId = `e2e-${crypto.randomUUID()}`;
  const result = await requestJson(baseUrl, cookie, "/api/agent", {
    method: "POST",
    headers: { "x-e2e-request-id": requestId },
    body: JSON.stringify({ message }),
  });
  const type = result.body?.data?.type ?? result.body?.error?.code ?? "UNKNOWN";
  console.log(JSON.stringify({ requestId, message, status: result.response.status, type }));
  assertResponse("agent request", result.response);
  if (type === "INTERNAL_ERROR" || type === "INTERPRETATION_ERROR") {
    throw new Error(`E2E agent returned ${type}.`);
  }
  return result.body;
}

async function adminUserByEmail(admin, email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("E2E could not list users.");
    const found = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (found) return found;
    if (data.users.length < 1000) return null;
  }
  throw new Error("E2E user lookup exceeded the safety limit.");
}

async function resolveActorMemberId(admin, householdId, email) {
  const authUser = await adminUserByEmail(admin, email);
  if (!authUser) throw new Error("E2E primary Auth user was not found.");
  const user = await admin.from("tb_users").select("id").eq("auth_user_id", authUser.id).single();
  if (user.error) throw new Error("E2E primary application user was not found.");
  const member = await admin.from("tb_household_members").select("id").eq("household_id", householdId).eq("user_id", user.data.id).single();
  if (member.error) throw new Error("E2E actor membership was not found.");
  return member.data.id;
}

async function snapshotScenario(admin, householdId, actorMemberId) {
  const conversationKey = `web:${householdId}:${actorMemberId}`;
  const [proposals, drafts, expenses] = await Promise.all([
    admin.from("tb_pending_proposals").select("id").eq("household_id", householdId).eq("actor_member_id", actorMemberId).eq("conversation_key", conversationKey).eq("source", "WEB"),
    admin.from("tb_agent_category_drafts").select("id").eq("household_id", householdId).eq("actor_member_id", actorMemberId).eq("conversation_key", conversationKey).eq("source", "WEB"),
    admin.from("tb_expenses").select("id").eq("household_id", householdId).eq("created_by", actorMemberId),
  ]);
  if (proposals.error || drafts.error || expenses.error) throw new Error("E2E could not snapshot control state.");
  return {
    proposals: new Set((proposals.data ?? []).map((row) => row.id)),
    drafts: new Set((drafts.data ?? []).map((row) => row.id)),
    expenses: new Set((expenses.data ?? []).map((row) => row.id)),
  };
}

async function recordsCreatedSince(admin, householdId, actorMemberId, before) {
  const after = await snapshotScenario(admin, householdId, actorMemberId);
  return {
    proposals: [...after.proposals].filter((id) => !before.proposals.has(id)),
    drafts: [...after.drafts].filter((id) => !before.drafts.has(id)),
    expenses: [...after.expenses].filter((id) => !before.expenses.has(id)),
  };
}

async function cleanupCreatedRecords(admin, records) {
  for (const id of records.proposals) {
    const result = await admin.from("tb_pending_proposals").delete().eq("id", id);
    if (result.error) throw new Error(`E2E cleanup failed for proposal ${id}.`);
  }
  for (const id of records.drafts) {
    const result = await admin.from("tb_agent_category_drafts").delete().eq("id", id);
    if (result.error) throw new Error(`E2E cleanup failed for draft ${id}.`);
  }
  for (const id of records.expenses) {
    const result = await admin.from("tb_expenses").delete().eq("id", id);
    if (result.error) throw new Error(`E2E cleanup failed for expense ${id}.`);
  }
}

async function validateCreatedRecordsRemoved(admin, records) {
  for (const [table, ids] of [["tb_pending_proposals", records.proposals], ["tb_agent_category_drafts", records.drafts], ["tb_expenses", records.expenses]]) {
    if (ids.length === 0) continue;
    const result = await admin.from(table).select("id").in("id", ids);
    if (result.error || (result.data ?? []).length > 0) throw new Error(`E2E cleanup validation failed for ${table}.`);
  }
}

async function main() {
  const baseUrl = optional("E2E_BASE_URL", "http://localhost:3000").replace(/\/$/, "");
  const supabaseUrl = required("E2E_SUPABASE_URL");
  const anonKey = process.env.E2E_SUPABASE_ANON_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!anonKey) throw new Error("E2E requires E2E_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
  const email = required("E2E_TEST_EMAIL");
  const cookie = await createAuthenticatedCookieHeader({
    supabaseUrl,
    anonKey,
    email,
    password: required("E2E_TEST_PASSWORD"),
  });
  const householdId = await ensureHousehold(baseUrl, cookie);
  const actorMemberId = await resolveActorMemberId(admin, householdId, email);
  const before = await snapshotScenario(admin, householdId, actorMemberId);
  let created = { proposals: [], drafts: [], expenses: [] };
  let testError = null;
  try {
    await sendAgent(baseUrl, cookie, "Gasté $20.000 en una cena");
    created = await recordsCreatedSince(admin, householdId, actorMemberId, before);
  } catch (error) {
    testError = error;
    created = await recordsCreatedSince(admin, householdId, actorMemberId, before);
  } finally {
    try {
      await cleanupCreatedRecords(admin, created);
      await validateCreatedRecordsRemoved(admin, created);
      console.log(JSON.stringify({ controlCleanup: "PASS", created }));
    } catch (cleanupError) {
      console.error(cleanupError instanceof Error ? cleanupError.message : "E2E control cleanup failed.");
      if (!testError) testError = cleanupError;
    }
  }
  if (testError) throw testError;
  console.log(JSON.stringify({ authenticated: true, householdConfigured: Boolean(householdId) }));
  console.log("PASS authenticated Agent control E2E");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "E2E failed.");
    process.exitCode = 1;
  });
}

module.exports = {
  createAuthenticatedCookieHeader,
  requestJson,
  ensureHousehold,
  sendAgent,
};
