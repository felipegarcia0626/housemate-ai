const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const householdA = "36000000-0000-4000-8000-000000000001";
const householdB = "36000000-0000-4000-8000-000000000002";
const memberA1 = "36000000-0000-4000-8000-000000000021";
const memberA2 = "36000000-0000-4000-8000-000000000022";
const memberB = "36000000-0000-4000-8000-000000000023";
const categoryFood = "36000000-0000-4000-8000-000000000031";
const categoryHome = "36000000-0000-4000-8000-000000000032";

let incomeRows = [
  {
    household_id: householdA,
    member_id: memberA1,
    amount: "1000.01",
    income_date: "2026-08-01",
  },
  {
    household_id: householdA,
    member_id: memberA1,
    amount: "0.02",
    income_date: "2026-08-02",
  },
  {
    household_id: householdA,
    member_id: memberA2,
    amount: "20.03",
    income_date: "2026-08-03",
  },
  {
    household_id: householdA,
    member_id: memberA2,
    amount: "7.00",
    income_date: "2026-07-31",
  },
  {
    household_id: householdB,
    member_id: memberB,
    amount: "9999.99",
    income_date: "2026-08-02",
  },
];
let expenseRows = [
  {
    household_id: householdA,
    status: "CONFIRMED",
    expense_date: "2026-08-01",
    total_amount: "100.01",
    category_id: categoryHome,
    category: { id: categoryHome, name: "Home" },
    items: [
      {
        total_amount: "30.00",
        category_id: categoryFood,
        category: { id: categoryFood, name: "Food" },
      },
      { total_amount: "10.00", category_id: null, category: null },
    ],
  },
  {
    household_id: householdA,
    status: "CONFIRMED",
    expense_date: "2026-08-03",
    total_amount: "20.03",
    category_id: null,
    category: null,
    items: [
      {
        total_amount: "20.02",
        category_id: categoryFood,
        category: { id: categoryFood, name: "Food" },
      },
    ],
  },
  {
    household_id: householdA,
    status: "PENDING",
    expense_date: "2026-08-02",
    total_amount: "500.00",
    category_id: null,
    category: null,
    items: [],
  },
  {
    household_id: householdA,
    status: "CONFIRMED",
    expense_date: "2026-08-02",
    total_amount: "3.00",
    category_id: categoryHome,
    category: { id: categoryHome, name: "Home" },
    items: [],
  },
  {
    household_id: householdA,
    status: "CONFIRMED",
    expense_date: "2026-08-02",
    total_amount: "4.00",
    category_id: null,
    category: null,
    items: [],
  },
  {
    household_id: householdA,
    status: "CANCELLED",
    expense_date: "2026-08-02",
    total_amount: "600.00",
    category_id: null,
    category: null,
    items: [],
  },
  {
    household_id: householdB,
    status: "CONFIRMED",
    expense_date: "2026-08-02",
    total_amount: "700.00",
    category_id: null,
    category: null,
    items: [],
  },
];

const observedQueries = [];
let failedTable = null;

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.writeAttempted = false;
  }

  select(columns) {
    this.columns = columns;
    return this;
  }
  eq(column, value) {
    this.filters.push({ operator: "eq", column, value });
    return this;
  }
  gte(column, value) {
    this.filters.push({ operator: "gte", column, value });
    return this;
  }
  lte(column, value) {
    this.filters.push({ operator: "lte", column, value });
    return this;
  }
  insert() {
    this.writeAttempted = true;
    throw new Error("Unexpected write");
  }
  update() {
    this.writeAttempted = true;
    throw new Error("Unexpected write");
  }
  delete() {
    this.writeAttempted = true;
    throw new Error("Unexpected write");
  }

  then(resolve, reject) {
    observedQueries.push({
      table: this.table,
      columns: this.columns,
      filters: [...this.filters],
    });
    if (this.table === failedTable) {
      return Promise.resolve({
        data: null,
        error: { message: "sensitive database detail", url: "secret" },
      }).then(resolve, reject);
    }
    let rows = this.table === "tb_incomes" ? incomeRows : expenseRows;
    rows = rows.filter((row) =>
      this.filters.every((filter) => {
        if (filter.operator === "eq")
          return row[filter.column] === filter.value;
        if (filter.operator === "gte")
          return row[filter.column] >= filter.value;
        return row[filter.column] <= filter.value;
      }),
    );
    const projected = rows.map((row) => {
      if (this.table === "tb_incomes")
        return { member_id: row.member_id, amount: row.amount };
      return {
        total_amount: row.total_amount,
        category_id: row.category_id,
        category: row.category,
        items: row.items,
      };
    });
    return Promise.resolve({ data: projected, error: null }).then(
      resolve,
      reject,
    );
  }
}

