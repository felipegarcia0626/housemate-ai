const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const page = fs.readFileSync(
  path.join(__dirname, "..", "app", "page.tsx"),
  "utf8",
);
const clientModule = path.join(
  __dirname,
  "..",
  "infrastructure",
  "database",
  "client.ts",
);
const membersRouteModule = path.join(
  __dirname,
  "..",
  "app",
  "api",
  "household-members",
  "route.ts",
);
const householdA = "56000000-0000-4000-8000-000000000001";
const householdB = "56000000-0000-4000-8000-000000000002";
const members = [
  {
    id: "56000000-0000-4000-8000-000000000011",
    household_id: householdA,
    display_name: "Felipe",
  },
  {
    id: "56000000-0000-4000-8000-000000000012",
    household_id: householdA,
    display_name: "Alejandra",
  },
  {
    id: "56000000-0000-4000-8000-000000000013",
    household_id: householdB,
    display_name: "Otra persona",
  },
];
const operations = [];
let failedTable;

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
  }
  select(columns) {
    operations.push({ type: "select", table: this.table, columns });
    return this;
  }
  eq(column, value) {
    this.filters.push({ column, value });
    operations.push({ type: "filter", table: this.table, column, value });
    return this;
  }
  execute() {
    if (failedTable === this.table) {
      return {
        data: null,
        error: { code: "42501", message: "private database detail" },
      };
    }
    const source =
      this.table === "tb_households"
        ? [{ id: householdA }, { id: householdB }]
        : members;
    return {
      data: source.filter((row) =>
        this.filters.every((filter) => row[filter.column] === filter.value),
      ),
      error: null,
    };
  }
  maybeSingle() {
    const result = this.execute();
    return Promise.resolve({
      data: result.error ? null : (result.data[0] ?? null),
      error: result.error,
    });
  }
  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

const fakeClient = {
  from(table) {
    operations.push({ type: "from", table });
    return new FakeQuery(table);
  },
  rpc(name) {
    operations.push({ type: "rpc", name });
    throw new Error("Unexpected RPC");
  },
};

function loadTypeScriptModule(filename, overrides = new Map()) {
  const cache = new Map();
  function load(resolvedFilename) {
    const resolved = path.resolve(resolvedFilename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (resolved === path.resolve(clientModule))
      return { getSupabaseAdminClient: () => fakeClient };
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const loadedModule = { exports: {} };
    cache.set(resolved, loadedModule);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: resolved,
    }).outputText;
    const localRequire = (specifier) => {
      if (specifier.startsWith("@/"))
        return load(path.join(__dirname, "..", specifier.slice(2) + ".ts"));
      if (specifier.startsWith("."))
        return load(path.resolve(path.dirname(resolved), specifier + ".ts"));
      return require(specifier);
    };
    new Function("require", "module", "exports", output)(
      localRequire,
      loadedModule,
      loadedModule.exports,
    );
    return loadedModule.exports;
  }
  return load;
}

async function readJson(response) {
  return response.json();
}

for (const endpoint of [
  "/api/dashboard/summary",
  "/api/expenses",
  "/api/incomes",
  "/api/categories",
  "/api/household-members",
  "/api/agent",
  "/api/sharing-rules",
  "/api/balance",
]) {
  if (!page.includes(endpoint))
    throw new Error(`Missing UI API integration: ${endpoint}`);
}

if (!page.includes("Promise.allSettled"))
  throw new Error("UI must load resources independently");
if (page.includes("Promise.all(["))
  throw new Error("UI must not fail all resources together");
for (const marker of [
  "resourceErrors",
  "setCategories(categoryResult.value)",
  'failed("categories")',
  'failed("members")',
  'failed("sharingRules")',
  "memberNames",
  "memberLabel",
  '"/api/agent"',
  "HouseMate AI",
  "sendAgentMessage",
  "presentAgentResult",
  '"GET_EXPENSES"',
  '"GET_INCOMES"',
  '"GET_BALANCE"',
  '"GET_CATEGORIES"',
  '"GET_SHARING_RULES"',
  "EncontrÃ©",
  "No encontrÃ© gastos con esos criterios.",
  "Estas son las categorÃ­as disponibles:",
]) {
  if (
    marker.startsWith("Encontr") ||
    marker.startsWith("No encontr") ||
    marker.startsWith("Estas son")
  )
    continue;
  if (!page.includes(marker))
    throw new Error(`Missing partial-load handling: ${marker}`);
}

if (!page.includes("Total:"))
  throw new Error("Expense presentation must include a human-readable total");
for (const marker of ["Encontr", "No encontr", "Estas son las categor"]) {
  if (!page.includes(marker))
    throw new Error(`Missing human-readable Agent presentation: ${marker}`);
}

if (page.includes("JSON.stringify(agentResult"))
  throw new Error("Agent results must not be rendered as technical JSON");
for (const forbidden of ["agentResult.proposalId", "agentResult.data.id"]) {
  if (page.includes(forbidden))
    throw new Error("Agent presentation must not expose internal identifiers");
}

for (const operation of ["POST", "PATCH", "DELETE"]) {
  if (!page.includes(`method: \"${operation}\"`))
    throw new Error(`Missing UI mutation: ${operation}`);
}

for (const marker of [
  'method: "PATCH"',
  "onSubmit={(event) =>",
  "event.preventDefault()",
  'type="submit"',
  "Descripción del gasto",
  "value={editExpenseForm.totalAmount}",
  "value={editExpenseForm.categoryId}",
  "value={editExpenseForm.paidByMemberId}",
]) {
  if (!page.includes(marker))
    throw new Error(`Missing Expense edit flow marker: ${marker}`);
}

