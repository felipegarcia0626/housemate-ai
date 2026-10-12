const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  createAuthenticatedCookieHeader,
  requestJson,
  ensureHousehold,
} = require("./agent-authenticated.cjs");
const {
  assertWriteE2EContext,
  createE2EClient,
  authorizedAgentHouseholdId,
  assertRecoverableE2EOperation,
  recordReturnedResourceIds,
  requireAdministrativeRecovery,
} = require("./fixtures.cjs");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`E2E requires ${name}`);
  return value;
}

function optional(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

function safeType(body) {
  return body?.data?.type ?? body?.error?.code ?? "UNKNOWN";
}

function safeText(body) {
  return typeof body?.data?.message === "string" ? body.data.message : "";
}

function requestId() {
  return `e2e-${crypto.randomUUID()}`;
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

async function resolveFixtureMembers(admin, householdId, primaryEmail) {
  const primaryAuthUser = await adminUserByEmail(admin, primaryEmail);
  if (!primaryAuthUser) throw new Error("E2E primary Auth user was not found.");
  const users = await admin.from("tb_users").select("id, auth_user_id, display_name").in("auth_user_id", [primaryAuthUser.id]);
  if (users.error || users.data.length !== 1) throw new Error("E2E primary application user was not found.");
  const members = await admin.from("tb_household_members").select("id, user_id, display_name").eq("household_id", householdId);
  if (members.error || members.data.length !== 2) throw new Error("E2E fixture must contain exactly two household members.");
  const actor = members.data.find((member) => member.user_id === users.data[0].id);
  const splitMember = members.data.find((member) => member.display_name === "E2E Split Member");
  if (!actor || !splitMember || actor.id === splitMember.id) throw new Error("E2E fixture members are not configured as expected.");
  return { actor, splitMember };
}

// Snapshots never establish ownership and are not used as a deletion manifest.

async function preflight(admin, householdId, actorMemberId) {
  const conversationKey = `web:${householdId}:${actorMemberId}`;
  const [drafts, proposals] = await Promise.all([
    admin.from("tb_agent_category_drafts").select("id,status,operation_type,conversation_key,source,created_at,updated_at").eq("household_id", householdId).eq("actor_member_id", actorMemberId).eq("conversation_key", conversationKey).eq("source", "WEB"),
    admin.from("tb_pending_proposals").select("id,status,operation_type,conversation_key,source,created_at,updated_at").eq("household_id", householdId).eq("actor_member_id", actorMemberId).eq("conversation_key", conversationKey).eq("source", "WEB"),
  ]);
  if (drafts.error || proposals.error) throw new Error("E2E preflight could not inspect active state.");
  const draftRecords = drafts.data ?? [];
  const proposalRecords = proposals.data ?? [];
  const activeDraftStatuses = new Set(["AWAITING_OPERATION", "AWAITING_DETAILS", "AWAITING_CATEGORY"]);
  const terminalProposalStatuses = new Set(["COMPLETED", "REJECTED"]);
  const records = [
    ...draftRecords.map((record) => ({
      type: "draft",
      state: activeDraftStatuses.has(record.status) ? "active" : "unknown",
      ...record,
    })),
    ...proposalRecords
      .filter((record) => record.status === "AWAITING_CONFIRMATION" || !terminalProposalStatuses.has(record.status))
      .map((record) => ({ type: "proposal", ...record })),
  ];
  if (records.length > 0) {
    console.error("[E2E] FAIL — E2E PREFLIGHT DIRTY STATE");
    for (const record of records) console.error(`[E2E] ${JSON.stringify(record)}`);
    throw new Error("E2E preflight stopped deliberately to avoid deleting potentially legitimate state.");
  }
  console.log("[E2E] PASS — clean state");
}

// Cleanup requires an audited creation/recovery contract before writes can resume.

async function readDiagnostics(requestIdValue) {
  const logPath = path.resolve(".next", "dev", "logs", "next-development.log");
  let log = "";
  try { log = fs.readFileSync(logPath, "utf8"); } catch { return { requestId: requestIdValue, stage: "log_unavailable" }; }
  const lines = log.split(/\r?\n/).filter((line) => line.includes(requestIdValue));
  const matches = lines
    .map((line) => ["failed", "completed", "context_start"].find((stage) => line.includes(`stage\\\\\":\\\\\"${stage}`)))
    .filter(Boolean);
  return { requestId: requestIdValue, stage: matches.at(-1) ?? "not_found" };
}

async function sendTurn(baseUrl, cookie, scenario, turn, message, returnedRecords = []) {
  const id = requestId();
  const result = await requestJson(baseUrl, cookie, "/api/agent", {
    method: "POST",
    headers: { "x-e2e-request-id": id },
    body: JSON.stringify({ message }),
  });
  recordReturnedResourceIds(result.body, returnedRecords);
  const type = safeType(result.body);
  console.log(JSON.stringify({ scenario, turn, requestId: id, status: result.response.status, type }));
  return { ...result, requestId: id, type, diagnostics: await readDiagnostics(id) };
}

function nextReply(result, secondMemberName) {
  const text = safeText(result.body).toLowerCase();
  const fields = Array.isArray(result.body?.data?.missingFields) ? result.body.data.missingFields : [];
  const options = Array.isArray(result.body?.data?.options)
    ? result.body.data.options.filter((option) => typeof option?.name === "string")
    : [];
  if (result.type === "PROPOSAL_CREATED") return "Sí";
  if (result.type === "CONFIRMED" || result.type === "REJECTED") return null;
  if (fields.includes("expenseDate")) return "hoy";
  if (fields.includes("totalAmount")) return "50000";
  if (fields.includes("categoryCreation")) return "no";
  if (fields.some((field) => /split|distrib|member/i.test(field)) || /repart|porcentaje|distribu/i.test(text)) {
    return secondMemberName ? "50% y 50%" : "100% yo";
  }
  if (fields.includes("categoryId") || /categoría|category|micro/i.test(text)) {
    return options[0]?.name ?? "Ropa";
  }
  if (/monto|fecha|amount|date/i.test(text)) return "Monto: 50000 Fecha: 04/10/2026";
  if (result.type === "CLARIFICATION_REQUIRED") return secondMemberName ? "50% y 50%" : "100% yo";
  return null;
}

function responseSummary(result) {
  return {
    status: result.response.status,
    type: result.type,
    missingFields: Array.isArray(result.body?.data?.missingFields) ? result.body.data.missingFields : [],
    proposalCreated: result.type === "PROPOSAL_CREATED",
    confirmed: result.type === "CONFIRMED",
  };
}

async function drive(baseUrl, cookie, scenario, initial, secondMemberName, maxTurns = 8, returnedRecords = []) {
  const turns = [];
  let result = await sendTurn(baseUrl, cookie, scenario, 1, initial, returnedRecords);
  turns.push(result);
  for (let turn = 2; turn <= maxTurns; turn += 1) {
    const reply = nextReply(result, secondMemberName);
    if (!reply) break;
    result = await sendTurn(baseUrl, cookie, scenario, turn, reply, returnedRecords);
    turns.push(result);
    if (result.type === "CONFIRMED" || result.type === "REJECTED") break;
  }
  return turns;
}

async function verifyExpense(admin, householdId, expenseId, expectedSplits) {
  const expense = await admin.from("tb_expenses").select("id, household_id, total_amount, status").eq("id", expenseId).maybeSingle();
  const distributions = await admin.from("tb_expense_distributions").select("household_member_id, amount, percentage").eq("expense_id", expenseId).order("household_member_id");
  if (expense.error || distributions.error || !expense.data) throw new Error("E2E could not verify persisted expense.");
  assert.equal(expense.data.household_id, householdId);
  assert.equal(Number(expense.data.total_amount), 50000);
  assert.equal(expense.data.status, "CONFIRMED");
  assert.equal(distributions.data.length, expectedSplits.length);
  const actual = distributions.data
    .map((row) => ({ memberId: row.household_member_id, percentage: Number(row.percentage) }))
    .sort((a, b) => a.memberId.localeCompare(b.memberId));
  assert.deepEqual(actual, [...expectedSplits].sort((a, b) => a.memberId.localeCompare(b.memberId)));
  assert.equal(distributions.data.reduce((sum, row) => sum + Number(row.amount), 0), 50000);
  for (const row of distributions.data) assert.equal(Number(row.amount), 50000 * Number(row.percentage) / 100);
}

async function main() {
  const writeContext = assertWriteE2EContext();
  authorizedAgentHouseholdId();
  assertRecoverableE2EOperation("agent");
  const baseUrl = optional("E2E_BASE_URL", "http://localhost:3000").replace(/\/$/, "");
  const supabaseUrl = required("E2E_SUPABASE_URL");
  const anonKey = process.env.E2E_SUPABASE_ANON_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!anonKey) throw new Error("E2E requires E2E_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createE2EClient(writeContext);
  const primaryCookie = await createAuthenticatedCookieHeader({ supabaseUrl, anonKey, email: required("E2E_TEST_EMAIL"), password: required("E2E_TEST_PASSWORD") });
  const householdId = await ensureHousehold(baseUrl, primaryCookie);
  if (householdId !== writeContext.householdId) throw new Error("Authenticated user did not select the centrally authorized E2E household.");
  const { actor, splitMember } = await resolveFixtureMembers(admin, householdId, required("E2E_TEST_EMAIL"));
  await preflight(admin, householdId, actor.id);
  const allScenarioRecords = [];
  let primaryError = null;
  try {
    const caseA = await sendTurn(baseUrl, primaryCookie, "A", 1, "Gasté $50.000 y quiero repartirlo", allScenarioRecords);
    console.log(JSON.stringify({ scenario: "A", response: responseSummary(caseA), requestId: caseA.requestId, diagnostics: caseA.diagnostics }));
    if (caseA.type !== "CLARIFICATION_REQUIRED") throw new Error(`FAIL — unexpected Case A result (${caseA.type}; request ${caseA.requestId}).`);
    // References were recorded before response assertions; none authorize deletion.

    for (const [name, initial, expected] of [
      ["B", "Gasté $50.000", [{ memberId: actor.id, percentage: 100 }]],
      ["C", `Gasté $50.000 y quiero repartirlo entre ${actor.display_name} y ${splitMember.display_name}`, [
        { memberId: actor.id, percentage: 50 },
        { memberId: splitMember.id, percentage: 50 },
      ]],
    ]) {
      const turns = await drive(baseUrl, primaryCookie, name, initial, name === "C" ? splitMember.display_name : null, 8, allScenarioRecords);
      const confirmed = turns.find((turn) => turn.type === "CONFIRMED");
      const expectedTerminal = name === "B" || name === "C";
      if (expectedTerminal && !confirmed) {
        const last = turns.at(-1);
        throw new Error(`FAIL — ${name} did not confirm (${last?.type}; request ${last?.requestId}).`);
      }
      if (confirmed?.body?.data?.expenseId) await verifyExpense(admin, householdId, confirmed.body.data.expenseId, expected);
      console.log(JSON.stringify({ scenario: name, status: turns.at(-1)?.response.status, result: turns.at(-1)?.type, confirmation: Boolean(confirmed), diagnostics: turns.map((turn) => turn.diagnostics) }));
      // No snapshot-derived or unproven resource deletion.
    }
    // A future audited recovery mechanism must account for every returned reference.
    console.log("E2E scenario assertions completed; administrative recovery is still required.");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      requireAdministrativeRecovery(allScenarioRecords, true);
    } catch (recoveryError) {
      if (primaryError) console.error(recoveryError.message);
      else throw recoveryError;
    }
  }
}

if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.message : "E2E failed."); process.exitCode = 1; });

module.exports = { main };
