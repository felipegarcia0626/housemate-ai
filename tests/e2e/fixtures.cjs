const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");

const FIXTURE_PREFIX = "__housemate_e2e_expense__";
const GENERATED_DIRECTORY = path.join(__dirname, ".generated");
const MANIFEST_PATH = path.join(GENERATED_DIRECTORY, "fixtures.json");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}; browser E2E requires an explicit isolated context and never falls back to the MVP context.`,
    );
  }
  return value;
}

function readE2EContext() {
  const context = {
    supabaseUrl: requiredEnvironment("E2E_SUPABASE_URL"),
    serviceRoleKey: requiredEnvironment("E2E_SUPABASE_SERVICE_ROLE_KEY"),
    householdId: requiredEnvironment("E2E_HOUSEHOLD_ID"),
    allowedHouseholdId: requiredEnvironment("E2E_ALLOWED_HOUSEHOLD_ID"),
    memberId: requiredEnvironment("E2E_MEMBER_ID"),
    allowedProjectRef: requiredEnvironment("E2E_ALLOWED_SUPABASE_PROJECT_REF"),
  };

  let parsedUrl;
  try {
    parsedUrl = new URL(context.supabaseUrl);
  } catch {
    throw new Error("E2E_SUPABASE_URL must be a valid URL.");
  }
  const suffix = ".supabase.co";
  const hostname = parsedUrl.hostname.toLowerCase();
  if (parsedUrl.protocol !== "https:" || !hostname.endsWith(suffix)) {
    throw new Error(
      "E2E_SUPABASE_URL must use an HTTPS Supabase project URL.",
    );
  }

  const projectRef = hostname.slice(0, -suffix.length);
  const allowedProjectRef = context.allowedProjectRef.toLowerCase();
  if (
    !SUPABASE_PROJECT_REF_PATTERN.test(projectRef) ||
    !SUPABASE_PROJECT_REF_PATTERN.test(allowedProjectRef)
  ) {
    throw new Error(
      "E2E Supabase project references must use lowercase letters, numbers and hyphens.",
    );
  }

  if (projectRef !== allowedProjectRef) {
    throw new Error(
      "The configured Supabase project is not authorized for E2E tests.",
    );
  }

  for (const [name, value] of [
    ["E2E_HOUSEHOLD_ID", context.householdId],
    ["E2E_ALLOWED_HOUSEHOLD_ID", context.allowedHouseholdId],
    ["E2E_MEMBER_ID", context.memberId],
  ]) {
    if (!UUID_PATTERN.test(value))
      throw new Error(`${name} must be a valid UUID.`);
  }

  if (context.householdId !== context.allowedHouseholdId) {
    throw new Error(
      "E2E household does not match E2E_ALLOWED_HOUSEHOLD_ID.",
    );
  }

  if (
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID &&
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID === context.householdId
  ) {
    throw new Error(
      "E2E_HOUSEHOLD_ID must not equal HOUSEMATE_MVP_HOUSEHOLD_ID.",
    );
  }

  return { ...context, projectRef };
}

function createE2EClient(context) {
  return createClient(context.supabaseUrl, context.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function assertSupabaseResult(operation, result) {
  if (result.error) {
    const code =
      typeof result.error.code === "string" ? result.error.code : "UNKNOWN";
    throw new Error(`E2E fixture ${operation} failed (${code}).`);
  }
  return result.data;
}

async function findExpenseIds(client, householdId) {
  const result = await client
    .from("tb_expenses")
    .select("id")
    .eq("household_id", householdId)
    .like("merchant", `${FIXTURE_PREFIX}%`);
  const data = assertSupabaseResult("lookup", result);
  return Array.isArray(data) ? data.map((row) => row.id) : [];
}

async function deleteExpenseIds(client, householdId, expenseIds) {
  if (expenseIds.length === 0) return;
  const result = await client
    .from("tb_expenses")
    .delete()
    .eq("household_id", householdId)
    .in("id", expenseIds);
  assertSupabaseResult("cleanup", result);
}

async function cleanupPreviousFixtures(client, householdId) {
  const expenseIds = await findExpenseIds(client, householdId);
  await deleteExpenseIds(client, householdId, expenseIds);
}

async function findMembers(client, householdId, configuredMemberId) {
  const configuredResult = await client
    .from("tb_household_members")
    .select("id")
    .eq("household_id", householdId)
    .eq("id", configuredMemberId)
    .maybeSingle();
  const configured = assertSupabaseResult("member lookup", configuredResult);
  if (!configured) throw new Error("E2E_MEMBER_ID is not in E2E_HOUSEHOLD_ID.");

  const secondResult = await client
    .from("tb_household_members")
    .select("id")
    .eq("household_id", householdId)
    .neq("id", configuredMemberId)
    .limit(1)
    .maybeSingle();
  const second = assertSupabaseResult("second member lookup", secondResult);
  if (!second)
    throw new Error("The E2E household must contain at least two members.");

  return { first: configured.id, second: second.id };
}

async function findExpenseCategory(client) {
  const microResult = await client
    .from("tb_categories")
    .select("id,parent_id")
    .eq("movement_type", "EXPENSE")
    .eq("level", "MICRO")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  const micro = assertSupabaseResult("category lookup", microResult);
  if (!micro?.id || !micro.parent_id)
    throw new Error("No active EXPENSE micro category is available for E2E.");

  const parentResult = await client
    .from("tb_categories")
    .select("id")
    .eq("id", micro.parent_id)
    .eq("movement_type", "EXPENSE")
    .eq("level", "MACRO")
    .eq("is_active", true)
    .maybeSingle();
  const parent = assertSupabaseResult("category parent lookup", parentResult);
  if (!parent)
    throw new Error("The E2E category does not have an active macro parent.");

  return micro.id;
}

async function createExpense(client, {
  householdId,
  memberId,
  categoryId,
  merchant,
  totalAmount,
  expenseDate,
  distributions,
}) {
  const result = await client.rpc("fn_create_expense", {
    p_household_id: householdId,
    p_created_by: memberId,
    p_paid_by: memberId,
    p_category_id: categoryId,
    p_receipt_id: null,
    p_merchant: merchant,
    p_total_amount: totalAmount,
    p_expense_date: expenseDate,
    p_description: `${merchant} description`,
    p_source: "WEB",
    p_items: [],
    p_distributions: distributions,
  });
  const expenseId = assertSupabaseResult("creation", result);
  if (typeof expenseId !== "string" || !UUID_PATTERN.test(expenseId))
    throw new Error("E2E fixture creation returned an invalid expense ID.");
  return expenseId;
}

async function prepareExpenseFixtures() {
  const context = readE2EContext();
  const client = createE2EClient(context);
  await cleanupPreviousFixtures(client, context.householdId);

  const members = await findMembers(
    client,
    context.householdId,
    context.memberId,
  );
  const categoryId = await findExpenseCategory(client);
  const runMarker = `${FIXTURE_PREFIX}${crypto.randomUUID()}`;
  const createdIds = [];

  try {
    const fixtureAId = await createExpense(client, {
      householdId: context.householdId,
      memberId: members.first,
      categoryId,
      merchant: `${runMarker} A`,
      totalAmount: 120000,
      expenseDate: "2026-01-15",
      distributions: [
        { householdMemberId: members.first, amount: 120000, percentage: 100 },
      ],
    });
    createdIds.push(fixtureAId);

    const fixtureBId = await createExpense(client, {
      householdId: context.householdId,
      memberId: members.first,
      categoryId,
      merchant: `${runMarker} B`,
      totalAmount: 100000,
      expenseDate: "2026-01-16",
      distributions: [
        { householdMemberId: members.first, amount: 70000, percentage: 70 },
        { householdMemberId: members.second, amount: 30000, percentage: 30 },
      ],
    });
    createdIds.push(fixtureBId);

    const manifest = {
      householdId: context.householdId,
      memberId: members.first,
      secondMemberId: members.second,
      categoryId,
      runMarker,
      fixtureAId,
      fixtureBId,
    };
    await fs.mkdir(GENERATED_DIRECTORY, { recursive: true });
    await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
    return { context, client, manifest, createdIds };
  } catch (error) {
    await deleteExpenseIds(client, context.householdId, createdIds);
    throw error;
  }
}

async function cleanupExpenseFixtures(fixtures) {
  if (!fixtures) return;
  try {
    await deleteExpenseIds(
      fixtures.client,
      fixtures.context.householdId,
      fixtures.createdIds,
    );
    await fs.rm(MANIFEST_PATH, { force: true });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : "UNKNOWN";
    throw new Error(`E2E fixture cleanup failed (${String(code)}).`);
  }
}

module.exports = {
  FIXTURE_PREFIX,
  MANIFEST_PATH,
  readE2EContext,
  prepareExpenseFixtures,
  cleanupExpenseFixtures,
};