const fakeClient = {
  from(table) {
    assert.ok(
      table === "tb_incomes" || table === "tb_expenses",
      `Unexpected table: ${table}`,
    );
    return new FakeQuery(table);
  },
};

const moduleCache = new Map();
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
function resolveTypeScriptModule(specifier, parentFile) {
  if (specifier.startsWith("@/"))
    return path.join(root, `${specifier.slice(2)}.ts`);
  if (specifier.startsWith("."))
    return path.resolve(path.dirname(parentFile), `${specifier}.ts`);
  return null;
}
function loadTypeScriptModule(filename) {
  const resolved = path.resolve(filename);
  if (resolved === clientModule)
    return { getSupabaseAdminClient: () => fakeClient };
  if (moduleCache.has(resolved)) return moduleCache.get(resolved).exports;
  const loadedModule = { exports: {} };
  moduleCache.set(resolved, loadedModule);
  const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: resolved,
  }).outputText;
  const localRequire = (specifier) => {
    const typescriptModule = resolveTypeScriptModule(specifier, resolved);
    return typescriptModule
      ? loadTypeScriptModule(typescriptModule)
      : require(specifier);
  };
  new Function("require", "module", "exports", output)(
    localRequire,
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

async function expectDomainError(name, operation, code) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.code, code, `${name}: unexpected code`);
    return error;
  }
  assert.fail(`${name}: expected ${code}`);
}

function normalize(result) {
  return {
    ...result,
    memberIncome: [...result.memberIncome].sort((a, b) =>
      a.memberId.localeCompare(b.memberId),
    ),
    byCategory: [...result.byCategory].sort((a, b) =>
      String(a.categoryId).localeCompare(String(b.categoryId)),
    ),
  };
}

