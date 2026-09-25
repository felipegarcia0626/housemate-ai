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
  "/api/categories/hierarchical?movementType=EXPENSE",
  "/api/categories/hierarchical?movementType=INCOME",
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
  "setExpenseCategories(expenseCategoryResult.value)",
  "setIncomeCategories(incomeCategoryResult.value)",
  'failed("expenseCategories")',
  'failed("incomeCategories")',
  "expenseMacros",
  "expenseMicros",
  "incomeMacros",
  "incomeMicros",
  "incomeCategoryLabel",
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
  '"PROPOSAL_UPDATED"',
  "presentUpdatedProposal",
  "operationType",
  "payload?.expense",
  "payload?.income",
  "Propuesta actualizada",
  'Responde "Sí" para confirmar o "No" para rechazar.',
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

const updatedProposalStart = page.indexOf("function presentUpdatedProposal");
const updatedProposalEnd = page.indexOf(
  "function presentAgentResult",
  updatedProposalStart,
);
if (updatedProposalStart < 0 || updatedProposalEnd < updatedProposalStart)
  throw new Error("Missing Web PROPOSAL_UPDATED presentation");
const updatedProposalSource = page.slice(
  updatedProposalStart,
  updatedProposalEnd,
);
for (const marker of [
  "expense.totalAmount",
  "expense.expenseDate",
  "expense.description",
  "expense.categoryId",
  "expense.paidByMemberId",
  "income.amount",
  "income.incomeDate",
  "income.description",
  "income.categoryId",
  "income.memberId",
  "categories.find",
  "members.find",
]) {
  if (!updatedProposalSource.includes(marker))
    throw new Error(`Missing Web corrected proposal field: ${marker}`);
}
if (updatedProposalSource.includes("proposalId"))
  throw new Error("Web corrected proposal must not render proposal IDs");
if (updatedProposalSource.includes("JSON.stringify"))
  throw new Error("Web corrected proposal must not render technical JSON");
console.log(
  "PASS Web PROPOSAL_UPDATED renders corrected fields without technical identifiers",
);

if (!page.includes("Total:"))
  throw new Error("Expense presentation must include a human-readable total");
for (const marker of ["Encontr", "No encontr", "Estas son las categor"]) {
  if (!page.includes(marker))
    throw new Error(`Missing human-readable Agent presentation: ${marker}`);
}

const initialExpenseStart = page.indexOf("const initialExpense = {");
const initialExpenseEnd = page.indexOf("};", initialExpenseStart);
if (initialExpenseStart < 0 || initialExpenseEnd < initialExpenseStart)
  throw new Error("Missing Expense creation initial state");
const initialExpenseSource = page.slice(initialExpenseStart, initialExpenseEnd);
if (!initialExpenseSource.includes('description: ""'))
  throw new Error("Expense creation description must start empty");

const creationFormStart = page.indexOf(
  '<form className="panel form" onSubmit={submitExpense}>',
);
const creationFormEnd = page.indexOf("</form>", creationFormStart);
if (creationFormStart < 0 || creationFormEnd < creationFormStart)
  throw new Error("Missing Expense creation form");
const creationFormSource = page.slice(creationFormStart, creationFormEnd);
for (const marker of [
  "Descripción",
  "<textarea",
  "value={expenseForm.description}",
  "description: e.target.value",
  "Categoría principal del gasto",
  "Categoría específica del gasto",
  "expenseMacros.map((macro)",
  "expenseMicros.map((category)",
  "setExpenseMacroId(e.target.value)",
  "categoryId: \"\"",
  "expenseMacroId === \"\"",
]) {
  if (!creationFormSource.includes(marker))
    throw new Error(`Missing Expense creation description marker: ${marker}`);
}

const submitExpenseStart = page.indexOf("async function submitExpense");
const submitExpenseEnd = page.indexOf(
  "async function startExpenseEdit",
  submitExpenseStart,
);
if (submitExpenseStart < 0 || submitExpenseEnd < submitExpenseStart)
  throw new Error("Missing Expense creation submit handler");
const submitExpenseSource = page.slice(submitExpenseStart, submitExpenseEnd);
for (const marker of [
  'method: "POST"',
  "body: JSON.stringify({",
  "description: expenseForm.description || null",
]) {
  if (!submitExpenseSource.includes(marker))
    throw new Error(`Missing Expense creation payload marker: ${marker}`);
}
console.log(
  "PASS Expense creation UI initializes, edits, and submits optional description",
);