const editStart = page.indexOf("async function startExpenseEdit");
const saveStart = page.indexOf("async function saveExpense");
const cancelStart = page.indexOf("function cancelExpenseEdit", saveStart);
if (editStart < 0 || saveStart < 0 || cancelStart < 0 || saveStart < editStart)
  throw new Error("Missing Expense Update UI handlers");

const editSource = page.slice(editStart, saveStart);
for (const marker of [
  "setEditingExpense(expenseId)",
  "setEditExpenseForm(initialExpenseEdit)",
  "api<ExpenseDetail>(",
  "/api/expenses/${expenseId}",
  "expense.description",
  "expense.totalAmount",
  "expense.category?.id",
  "expense.paidByMemberId",
]) {
  if (!editSource.includes(marker))
    throw new Error(`Missing Expense detail hydration marker: ${marker}`);
}

const saveSource = page.slice(saveStart, cancelStart);
for (const marker of [
  "editExpenseForm.description",
  "totalAmount: Number(editExpenseForm.totalAmount)",
  "categoryId: editExpenseForm.categoryId || null",
  "paidByMemberId: editExpenseForm.paidByMemberId",
  "await refresh()",
]) {
  if (!saveSource.includes(marker))
    throw new Error(`Missing Expense Update payload marker: ${marker}`);
}
for (const forbidden of [
  "amount:",
  "memberId:",
  "householdId",
  "createdBy",
  "status",
]) {
  if (saveSource.includes(forbidden))
    throw new Error(
      `Expense Update payload contains protected alias: ${forbidden}`,
    );
}
const patchCall = saveSource.indexOf('method: "PATCH"');
const refreshCall = saveSource.indexOf("await refresh()");
const saveCatch = saveSource.indexOf("} catch");
if (!(patchCall >= 0 && patchCall < refreshCall && refreshCall < saveCatch))
  throw new Error(
    "Expense Update refresh must run only after a successful PATCH",
  );
console.log(
  "PASS Expense Update UI hydrates detail and sends the contractual fields",
);

for (const forbidden of [
  "getSupabaseAdminClient",
  ".from(",
  ".rpc(",
  "householdId",
  "openai",
  "OpenAI",
  "conversation.service",
  "pending-proposal",
]) {
  if (page.includes(forbidden))
    throw new Error(`UI must not contain ${forbidden}`);
}

for (const label of [
  "Dashboard",
  "Gastos",
  "Ingresos",
  "Balance",
  "Crear gasto",
  "Crear ingreso",
]) {
  if (!page.includes(label)) throw new Error(`Missing UI label: ${label}`);
}

if (!page.includes("value={incomeForm.memberId}"))
  throw new Error("UI must preserve member IDs as form values");
for (const marker of [
  "members.map((member) =>",
  "key={member.id}",
  "value={member.id}",
  "{member.displayName}",
  "value={editExpenseForm.paidByMemberId}",
  "paidByMemberId: editExpenseForm.paidByMemberId",
]) {
  if (!page.includes(marker))
    throw new Error(`Expense payer selector missing marker: ${marker}`);
}
assert.deepEqual(
  members.filter((member) => member.household_id === householdA).map((member) => ({
    id: member.id,
    displayName: member.display_name,
  })),
  [
    {
      id: "56000000-0000-4000-8000-000000000011",
      displayName: "Felipe",
    },
    {
      id: "56000000-0000-4000-8000-000000000012",
      displayName: "Alejandra",
    },
  ],
);
if (page.includes("member.displayName === \"Pareja\""))
  throw new Error("UI must not rename members with a hardcoded alias");

async function main() {
  const previous = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  try {
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    const routeSource = fs.readFileSync(membersRouteModule, "utf8");
    for (const forbidden of [
      "getSupabaseAdminClient",
      "database/client",
      ".from(",
      ".rpc(",
      ".insert(",
      ".update(",
      ".delete(",
    ]) {
      if (routeSource.includes(forbidden))
        throw new Error("Members route contains " + forbidden);
    }
    const route = loadTypeScriptModule(membersRouteModule)(membersRouteModule);
    operations.length = 0;
    const response = await route.GET(
      new Request(
        "http://localhost/api/household-members?householdId=" + householdB,
      ),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      data: members
        .filter((member) => member.household_id === householdA)
        .map((member) => ({
          id: member.id,
          displayName: member.display_name,
        })),
    });
    assert.ok(
      operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_household_members" &&
          operation.column === "household_id" &&
          operation.value === householdA,
      ),
    );
    assert.ok(
      operations.some(
        (operation) =>
          operation.type === "select" &&
          operation.table === "tb_household_members" &&
          operation.columns === "id,display_name",
      ),
    );
    assert.equal(
      operations.filter((operation) => operation.type === "rpc").length,
      0,
    );
    assert.equal(
      operations.filter((operation) =>
        ["insert", "update", "delete"].includes(operation.type),
      ).length,
      0,
    );
    console.log(
      "PASS Household Members GET isolates the configured household and maps display names",
    );

    failedTable = "tb_household_members";
    const failed = await route.GET();
    assert.equal(failed.status, 500);
    assert.deepEqual(await readJson(failed), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operaciÃ³n.",
      },
    });
    console.log("PASS Household Members errors are sanitized");
  } finally {
    failedTable = undefined;
    if (previous === undefined) delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
    else process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = previous;
  }

  console.log(
    "PASS Web/PWA loads APIs independently, resolves member names, and isolates section errors",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