async function main() {
  const { getDashboard } = loadTypeScriptModule(
    path.join(root, "modules", "dashboard", "dashboard.service.ts"),
  );
  const { calculateDashboard } = loadTypeScriptModule(
    path.join(root, "modules", "dashboard", "dashboard-calculator.ts"),
  );
  const expected = {
    totalIncome: 1020.06,
    totalSpent: 127.04,
    netAmount: 893.02,
    expenseCount: 4,
    memberIncome: [
      { memberId: memberA1, amount: 1000.03 },
      { memberId: memberA2, amount: 20.03 },
    ],
    byCategory: [
      { categoryId: null, categoryName: null, amount: 4.01 },
      { categoryId: categoryFood, categoryName: "Food", amount: 50.02 },
      { categoryId: categoryHome, categoryName: "Home", amount: 73.01 },
    ],
  };

  const result = await getDashboard(
    { householdId: householdA },
    { from: "2026-08-01", to: "2026-08-03" },
  );
  assert.deepEqual(normalize(result), normalize(expected));
  assert.equal(Object.keys(result).length, 6);
  assert.equal(observedQueries.length, 2);
  assert.deepEqual(
    observedQueries.map((query) => query.table),
    ["tb_incomes", "tb_expenses"],
  );
  for (const query of observedQueries) {
    assert.ok(
      query.filters.some(
        (filter) =>
          filter.column === "household_id" && filter.value === householdA,
      ),
    );
    assert.ok(query.filters.some((filter) => filter.operator === "gte"));
    assert.ok(query.filters.some((filter) => filter.operator === "lte"));
  }
  assert.ok(
    observedQueries[1].filters.some(
      (filter) => filter.column === "status" && filter.value === "CONFIRMED",
    ),
  );
  assert.equal(observedQueries[0].columns, "member_id,amount::text");
  assert.ok(observedQueries[1].columns.includes("total_amount::text"));
  assert.ok(observedQueries[1].columns.includes("tb_expense_items"));
  assert.ok(!observedQueries[1].columns.includes("expense_distributions"));
  console.log(
    "PASS contract, inclusive filters, household isolation and approved data sources",
  );

  const originalIncomes = incomeRows;
  const originalExpenses = expenseRows;
  incomeRows = [...incomeRows].reverse();
  expenseRows = [...expenseRows]
    .reverse()
    .map((expense) => ({ ...expense, items: [...expense.items].reverse() }));
  const reordered = await getDashboard(
    { householdId: householdA },
    { from: "2026-08-01", to: "2026-08-03" },
  );
  assert.deepEqual(normalize(reordered), normalize(result));
  incomeRows = originalIncomes;
  expenseRows = originalExpenses;
  console.log(
    "PASS deterministic result across Income, Expense and item order",
  );

  const empty = await getDashboard({
    householdId: "36000000-0000-4000-8000-000000000099",
  });
  assert.deepEqual(empty, {
    totalIncome: 0,
    totalSpent: 0,
    netAmount: 0,
    expenseCount: 0,
    memberIncome: [],
    byCategory: [],
  });
  console.log("PASS empty Dashboard result");

  await expectDomainError(
    "invalid context",
    () => getDashboard({ householdId: "invalid" }),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "missing context",
    () => getDashboard(),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "invalid date",
    () => getDashboard({ householdId: householdA }, { from: "2026-02-30" }),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "invalid range",
    () =>
      getDashboard(
        { householdId: householdA },
        { from: "2026-08-04", to: "2026-08-03" },
      ),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "filter household override",
    () =>
      getDashboard({ householdId: householdA }, { householdId: householdB }),
    "VALIDATION_ERROR",
  );
  for (const unsupportedFilter of [
    "month",
    "year",
    "memberId",
    "categoryId",
    "householdId",
    "foo",
  ]) {
    await expectDomainError(
      `unsupported ${unsupportedFilter} filter`,
      () =>
        getDashboard(
          { householdId: householdA },
          { [unsupportedFilter]: "unexpected" },
        ),
      "VALIDATION_ERROR",
    );
  }
  console.log("PASS context and filter validation");

  failedTable = "tb_expenses";
  const sanitized = await expectDomainError(
    "technical failure",
    () => getDashboard({ householdId: householdA }),
    "PERSISTENCE_ERROR",
  );
  assert.ok(!sanitized.message.includes("sensitive"));
  assert.ok(!sanitized.message.includes("Supabase"));
  failedTable = null;

  const savedAmount = incomeRows[0].amount;
  incomeRows[0].amount = "1.001";
  await expectDomainError(
    "invalid money",
    () => getDashboard({ householdId: householdA }),
    "PERSISTENCE_ERROR",
  );
  incomeRows[0].amount = savedAmount;
  console.log("PASS sanitized repository and monetary integrity errors");

  const largeIncome = incomeRows[0].amount;
  incomeRows[0].amount = "999999999999.99";
  const large = await getDashboard(
    { householdId: householdA },
    { from: "2026-08-01", to: "2026-08-01" },
  );
  assert.equal(large.totalIncome, 999999999999.99);
  incomeRows[0].amount = largeIncome;
  console.log("PASS cents and NUMERIC(14,2) boundary use bigint accumulation");

  assert.throws(
    () =>
      calculateDashboard(
        [],
        [
          {
            totalAmount: "1.00",
            categoryId: null,
            categoryName: null,
            items: [
              {
                totalAmount: "1.01",
                categoryId: categoryFood,
                categoryName: "Food",
              },
            ],
          },
        ],
      ),
    /ExpenseItem total exceeds Expense total/,
  );
  console.log("PASS categorized items cannot exceed Expense total");
  console.log("PASS Dashboard functional checks completed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