const incomeCreationFormStart = page.indexOf(
  '<form className="panel form" onSubmit={submitIncome}>',
);
const incomeCreationFormEnd = page.indexOf("</form>", incomeCreationFormStart);
if (
  incomeCreationFormStart < 0 ||
  incomeCreationFormEnd < incomeCreationFormStart
)
  throw new Error("Missing Income creation form");
const incomeCreationFormSource = page.slice(
  incomeCreationFormStart,
  incomeCreationFormEnd,
);
for (const marker of [
  "Categoría principal del ingreso",
  "Categoría específica del ingreso",
  "incomeMacros.map((macro)",
  "incomeMicros.map((category)",
  "setIncomeMacroId(e.target.value)",
  'categoryId: ""',
  'incomeMacroId === ""',
]) {
  if (!incomeCreationFormSource.includes(marker))
    throw new Error(`Missing Income creation hierarchy marker: ${marker}`);
}
if (incomeCreationFormSource.includes("categories.map((category)"))
  throw new Error("Income creation must not use the flat category list");

const submitIncomeStart = page.indexOf("async function submitIncome");
const submitIncomeEnd = page.indexOf(
  "function startIncomeEdit",
  submitIncomeStart,
);
if (submitIncomeStart < 0 || submitIncomeEnd < submitIncomeStart)
  throw new Error("Missing Income creation submit handler");
const submitIncomeSource = page.slice(submitIncomeStart, submitIncomeEnd);
for (const marker of [
  'method: "POST"',
  '"/api/incomes"',
  "body: JSON.stringify({",
  "categoryId: incomeForm.categoryId || null",
]) {
  if (!submitIncomeSource.includes(marker))
    throw new Error(`Missing Income creation payload marker: ${marker}`);
}
if (submitIncomeSource.includes("categoryId: incomeMacroId"))
  throw new Error("Income creation must not submit a macro category ID");
console.log(
  "PASS Income creation UI loads typed hierarchy and submits only the selected micro",
);

for (const marker of [
  "expenseCategoryLabel(expense.category)",
  "Categoría histórica:",
  "editExpenseLegacyCategoryName",
  "editExpenseMacroId",
  "editExpenseMicros",
]) {
  if (!page.includes(marker))
    throw new Error(`Missing hierarchical Expense edit/list marker: ${marker}`);
}
console.log(
  "PASS Expense UI renders hierarchical categories and preserves legacy fallback",
);

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

for (const marker of [
  "incomeCategoryLabel(income.categoryId)",
  "startIncomeEdit(income)",
  "editingIncome === income.id",
  "saveIncome(income.id)",
  "editIncomeMacroId",
  "editIncomeMicros",
  "editIncomeLegacyCategoryName",
  "Categoría histórica:",
]) {
  if (!page.includes(marker))
    throw new Error(`Missing hierarchical Income edit/list marker: ${marker}`);
}

const incomeEditStart = page.indexOf("function startIncomeEdit");
const incomeSaveStart = page.indexOf("async function saveIncome");
const incomeCancelStart = page.indexOf(
  "function cancelIncomeEdit",
  incomeSaveStart,
);
if (
  incomeEditStart < 0 ||
  incomeSaveStart < incomeEditStart ||
  incomeCancelStart < incomeSaveStart
)
  throw new Error("Missing Income Update UI handlers");
const incomeEditSource = page.slice(incomeEditStart, incomeSaveStart);
for (const marker of [
  "income.memberId",
  "income.amount",
  "income.incomeDate",
  "income.description",
  "income.categoryId",
  "setEditIncomeMacroId",
  "setEditIncomeLegacyCategoryName",
]) {
  if (!incomeEditSource.includes(marker))
    throw new Error(`Missing Income edit hydration marker: ${marker}`);
}
const incomeSaveSource = page.slice(incomeSaveStart, incomeCancelStart);
for (const marker of [
  'method: "PATCH"',
  "`/api/incomes/${incomeId}`",
  "memberId: editIncomeForm.memberId",
  "amount: Number(editIncomeForm.amount)",
  "incomeDate: editIncomeForm.incomeDate",
  "description: editIncomeForm.description",
  "categoryId: editIncomeForm.categoryId || null",
  "await refresh()",
]) {
  if (!incomeSaveSource.includes(marker))
    throw new Error(`Missing Income Update payload marker: ${marker}`);
}
if (incomeSaveSource.includes("categoryId: editIncomeMacroId"))
  throw new Error("Income Update must not submit a macro category ID");
console.log(
  "PASS Income UI renders hierarchical labels, hydrates edits, and sends contractual PATCH fields",
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
