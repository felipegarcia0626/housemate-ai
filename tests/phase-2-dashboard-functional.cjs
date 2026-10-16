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
  const dashboardPresentation = loadTypeScriptModule(
    path.join(root, "modules", "dashboard", "dashboard-presentation.ts"),
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

  const monthEndRanges = dashboardPresentation.buildDashboardPeriodRanges(
    "month-to-date",
    new Date(2026, 9, 31, 12),
  );
  assert.deepEqual(monthEndRanges.current, {
    from: "2026-10-01",
    to: "2026-10-31",
  });
  assert.deepEqual(monthEndRanges.previous, {
    from: "2026-09-01",
    to: "2026-09-30",
  });
  console.log("PASS month comparison clamps to the prior month's last day");

  const rollingRanges = dashboardPresentation.buildDashboardPeriodRanges(
    "last-90-days",
    new Date(2026, 8, 30, 12),
  );
  const daysBetween = (from, to) =>
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1;
  assert.equal(
    daysBetween(rollingRanges.current.from, rollingRanges.current.to),
    90,
  );
  assert.equal(
    daysBetween(rollingRanges.previous.from, rollingRanges.previous.to),
    90,
  );
  assert.equal(
    Date.parse(`${rollingRanges.current.from}T00:00:00Z`) -
      Date.parse(`${rollingRanges.previous.to}T00:00:00Z`),
    86_400_000,
  );
  console.log("PASS rolling periods compare exact consecutive 90-day windows");

  const leapYearRanges = dashboardPresentation.buildDashboardPeriodRanges(
    "year-to-date",
    new Date(2024, 1, 29, 12),
  );
  assert.deepEqual(leapYearRanges.current, {
    from: "2024-01-01",
    to: "2024-02-29",
  });
  assert.deepEqual(leapYearRanges.previous, {
    from: "2023-01-01",
    to: "2023-02-28",
  });
  console.log(
    "PASS year-to-date comparison handles leap day without inventing dates",
  );

  const comparison = dashboardPresentation.compareDashboardAmounts(
    112.35,
    100.0,
  );
  assert.deepEqual(comparison, {
    amount: 12.35,
    percentage: 12.35,
    direction: "increase",
  });
  assert.deepEqual(dashboardPresentation.compareDashboardAmounts(4.25, 0), {
    amount: 4.25,
    percentage: null,
    direction: "increase",
  });
  assert.equal(
    dashboardPresentation.compareDashboardAmounts(0, 0).direction,
    "unchanged",
  );
  console.log(
    "PASS period deltas use cent precision and omit percentages without a base",
  );

  const presentationSummary = {
    totalIncome: 0,
    totalSpent: 100.5,
    netAmount: -100.5,
    expenseCount: 4,
    memberIncome: [],
    byCategory: [
      { categoryId: categoryFood, categoryName: "Food", amount: 60.25 },
      { categoryId: categoryHome, categoryName: "Home", amount: 25.25 },
      {
        categoryId: "36000000-0000-4000-8000-000000000033",
        categoryName: "Transport",
        amount: 10,
      },
      { categoryId: null, categoryName: null, amount: 5 },
    ],
  };
  assert.equal(
    dashboardPresentation.getTopThreeCategorySharePercent(presentationSummary),
    95.02,
  );
  assert.equal(
    dashboardPresentation.getTopThreeCategorySharePercent({
      ...presentationSummary,
      byCategory: [presentationSummary.byCategory[0]],
    }),
    null,
  );
  const categorySlices = dashboardPresentation.getDashboardCategorySlices(
    presentationSummary,
    2,
  );
  assert.deepEqual(
    categorySlices.map(({ categoryName, amount, aggregated }) => ({
      categoryName,
      amount,
      aggregated,
    })),
    [
      { categoryName: "Food", amount: 60.25, aggregated: false },
      { categoryName: "Home", amount: 25.25, aggregated: false },
      { categoryName: "Otras categorías", amount: 15, aggregated: true },
    ],
  );
  assert.equal(
    categorySlices.reduce((total, category) => total + category.amount, 0),
    presentationSummary.totalSpent,
  );
  assert.deepEqual(
    categorySlices.map((category) => category.percentage),
    [59.95, 25.12, 14.93],
  );
  assert.equal(
    categorySlices.reduce((total, category) => total + category.percentage, 0),
    100,
  );
  console.log(
    "PASS category concentration and grouping preserve the backend total",
  );
  const donutSlices =
    dashboardPresentation.getDashboardDonutSlices(presentationSummary);
  assert.deepEqual(
    donutSlices.map(({ amount }) => amount),
    [60.25, 25.25, 10, 5],
  );
  assert.deepEqual(
    dashboardPresentation.getDashboardDonutSlices({
      ...presentationSummary,
      totalSpent: 0,
      byCategory: [],
    }),
    [],
  );
  assert.deepEqual(
    dashboardPresentation.getDashboardDonutSlices({
      ...presentationSummary,
      byCategory: [presentationSummary.byCategory[0]],
    }),
    [],
  );
  assert.deepEqual(
    dashboardPresentation.getDashboardDonutSlices({
      ...presentationSummary,
      byCategory: presentationSummary.byCategory.slice(0, 2),
    }),
    [],
  );
  const offsettingCategories = {
    ...presentationSummary,
    totalSpent: 100,
    byCategory: [
      { categoryId: categoryFood, categoryName: "Food", amount: 120 },
      { categoryId: categoryHome, categoryName: "Home", amount: 10 },
      { categoryId: null, categoryName: null, amount: -30 },
    ],
  };
  assert.deepEqual(
    dashboardPresentation.getDashboardDonutSlices(offsettingCategories),
    [],
  );
  assert.deepEqual(
    dashboardPresentation.getDashboardExecutiveInsights(
      offsettingCategories,
      null,
    ),
    [],
  );
  assert.deepEqual(
    dashboardPresentation
      .getDashboardExecutiveInsights(presentationSummary, null)
      .map(({ kind }) => kind),
    ["concentration"],
  );
  assert.deepEqual(
    dashboardPresentation
      .getDashboardExecutiveInsights(
        {
          ...presentationSummary,
          totalIncome: 50,
          netAmount: -50.5,
        },
        {
          ...presentationSummary,
          totalIncome: 70,
          totalSpent: 90,
          byCategory: [
            { categoryId: categoryFood, categoryName: "Food", amount: 50 },
            { categoryId: categoryHome, categoryName: "Home", amount: 25 },
            {
              categoryId: "36000000-0000-4000-8000-000000000033",
              categoryName: "Transport",
              amount: 10,
            },
            { categoryId: null, categoryName: null, amount: 5 },
          ],
        },
      )
      .map(({ kind }) => kind),
    ["concentration", "category-change", "opposing-trends"],
  );
  assert.deepEqual(
    dashboardPresentation.getDashboardExecutiveInsights(
      {
        ...presentationSummary,
        totalSpent: 0,
        byCategory: [],
      },
      null,
    ),
    [],
  );
  assert.deepEqual(
    dashboardPresentation.getDashboardExecutiveInsights(
      {
        ...presentationSummary,
        totalSpent: 60.25,
        byCategory: [presentationSummary.byCategory[0]],
      },
      null,
    ),
    [],
  );
  assert.deepEqual(
    dashboardPresentation
      .getDashboardExecutiveInsights(presentationSummary, {
        ...presentationSummary,
        byCategory: [
          { ...presentationSummary.byCategory[0], amount: 60.24 },
          { ...presentationSummary.byCategory[1], amount: 25.26 },
          ...presentationSummary.byCategory.slice(2),
        ],
      })
      .map(({ kind }) => kind),
    ["concentration"],
  );
  console.log(
    "PASS donut eligibility and executive insights use complete categories and deterministic comparisons",
  );

  const previousPresentationSummary = {
    ...presentationSummary,
    totalSpent: 102,
    netAmount: -102,
    byCategory: [
      { categoryId: categoryFood, categoryName: "Food", amount: 60 },
      { categoryId: categoryHome, categoryName: "Home", amount: 30 },
      {
        categoryId: "36000000-0000-4000-8000-000000000033",
        categoryName: "Transport",
        amount: 8,
      },
      { categoryId: null, categoryName: null, amount: 4 },
    ],
  };
  const expenseBridge = dashboardPresentation.getDashboardExpenseBridge(
    {
      ...presentationSummary,
      totalSpent: 52.1,
      byCategory: [
        { categoryId: categoryFood, categoryName: "Food", amount: 50 },
        { categoryId: categoryHome, categoryName: "Home", amount: 2.1 },
      ],
    },
    { ...previousPresentationSummary, totalSpent: 0, byCategory: [] },
  );
  assert.deepEqual(
    expenseBridge?.steps.map(({ changeAmount, fromAmount, toAmount }) => ({
      changeAmount,
      fromAmount,
      toAmount,
    })),
    [
      { changeAmount: 50, fromAmount: 0, toAmount: 50 },
      { changeAmount: 2.1, fromAmount: 50, toAmount: 52.1 },
    ],
  );
  assert.equal(expenseBridge?.currentAmount, 52.1);
  assert.equal(
    dashboardPresentation.getDashboardExpenseBridge(
      {
        ...presentationSummary,
        totalSpent: 60,
        byCategory: [
          { categoryId: categoryFood, categoryName: "Food", amount: 50 },
        ],
      },
      { ...previousPresentationSummary, totalSpent: 10, byCategory: [] },
    ),
    null,
  );
  console.log(
    "PASS expense bridge reconciles exact category changes or remains unavailable",
  );
  const categoryChange =
    dashboardPresentation.getLargestDashboardCategoryChange(
      presentationSummary,
      previousPresentationSummary,
    );
  assert.deepEqual(categoryChange, {
    categoryId: categoryHome,
    categoryName: "Home",
    currentAmount: 25.25,
    previousAmount: 30,
    changeAmount: -4.75,
    direction: "decrease",
  });
  const categoryComparison =
    dashboardPresentation.getDashboardCategoryComparisonSlices(
      {
        ...presentationSummary,
        totalSpent: 14.84,
        byCategory: [
          { categoryId: categoryFood, categoryName: "Food", amount: 12.34 },
          { categoryId: categoryHome, categoryName: "New", amount: 2.5 },
        ],
      },
      {
        ...previousPresentationSummary,
        totalSpent: 14,
        byCategory: [
          { categoryId: categoryFood, categoryName: "Food", amount: 10 },
          {
            categoryId: "36000000-0000-4000-8000-000000000033",
            categoryName: "Disappeared",
            amount: 4,
          },
        ],
      },
      2,
    );
  assert.deepEqual(
    categoryComparison.map(
      ({
        categoryName,
        currentAmount,
        previousAmount,
        changeAmount,
        percentageChange,
        aggregated,
      }) => ({
        categoryName,
        currentAmount,
        previousAmount,
        changeAmount,
        percentageChange,
        aggregated,
      }),
    ),
    [
      {
        categoryName: "Disappeared",
        currentAmount: 0,
        previousAmount: 4,
        changeAmount: -4,
        percentageChange: -100,
        aggregated: false,
      },
      {
        categoryName: "New",
        currentAmount: 2.5,
        previousAmount: 0,
        changeAmount: 2.5,
        percentageChange: null,
        aggregated: false,
      },
      {
        categoryName: "Otras categorías",
        currentAmount: 12.34,
        previousAmount: 10,
        changeAmount: 2.34,
        percentageChange: 23.4,
        aggregated: true,
      },
    ],
  );
  assert.equal(
    categoryComparison.reduce((sum, item) => sum + item.currentAmount, 0),
    14.84,
  );
  assert.equal(
    categoryComparison.reduce((sum, item) => sum + item.previousAmount, 0),
    14,
  );
  assert.deepEqual(
    dashboardPresentation.getDashboardCategoryComparisonSlices(
      presentationSummary,
      presentationSummary,
    ),
    [],
  );
  console.log(
    "PASS largest category change is descriptive and includes prior-zero categories",
  );
  console.log(
    "PASS category comparisons include new and removed categories, omit invalid percentages and preserve period totals",
  );

  const activity = dashboardPresentation.buildDashboardActivity(
    [
      {
        id: "expense-older",
        merchant: null,
        description: "Compra anterior",
        totalAmount: 8.25,
        expenseDate: "2026-08-02",
        categoryName: null,
      },
      {
        id: "expense-newer",
        merchant: "Mercado",
        description: null,
        totalAmount: 20,
        expenseDate: "2026-08-10",
        categoryName: "Alimentación · Mercado",
      },
    ],
    [
      {
        id: "income-same-day",
        amount: 50,
        incomeDate: "2026-08-10",
        description: "Salario",
        memberName: "Ana",
      },
      {
        id: "income-newest",
        amount: 75,
        incomeDate: "2026-08-11",
        description: "Honorarios",
        memberName: "Luis",
      },
    ],
    3,
  );
  assert.deepEqual(
    activity.map(({ id, kind }) => ({ id, kind })),
    [
      { id: "income-newest", kind: "income" },
      { id: "expense-newer", kind: "expense" },
      { id: "income-same-day", kind: "income" },
    ],
  );
  assert.equal(activity[1].title, "Mercado");
  assert.equal(activity[1].detail, "Alimentación · Mercado");
  assert.equal(
    dashboardPresentation.buildDashboardActivity([], [], 0).length,
    0,
  );
  console.log(
    "PASS mixed activity is date-sorted, bounded and keeps income/expense distinct",
  );

  assert.deepEqual(
    dashboardPresentation.validateDashboardDateRange(
      "2026-08-01",
      "2026-08-31",
    ),
    { valid: true, range: { from: "2026-08-01", to: "2026-08-31" } },
  );
  assert.equal(
    dashboardPresentation.validateDashboardDateRange("2026-02-30", "2026-03-01")
      .valid,
    false,
  );
  assert.equal(
    dashboardPresentation.validateDashboardDateRange("2026-08-02", "2026-08-01")
      .valid,
    false,
  );
  assert.equal(
    dashboardPresentation.validateDashboardDateRange("", "2026-08-01").valid,
    false,
  );
  console.log(
    "PASS custom date range validates calendar dates, completeness and order",
  );

  const mayPresets = new Date(2024, 4, 31, 12);
  assert.deepEqual(
    dashboardPresentation.buildDashboardRangePreset(
      "last-12-months",
      mayPresets,
    ),
    { from: "2023-06-01", to: "2024-05-31" },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardRangePreset("this-month", mayPresets),
    { from: "2024-05-01", to: "2024-05-31" },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardRangePreset(
      "previous-month",
      mayPresets,
    ),
    { from: "2024-04-01", to: "2024-04-30" },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardRangePreset("last-30-days", mayPresets),
    { from: "2024-05-02", to: "2024-05-31" },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardRangePreset("last-90-days", mayPresets),
    { from: "2024-03-03", to: "2024-05-31" },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardRangePreset("this-year", mayPresets),
    { from: "2024-01-01", to: "2024-05-31" },
  );
  console.log(
    "PASS date shortcuts produce explicit date-only inclusive ranges",
  );

  const leapComparison = dashboardPresentation.buildDashboardComparisonRanges({
    from: "2024-02-10",
    to: "2024-03-10",
  });
  assert.deepEqual(leapComparison.previous, {
    from: "2024-01-11",
    to: "2024-02-09",
  });
  assert.deepEqual(
    dashboardPresentation.buildDashboardMonthComparisonRanges({
      from: "2026-10-01",
      to: "2026-10-14",
    }).previous,
    { from: "2026-09-01", to: "2026-09-14" },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardMonthComparisonRanges({
      from: "2026-03-01",
      to: "2026-03-31",
    }).previous,
    { from: "2026-02-01", to: "2026-02-28" },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardMonthComparisonRanges({
      from: "2024-03-01",
      to: "2024-03-30",
    }).previous,
    { from: "2024-02-01", to: "2024-02-29" },
  );
  assert.throws(
    () =>
      dashboardPresentation.buildDashboardMonthComparisonRanges({
        from: "2026-10-03",
        to: "2026-10-14",
      }),
    /Monthly comparison requires one calendar month/,
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardPriorYearComparisonRanges({
      from: "2025-11-01",
      to: "2026-10-14",
    }).previous,
    { from: "2024-11-01", to: "2025-10-14" },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardPriorYearComparisonRanges({
      from: "2024-02-01",
      to: "2024-02-29",
    }).previous,
    { from: "2023-02-01", to: "2023-02-28" },
  );
  const yearComparison = dashboardPresentation.buildDashboardComparisonRanges({
    from: "2026-12-20",
    to: "2027-01-10",
  });
  assert.deepEqual(yearComparison.previous, {
    from: "2026-11-28",
    to: "2026-12-19",
  });
  const currentDuration =
    (Date.parse(`${leapComparison.current.to}T00:00:00Z`) -
      Date.parse(`${leapComparison.current.from}T00:00:00Z`)) /
      86_400_000 +
    1;
  const previousDuration =
    (Date.parse(`${leapComparison.previous.to}T00:00:00Z`) -
      Date.parse(`${leapComparison.previous.from}T00:00:00Z`)) /
      86_400_000 +
    1;
  assert.equal(previousDuration, currentDuration);
  console.log(
    "PASS custom comparisons use consecutive equal-length ranges across leap/month/year boundaries",
  );

  // Expense and Income APIs expose date-only columns and apply inclusive gte/lte filters.
  // Therefore the first and last date keys are the whole boundary days, without UTC conversion.
  const boundaryTrend = dashboardPresentation.buildDashboardTrendSeries(
    [
      { date: "2026-12-31", amount: 3.01 },
      { date: "2027-01-02", amount: 1.02 },
      { date: "2026-12-30", amount: 700 },
    ],
    [
      { date: "2026-12-31", amount: 10.05 },
      { date: "2027-01-02", amount: 20.07 },
      { date: "2027-01-03", amount: 800 },
    ],
    { from: "2026-12-31", to: "2027-01-02" },
    "day",
  );
  assert.equal(boundaryTrend.granularity, "day");
  assert.equal(boundaryTrend.points.length, 3);
  assert.deepEqual(
    boundaryTrend.points.map(({ start, end }) => ({ start, end })),
    [
      { start: "2026-12-31", end: "2026-12-31" },
      { start: "2027-01-01", end: "2027-01-01" },
      { start: "2027-01-02", end: "2027-01-02" },
    ],
  );
  assert.equal(boundaryTrend.totalIncome, 30.12);
  assert.equal(boundaryTrend.totalExpenses, 4.03);
  assert.deepEqual(
    boundaryTrend.points.map(({ incomeCount, expenseCount }) => ({
      incomeCount,
      expenseCount,
    })),
    [
      { incomeCount: 1, expenseCount: 1 },
      { incomeCount: 0, expenseCount: 0 },
      { incomeCount: 1, expenseCount: 1 },
    ],
  );
  console.log(
    "PASS daily series includes both boundary dates, ignores outside records and sums exact cents",
  );

  const weeklyTrend = dashboardPresentation.buildDashboardTrendSeries(
    [{ date: "2026-02-15", amount: 7.25 }],
    [{ date: "2026-01-01", amount: 12.75 }],
    { from: "2026-01-01", to: "2026-02-15" },
    "week",
  );
  assert.equal(weeklyTrend.granularity, "week");
  assert.equal(weeklyTrend.totalIncome, 12.75);
  assert.equal(weeklyTrend.totalExpenses, 7.25);
  assert.equal(
    weeklyTrend.points.reduce(
      (total, point) => total + point.incomeCount + point.expenseCount,
      0,
    ),
    2,
  );
  console.log(
    "PASS medium ranges aggregate real records into explicit Monday-based weeks",
  );

  const monthlyTrend = dashboardPresentation.buildDashboardTrendSeries(
    [{ date: "2026-07-31", amount: 15.09 }],
    [
      { date: "2026-01-01", amount: 100.01 },
      { date: "2026-08-01", amount: 2.03 },
    ],
    { from: "2026-01-01", to: "2026-08-01" },
    "month",
  );
  assert.equal(monthlyTrend.granularity, "month");
  assert.equal(monthlyTrend.points.length, 8);
  assert.equal(monthlyTrend.totalIncome, 102.04);
  assert.equal(monthlyTrend.totalExpenses, 15.09);
  assert.equal(monthlyTrend.points.at(-1).incomeCount, 1);
  assert.equal(
    monthlyTrend.points
      .slice(1, 6)
      .every(
        (point) =>
          point.incomeAmount === 0 &&
          point.expenseAmount === 0 &&
          point.incomeCount === 0 &&
          point.expenseCount === 0,
      ),
    true,
  );
  assert.equal(
    dashboardPresentation.formatDashboardTrendBucketLabel(
      monthlyTrend.points[0].start,
      "month",
    ),
    "2026-01",
  );
  assert.equal(
    dashboardPresentation.formatDashboardTrendBucketLabel(
      monthlyTrend.points.at(-1).start,
      "month",
    ),
    "2026-08",
  );
  console.log(
    "PASS long ranges aggregate by month without dropping the last day",
  );
  const expenseSamples = Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, "0");
    return [
      { date: `2025-${month}-03`, amount: 100 + index * 10 },
      { date: `2025-${month}-14`, amount: 50 },
      { date: `2025-${month}-27`, amount: 25 },
    ];
  }).flat();
  const incomeSamples = Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, "0");
    return [
      { date: `2025-${month}-05`, amount: 500 + index * 20 },
      { date: `2025-${month}-20`, amount: 100 },
    ];
  }).flat();
  const populatedMonthlyTrend = dashboardPresentation.buildDashboardTrendSeries(
    expenseSamples,
    incomeSamples,
    { from: "2025-01-01", to: "2025-12-31" },
    "month",
  );
  assert.equal(populatedMonthlyTrend.points.length, 12);
  assert.deepEqual(
    populatedMonthlyTrend.points.map(({ expenseCount, incomeCount }) => [
      expenseCount,
      incomeCount,
    ]),
    Array.from({ length: 12 }, () => [3, 2]),
  );
  assert.equal(populatedMonthlyTrend.points[0].expenseAmount, 175);
  assert.equal(populatedMonthlyTrend.points[11].expenseAmount, 285);
  assert.equal(populatedMonthlyTrend.points[0].incomeAmount, 600);
  assert.equal(populatedMonthlyTrend.points[11].incomeAmount, 820);
  assert.equal(populatedMonthlyTrend.totalExpenses, 2760);
  assert.equal(populatedMonthlyTrend.totalIncome, 8520);
  console.log(
    "PASS populated monthly sample spans twelve months without remote writes",
  );

  const yearlyTrend = dashboardPresentation.buildDashboardTrendSeries(
    [{ date: "2010-01-01", amount: 1 }],
    [{ date: "2020-01-01", amount: 2 }],
    { from: "2010-01-01", to: "2020-01-01" },
    "year",
  );
  assert.equal(yearlyTrend.granularity, "year");
  assert.equal(yearlyTrend.points.length, 11);
  assert.equal(yearlyTrend.totalIncome, 2);
  assert.equal(yearlyTrend.totalExpenses, 1);
  assert.equal(
    yearlyTrend.points
      .slice(1, 10)
      .every(
        (point) =>
          point.incomeAmount === 0 &&
          point.expenseAmount === 0 &&
          point.incomeCount === 0 &&
          point.expenseCount === 0,
      ),
    true,
  );
  assert.deepEqual(yearlyTrend.range, {
    from: "2010-01-01",
    to: "2020-01-01",
  });
  console.log("PASS multi-year ranges use bounded yearly buckets");

  const isoWeekBoundary = dashboardPresentation.buildDashboardTrendSeries(
    [
      { date: "2020-12-31", amount: 1.01 },
      { date: "2021-01-03", amount: 3.03 },
      { date: "2021-01-04", amount: 2.02 },
    ],
    [],
    { from: "2020-12-31", to: "2021-01-04" },
    "week",
  );
  assert.deepEqual(
    isoWeekBoundary.points.map((point) =>
      dashboardPresentation.formatDashboardTrendBucketLabel(
        point.start,
        "week",
      ),
    ),
    ["2020-W53", "2021-W01"],
  );
  assert.deepEqual(isoWeekBoundary.range, {
    from: "2020-12-31",
    to: "2021-01-04",
  });
  assert.equal(isoWeekBoundary.points[0].start, "2020-12-31");
  assert.equal(isoWeekBoundary.points[0].end, "2021-01-03");
  assert.equal(isoWeekBoundary.points[0].expenseCount, 2);
  assert.equal(isoWeekBoundary.points[0].expenseAmount, 4.04);
  assert.equal(isoWeekBoundary.points[1].start, "2021-01-04");
  console.log(
    "PASS ISO weeks identify the week-year across December/January and retain inclusive range edges",
  );

  const quarterBoundary = dashboardPresentation.buildDashboardTrendSeries(
    [
      { date: "2026-03-31", amount: 11.11 },
      { date: "2026-04-01", amount: 22.22 },
    ],
    [],
    { from: "2026-03-31", to: "2026-04-01" },
    "quarter",
  );
  assert.deepEqual(
    quarterBoundary.points.map((point) => ({
      label: dashboardPresentation.formatDashboardTrendBucketLabel(
        point.start,
        "quarter",
      ),
      start: point.start,
      end: point.end,
      amount: point.expenseAmount,
    })),
    [
      {
        label: "2026-Q1",
        start: "2026-03-31",
        end: "2026-03-31",
        amount: 11.11,
      },
      {
        label: "2026-Q2",
        start: "2026-04-01",
        end: "2026-04-01",
        amount: 22.22,
      },
    ],
  );
  const yearQuarterBoundary = dashboardPresentation.buildDashboardTrendSeries(
    [],
    [
      { date: "2026-12-31", amount: 5 },
      { date: "2027-01-01", amount: 6 },
    ],
    { from: "2026-12-31", to: "2027-01-01" },
    "quarter",
  );
  assert.deepEqual(
    yearQuarterBoundary.points.map((point) =>
      dashboardPresentation.formatDashboardTrendBucketLabel(
        point.start,
        "quarter",
      ),
    ),
    ["2026-Q4", "2027-Q1"],
  );
  const yearBoundaryTrend = dashboardPresentation.buildDashboardTrendSeries(
    [],
    [
      { date: "2026-12-31", amount: 5 },
      { date: "2027-01-01", amount: 6 },
    ],
    { from: "2026-12-31", to: "2027-01-01" },
    "year",
  );
  assert.deepEqual(
    yearBoundaryTrend.points.map((point) =>
      dashboardPresentation.formatDashboardTrendBucketLabel(
        point.start,
        "year",
      ),
    ),
    ["2026", "2027"],
  );
  console.log("PASS calendar quarters split at the exact quarter boundary");

  assert.equal(
    dashboardPresentation.formatDashboardTrendBucketLabel("2026-08-09", "day"),
    "2026-08-09",
  );
  assert.equal(
    dashboardPresentation.formatDashboardTrendBucketLabel(
      "2026-08-01",
      "month",
    ),
    "2026-08",
  );
  assert.equal(
    dashboardPresentation.formatDashboardTrendBucketLabel("2026-01-01", "year"),
    "2026",
  );
  const granularityOptions =
    dashboardPresentation.getDashboardTrendGranularityOptions({
      from: "2025-01-01",
      to: "2026-12-31",
    });
  assert.deepEqual(
    granularityOptions.map(({ granularity, available }) => ({
      granularity,
      available,
    })),
    [
      { granularity: "day", available: false },
      { granularity: "week", available: true },
      { granularity: "month", available: true },
      { granularity: "quarter", available: true },
      { granularity: "year", available: true },
    ],
  );
  assert.equal(
    dashboardPresentation
      .getDashboardTrendGranularityOptions({
        from: "2026-08-01",
        to: "2026-08-02",
      })
      .find(({ granularity }) => granularity === "year").available,
    true,
  );
  assert.throws(
    () =>
      dashboardPresentation.buildDashboardTrendSeries(
        [],
        [],
        { from: "2025-01-01", to: "2026-12-31" },
        "day",
      ),
    /point limit/,
  );
  console.log(
    "PASS labels are chronological and long daily ranges are explicitly unavailable without changing selection",
  );

  const dashboardViewSource = fs.readFileSync(
    path.join(root, "components", "dashboard-financial-view.tsx"),
    "utf8",
  );
  const rangeRequestEffect = dashboardViewSource.match(
    /useEffect\(\(\) => \{[\s\S]*?\}, \[ranges, requestKey\]\);/,
  );
  assert.ok(
    rangeRequestEffect,
    "dashboard range requests should have an explicit dependency contract",
  );
  assert.doesNotMatch(rangeRequestEffect[0], /trendGranularity/);
  const granularityControlStart = dashboardViewSource.indexOf(
    'id="dashboard-trend-granularity"',
  );
  assert.notEqual(granularityControlStart, -1);
  const granularityHandlerStart = dashboardViewSource.indexOf(
    "onChange=",
    granularityControlStart,
  );
  const granularityHandlerEnd = dashboardViewSource.indexOf(
    "aria-describedby=",
    granularityControlStart,
  );
  const granularityHandler = dashboardViewSource.slice(
    granularityHandlerStart,
    granularityHandlerEnd,
  );
  assert.match(granularityHandler, /setTrendGranularity/);
  assert.doesNotMatch(
    granularityHandler,
    /setActiveRange|setDraftFrom|setDraftTo/,
  );
  console.log(
    "PASS granularity control preserves the selected range and does not re-fetch range data",
  );
  assert.match(dashboardViewSource, /buildDashboardMemberExpenseDistribution/);
  assert.match(dashboardViewSource, /buildDashboardFinancialComposition/);
  assert.match(dashboardViewSource, /buildDashboardWeekdayDistribution/);
  assert.match(dashboardViewSource, /Array\.isArray\(value\.distributions\)/);
  assert.match(dashboardViewSource, /ids\.has\(id\)/);
  assert.match(dashboardViewSource, /allRows\.length !== total/);
  assert.match(dashboardViewSource, /parte asignada/);
  assert.match(
    dashboardViewSource.replace(/\s+/g, " "),
    /no son partes de un total combinado/i,
  );
  const visualViewStart = dashboardViewSource.indexOf(
    '{viewMode === "visual" && (',
  );
  const analyticViewStart = dashboardViewSource.indexOf(
    '{viewMode === "analytic" && (',
    visualViewStart,
  );
  assert.ok(visualViewStart >= 0 && analyticViewStart > visualViewStart);
  const visualViewSource = dashboardViewSource.slice(
    visualViewStart,
    analyticViewStart,
  );
  const analyticViewSource = dashboardViewSource.slice(analyticViewStart);
  assert.match(visualViewSource, /className="dashboard-executive-metrics"/);
  assert.match(
    dashboardViewSource,
    /useState<DashboardTrendGranularity>\("month"\)/,
  );
  assert.match(
    dashboardViewSource,
    /useState<DashboardRangePreset>\("last-12-months"\)/,
  );
  assert.match(
    dashboardViewSource,
    /buildDashboardMonthComparisonRanges\(activeRange\)/,
  );
  assert.match(
    dashboardViewSource,
    /buildDashboardPriorYearComparisonRanges\(activeRange\)/,
  );
  assert.match(visualViewSource, /id="dashboard-month-picker"/);
  assert.match(visualViewSource, /Volver al panorama de 12 meses/);
  assert.match(visualViewSource, /className="dashboard-donut-layout"/);
  assert.match(
    visualViewSource,
    /<DashboardExpenseBridgeChart bridge=\{expenseBridge\} \/>/,
  );
  assert.match(
    visualViewSource,
    /memberExpenseDistribution\?\.members\.length !== 1/,
  );
  assert.match(visualViewSource, /className="dashboard-executive-insights"/);
  assert.match(
    visualViewSource,
    /Neto del período[\s\S]*?Ingresos[\s\S]*?Gastos confirmados[\s\S]*?Variación del gasto/,
  );
  assert.match(visualViewSource, /<details className="dashboard-visual-more">/);
  assert.match(analyticViewSource, /className="dashboard-analytic-tables"/);
  assert.match(
    analyticViewSource,
    /Movimientos por período[\s\S]*?Gasto por categoría[\s\S]*?Cambio por categoría[\s\S]*?Pago y parte asignada[\s\S]*?Actividad semanal/,
  );
  assert.match(analyticViewSource, /allCategorySlices\.map/);
  assert.match(analyticViewSource, /allCategoryComparisonSlices\.map/);
  assert.match(analyticViewSource, /trendSeries\.points\.map/);
  assert.match(dashboardViewSource, /activeRange && viewMode === "analytic"/);
  const renderedChartContracts = [
    ["temporal trend", /<DashboardTrendChart series=\{trendSeries\} \/>/],
    [
      "horizontal category bars",
      /className="dashboard-category-chart"[\s\S]*?className="dashboard-category-chart-track"/,
    ],
    [
      "divergent period change",
      /className="dashboard-divergent-track"[\s\S]*?category\.changeAmount[\s\S]*?is-increase[\s\S]*?is-decrease/,
    ],
    [
      "payer and assigned distribution",
      /className="dashboard-member-distribution-chart"[\s\S]*?dashboard-member-series-track is-paid[\s\S]*?dashboard-member-series-track is-assigned/,
    ],
    [
      "vertical financial composition",
      /className="dashboard-composition-columns"[\s\S]*?dashboard-composition-column/,
    ],
    [
      "vertical weekday bars",
      /className="dashboard-weekday-columns"[\s\S]*?weekdayDistribution\.days\.map[\s\S]*?dashboard-weekday-column/,
    ],
  ];
  for (const [chartName, contract] of renderedChartContracts) {
    assert.match(
      visualViewSource,
      contract,
      `${chartName} should be rendered in the Visual view`,
    );
  }
  const dashboardStyleSource = fs.readFileSync(
    path.join(root, "app", "globals.css"),
    "utf8",
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-composition-columns\s*\{[^}]*grid-template-columns:\s*repeat\(2,/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-weekday-columns\s*\{[^}]*grid-template-columns:\s*repeat\(7,/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-column-plot\s*\{[^}]*align-items:\s*flex-end/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-divergent-track\s*\{[^}]*position:\s*relative/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-grid-visual-main > \.dashboard-trend-panel\s*\{[^}]*grid-column:\s*1 \/ -1/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-grid-visual-main > \.dashboard-visual-category-panel\s*\{[^}]*grid-column:\s*span 5/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-grid-visual-main > \.dashboard-payer-panel\s*\{[^}]*grid-column:\s*1 \/ -1/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-grid-visual-main > \.dashboard-category-comparison-panel\s*\{[^}]*grid-column:\s*span 7/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-trend-svg\s*\{[^}]*min-width:\s*680px/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-executive-metrics\s*\{[^}]*grid-template-columns:/,
  );
  assert.match(
    dashboardStyleSource,
    /\.dashboard-analytic-tables\s*\{[^}]*grid-template-columns:/,
  );
  assert.match(
    dashboardViewSource,
    /className="dashboard-trend-scroll"[\s\S]*?dashboard-trend-svg/,
  );
  assert.match(
    dashboardViewSource,
    /series\.granularity === "day" && series\.points\.length <= 31/,
  );
  const tabletLayoutStart = dashboardStyleSource.indexOf(
    "@media (max-width: 900px)",
  );
  const mobileLayoutStart = dashboardStyleSource.indexOf(
    "@media (max-width: 720px)",
    tabletLayoutStart,
  );
  assert.ok(tabletLayoutStart >= 0 && mobileLayoutStart > tabletLayoutStart);
  assert.match(
    dashboardStyleSource.slice(tabletLayoutStart, mobileLayoutStart),
    /\.dashboard-grid-visual-main > \*[\s\S]*grid-column:\s*1 \/ -1/,
  );
  assert.match(
    visualViewSource,
    /className="dashboard-composition-columns"[\s\S]*?aria-label=\{`Ingresos y gastos/,
  );
  assert.match(
    visualViewSource,
    /className="dashboard-weekday-columns"[\s\S]*?aria-label=\{`Total de gastos por día de semana/,
  );
  assert.match(
    visualViewSource,
    /title=\{`\$\{bar\.label\} · \$\{money\(bar\.amount\)\}/,
  );
  assert.match(
    visualViewSource,
    /title=\{`\$\{day\.weekday\} · \$\{money\(day\.totalAmount\)\}/,
  );
  assert.match(visualViewSource, /is-no-date/);
  assert.match(visualViewSource, /is-zero/);
  assert.match(visualViewSource, /is-no-expenses/);
  console.log(
    "PASS executive indicators and charts are separate from analytical tables; optional charts are collapsed by default",
  );

  const incomeOnlyTrend = dashboardPresentation.buildDashboardTrendSeries(
    [],
    [{ date: "2026-08-02", amount: 40.01 }],
    { from: "2026-08-01", to: "2026-08-03" },
    "day",
  );
  const expenseOnlyTrend = dashboardPresentation.buildDashboardTrendSeries(
    [{ date: "2026-08-02", amount: 12.34 }],
    [],
    { from: "2026-08-01", to: "2026-08-03" },
    "day",
  );
  const emptyTrend = dashboardPresentation.buildDashboardTrendSeries(
    [],
    [],
    { from: "2026-08-01", to: "2026-08-03" },
    "day",
  );
  assert.equal(incomeOnlyTrend.incomeCount, 1);
  assert.equal(incomeOnlyTrend.expenseCount, 0);
  assert.equal(expenseOnlyTrend.incomeCount, 0);
  assert.equal(expenseOnlyTrend.expenseCount, 1);
  assert.equal(
    emptyTrend.points.every(
      (point) => point.incomeAmount === 0 && point.expenseAmount === 0,
    ),
    true,
  );
  assert.equal(emptyTrend.incomeCount + emptyTrend.expenseCount, 0);
  assert.deepEqual(
    dashboardPresentation.getDashboardTrendExtremes(emptyTrend),
    {
      mostActive: null,
      leastActive: null,
    },
  );
  const movementTrend = dashboardPresentation.buildDashboardTrendSeries(
    [
      { date: "2026-08-01", amount: 0 },
      { date: "2026-08-03", amount: 10 },
    ],
    [{ date: "2026-08-02", amount: 40 }],
    { from: "2026-08-01", to: "2026-08-04" },
    "day",
  );
  const movementExtremes =
    dashboardPresentation.getDashboardTrendExtremes(movementTrend);
  assert.equal(movementExtremes.mostActive.point.start, "2026-08-02");
  assert.equal(movementExtremes.mostActive.movementAmount, 40);
  assert.equal(movementExtremes.leastActive.point.start, "2026-08-01");
  assert.equal(movementExtremes.leastActive.movementAmount, 0);
  assert.equal(movementExtremes.leastActive.recordCount, 1);
  assert.equal(
    movementTrend.points[3].incomeCount + movementTrend.points[3].expenseCount,
    0,
  );
  console.log(
    "PASS empty, income-only and expense-only ranges remain explicit",
  );
  console.log(
    "PASS movement extremes distinguish a zero-valued record from an empty period",
  );

  const payerSlices = dashboardPresentation.buildDashboardPayerDistribution([
    { totalAmount: 100.01, paidBy: { memberId: memberA1, name: "Ana" } },
    { totalAmount: 50.02, paidBy: { memberId: memberA1, name: "Ana" } },
    { totalAmount: 25, paidBy: null },
  ]);
  assert.deepEqual(payerSlices, [
    {
      memberId: memberA1,
      memberName: "Ana",
      amount: 150.03,
      percentage: 85.72,
      expenseCount: 2,
    },
    {
      memberId: null,
      memberName: "Pagador no identificado",
      amount: 25,
      percentage: 14.28,
      expenseCount: 1,
    },
  ]);
  console.log(
    "PASS payer visualization distinguishes payer from member income and retains unidentified amounts",
  );

  const memberExpenseDistribution =
    dashboardPresentation.buildDashboardMemberExpenseDistribution(
      [
        {
          id: "expense-paid-by-ana",
          expenseDate: "2026-08-01",
          totalAmount: 100.01,
          paidBy: { memberId: memberA1, name: "Ana" },
          distributions: [
            { memberId: memberA1, memberName: "Ana", amount: 40.01 },
            { memberId: memberA2, memberName: "Luis", amount: 60 },
          ],
        },
        {
          id: "expense-paid-by-luis",
          expenseDate: "2026-08-02",
          totalAmount: 50.02,
          paidBy: { memberId: memberA2, name: "Luis" },
          distributions: [
            { memberId: memberA2, memberName: "Luis", amount: 50.02 },
          ],
        },
        {
          id: "expense-no-distribution",
          expenseDate: "2026-08-03",
          totalAmount: 25,
          paidBy: null,
          distributions: [],
        },
        {
          id: "expense-outside-range",
          expenseDate: "2026-08-04",
          totalAmount: 999,
          paidBy: { memberId: memberA1, name: "Ana" },
          distributions: [
            { memberId: memberA1, memberName: "Ana", amount: 999 },
          ],
        },
      ],
      { from: "2026-08-01", to: "2026-08-03" },
    );
  assert.deepEqual(memberExpenseDistribution.range, {
    from: "2026-08-01",
    to: "2026-08-03",
  });
  assert.equal(memberExpenseDistribution.expenseCount, 3);
  assert.equal(memberExpenseDistribution.expensesWithoutDistribution, 1);
  assert.equal(memberExpenseDistribution.totalPaid, 175.03);
  assert.equal(memberExpenseDistribution.totalAssigned, 150.03);
  assert.deepEqual(
    memberExpenseDistribution.members.map((member) => ({
      memberId: member.memberId,
      paidAmount: member.paidAmount,
      assignedAmount: member.assignedAmount,
    })),
    [
      { memberId: memberA2, paidAmount: 50.02, assignedAmount: 110.02 },
      { memberId: memberA1, paidAmount: 100.01, assignedAmount: 40.01 },
      { memberId: null, paidAmount: 25, assignedAmount: 0 },
    ],
  );
  assert.equal(
    memberExpenseDistribution.members.reduce(
      (sum, member) => sum + member.paidAmount,
      0,
    ),
    memberExpenseDistribution.totalPaid,
  );
  assert.equal(
    memberExpenseDistribution.members.reduce(
      (sum, member) => sum + member.assignedAmount,
      0,
    ),
    memberExpenseDistribution.totalAssigned,
  );
  assert.throws(
    () =>
      dashboardPresentation.buildDashboardMemberExpenseDistribution(
        [
          {
            id: "duplicate-expense",
            expenseDate: "2026-08-01",
            totalAmount: 1,
            paidBy: null,
            distributions: [],
          },
          {
            id: "duplicate-expense",
            expenseDate: "2026-08-01",
            totalAmount: 1,
            paidBy: null,
            distributions: [],
          },
        ],
        { from: "2026-08-01", to: "2026-08-03" },
      ),
    /unique/,
  );
  console.log(
    "PASS payer and assigned-share series use the same date range, reconcile independently and reject duplicate expenses",
  );

  assert.deepEqual(
    dashboardPresentation.buildDashboardFinancialComposition(100, 60.25),
    {
      totalIncome: 100,
      totalExpenses: 60.25,
      netAmount: 39.75,
      expensesAsPercentOfIncome: 60.25,
    },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardFinancialComposition(0, 25),
    {
      totalIncome: 0,
      totalExpenses: 25,
      netAmount: -25,
      expensesAsPercentOfIncome: null,
    },
  );
  assert.deepEqual(
    dashboardPresentation.buildDashboardFinancialComposition(0, 0),
    {
      totalIncome: 0,
      totalExpenses: 0,
      netAmount: 0,
      expensesAsPercentOfIncome: null,
    },
  );
  assert.equal(
    dashboardPresentation.buildDashboardFinancialComposition(
      0.01,
      999999999999.99,
    ).expensesAsPercentOfIncome,
    null,
  );
  assert.throws(
    () => dashboardPresentation.buildDashboardFinancialComposition(10, -1),
    /cannot be negative/,
  );
  console.log(
    "PASS financial composition keeps income and expense separate and omits ratios when income is zero",
  );

  const weekdayDistribution =
    dashboardPresentation.buildDashboardWeekdayDistribution(
      [
        { id: "sat-first", expenseDate: "2026-08-01", totalAmount: 2.25 },
        { id: "sun-zero", expenseDate: "2026-08-02", totalAmount: 0 },
        { id: "tue-spend", expenseDate: "2026-08-04", totalAmount: 25.5 },
        { id: "sat-second", expenseDate: "2026-08-08", totalAmount: 10 },
        { id: "out-of-range", expenseDate: "2026-08-10", totalAmount: 999 },
      ],
      { from: "2026-08-01", to: "2026-08-09" },
    );
  assert.equal(weekdayDistribution.expenseCount, 4);
  assert.equal(weekdayDistribution.totalAmount, 37.75);
  assert.deepEqual(
    weekdayDistribution.days.map((day) => day.calendarDayCount),
    [1, 1, 1, 1, 1, 2, 2],
  );
  assert.deepEqual(
    weekdayDistribution.days.map((day) => ({
      weekday: day.weekday,
      totalAmount: day.totalAmount,
      averageAmount: day.averageAmount,
      expenseCount: day.expenseCount,
    })),
    [
      { weekday: "Lunes", totalAmount: 0, averageAmount: 0, expenseCount: 0 },
      {
        weekday: "Martes",
        totalAmount: 25.5,
        averageAmount: 25.5,
        expenseCount: 1,
      },
      {
        weekday: "Miércoles",
        totalAmount: 0,
        averageAmount: 0,
        expenseCount: 0,
      },
      { weekday: "Jueves", totalAmount: 0, averageAmount: 0, expenseCount: 0 },
      { weekday: "Viernes", totalAmount: 0, averageAmount: 0, expenseCount: 0 },
      {
        weekday: "Sábado",
        totalAmount: 12.25,
        averageAmount: 6.13,
        expenseCount: 2,
      },
      { weekday: "Domingo", totalAmount: 0, averageAmount: 0, expenseCount: 1 },
    ],
  );
  assert.equal(weekdayDistribution.days[0].calendarDayCount, 1);
  assert.equal(weekdayDistribution.days[0].expenseCount, 0);
  assert.equal(weekdayDistribution.days[6].calendarDayCount, 2);
  assert.equal(weekdayDistribution.days[6].expenseCount, 1);
  const singleDayWeekday =
    dashboardPresentation.buildDashboardWeekdayDistribution(
      [{ id: "single-saturday", expenseDate: "2026-08-01", totalAmount: 5 }],
      { from: "2026-08-01", to: "2026-08-01" },
    );
  assert.equal(singleDayWeekday.days[5].averageAmount, 5);
  assert.equal(singleDayWeekday.days[6].calendarDayCount, 0);
  assert.equal(singleDayWeekday.days[6].averageAmount, null);
  assert.equal(
    dashboardPresentation
      .buildDashboardWeekdayDistribution([], {
        from: "2026-08-01",
        to: "2026-08-09",
      })
      .days.every((day) => day.expenseCount === 0 && day.totalAmount === 0),
    true,
  );
  assert.throws(
    () =>
      dashboardPresentation.buildDashboardWeekdayDistribution(
        [
          { id: "same", expenseDate: "2026-08-01", totalAmount: 1 },
          { id: "same", expenseDate: "2026-08-02", totalAmount: 2 },
        ],
        { from: "2026-08-01", to: "2026-08-09" },
      ),
    /unique/,
  );
  console.log(
    "PASS weekday spending averages respect the inclusive range and distinguish empty dates from zero-value records",
  );

  const sameRangeRecords = dashboardPresentation.buildDashboardTrendSeries(
    expenseRows
      .filter(
        (row) =>
          row.household_id === householdA &&
          row.status === "CONFIRMED" &&
          row.expense_date >= "2026-08-01" &&
          row.expense_date <= "2026-08-03",
      )
      .map((row) => ({
        date: row.expense_date,
        amount: Number(row.total_amount),
      })),
    incomeRows
      .filter(
        (row) =>
          row.household_id === householdA &&
          row.income_date >= "2026-08-01" &&
          row.income_date <= "2026-08-03",
      )
      .map((row) => ({ date: row.income_date, amount: Number(row.amount) })),
    { from: "2026-08-01", to: "2026-08-03" },
    "day",
  );
  assert.equal(sameRangeRecords.totalIncome, result.totalIncome);
  assert.equal(sameRangeRecords.totalExpenses, result.totalSpent);
  assert.equal(
    sameRangeRecords.points.reduce(
      (total, point) => total + point.incomeAmount,
      0,
    ),
    result.totalIncome,
  );
  assert.equal(
    sameRangeRecords.points.reduce(
      (total, point) => total + point.expenseAmount,
      0,
    ),
    result.totalSpent,
  );
  console.log(
    "PASS trend totals match analytical totals for the same complete date-filtered records",
  );

  console.log("PASS Dashboard functional checks completed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
