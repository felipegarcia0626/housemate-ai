const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const file = (relative) => path.join(root, relative);
const paths = {
  adapter: file("infrastructure/openai/openai.adapter.ts"),
  agentTypes: file("modules/agent/agent.types.ts"),
  presentation: file("modules/agent/agent-presentation.ts"),
  conversation: file("modules/agent/conversation.service.ts"),
  draft: file("modules/agent/category-draft.service.ts"),
  database: file("infrastructure/database/client.ts"),
  repository: file("modules/dashboard/dashboard.repository.ts"),
  service: file("modules/dashboard/dashboard.service.ts"),
  dashboardTypes: file("modules/dashboard/dashboard.types.ts"),
  calculator: file("modules/dashboard/dashboard-calculator.ts"),
  categoryCalculator: file("modules/dashboard/dashboard-category-summary-calculator.ts"),
  validation: file("modules/dashboard/dashboard.validation.ts"),
  categoryTypes: file("modules/categories/category.types.ts"),
  tool: file("modules/agent/tools/get-period-expense-category-summary.tool.ts"),
};
const realFiles = new Set(Object.values(paths).filter((value) =>
  value.endsWith(".ts") && value !== paths.draft && value !== paths.database));
const householdId = "42000000-0000-4000-8000-000000000001";
const context = {
  householdId,
  actorMemberId: "42000000-0000-4000-8000-000000000011",
  conversationKey: "web:category-summary",
  source: "WEB",
};
const interval = {
  from: "2026-10-01",
  to: "2026-10-31",
  level: "MACRO",
  categoryName: null,
};
const uuid = (number) =>
  "42000000-0000-4000-8000-" + String(number).padStart(12, "0");
const categories = [
  { id: uuid(1), name: "Alimentación", movement_type: "EXPENSE", level: "MACRO", parent_id: null, is_active: true },
  { id: uuid(2), name: "Frutas", movement_type: "EXPENSE", level: "MICRO", parent_id: uuid(1), is_active: true },
  { id: uuid(3), name: "Antiguas", movement_type: "EXPENSE", level: "MICRO", parent_id: uuid(1), is_active: false },
  { id: uuid(4), name: "Café", movement_type: "EXPENSE", level: "MACRO", parent_id: null, is_active: true },
  { id: uuid(5), name: "Cafe", movement_type: "EXPENSE", level: "MACRO", parent_id: null, is_active: true },
  { id: uuid(6), name: "Legacy", movement_type: null, level: null, parent_id: null, is_active: true },
];

function relation(categoryId) {
  if (categoryId === null) return null;
  const category = categories.find((row) => row.id === categoryId);
  return category ? { id: category.id, name: category.name } : null;
}

function baseRows() {
  const expenses = [];
  const items = [];
  for (let index = 1; index <= 501; index += 1) {
    const expenseId = uuid(10000 + index);
    expenses.push({
      id: expenseId,
      household_id: householdId,
      status: "CONFIRMED",
      expense_date: "2026-10-15",
      total_amount: "3.00",
      category_id: uuid(1),
      category: relation(uuid(1)),
    });
    for (let itemIndex = 1; itemIndex <= 3; itemIndex += 1) {
      const categoryId = itemIndex < 3 ? uuid(2) : null;
      items.push({
        id: uuid(20000 + index * 10 + itemIndex),
        expense_id: expenseId,
        total_amount: "0.50",
        category_id: categoryId,
        category: relation(categoryId),
      });
    }
  }
  expenses.push({
    id: uuid(15002), household_id: householdId, status: "CONFIRMED",
    expense_date: "2026-10-20", total_amount: "1.00", category_id: null, category: null,
  });
  const historicalId = uuid(15003);
  expenses.push({
    id: historicalId, household_id: householdId, status: "CONFIRMED",
    expense_date: "2026-10-21", total_amount: "1.00", category_id: uuid(1), category: relation(uuid(1)),
  });
  items.push({
    id: uuid(30001), expense_id: historicalId, total_amount: "0.50",
    category_id: uuid(3), category: relation(uuid(3)),
  });
  expenses.push({
    id: uuid(15004), household_id: uuid(99), status: "CONFIRMED",
    expense_date: "2026-10-21", total_amount: "80.00", category_id: uuid(1), category: relation(uuid(1)),
  });
  expenses.push({
    id: uuid(15005), household_id: householdId, status: "PENDING",
    expense_date: "2026-10-21", total_amount: "80.00", category_id: uuid(1), category: relation(uuid(1)),
  });
  expenses.push({
    id: uuid(15006), household_id: householdId, status: "CONFIRMED",
    expense_date: "2026-09-30", total_amount: "80.00", category_id: uuid(1), category: relation(uuid(1)),
  });
  return { tb_expenses: expenses, tb_expense_items: items, tb_categories: categories };
}

function databaseDouble(rows, options = {}) {
  const operations = [];
  const client = {
    from(table) {
      operations.push(["from", table]);
      const state = { table, from: 0, to: 499, predicates: [], orders: [] };
      const query = {};
      for (const method of ["select", "eq", "gte", "lte", "order", "range", "abortSignal", "in"]) {
        query[method] = (...args) => {
          operations.push([method, table, ...args]);
          if (method === "range") [state.from, state.to] = args;
          if (["eq", "gte", "lte", "in"].includes(method)) {
            state.predicates.push([method, ...args]);
          }
          if (method === "order") state.orders.push(args);
          return query;
        };
      }
      query.then = (resolve, reject) => {
        Promise.resolve().then(() => {
          const key = table + ":" + state.from;
          if (options.failures?.[key]) {
            return { data: null, error: options.failures[key], count: null };
          }
          if (options.invalid?.[key]) return options.invalid[key];
          let found = [...(rows[table] ?? [])].filter((row) =>
            state.predicates.every(([method, field, value]) => {
              if (method === "eq") return row[field] === value;
              if (method === "gte") return row[field] >= value;
              if (method === "lte") return row[field] <= value;
              if (method === "in") return value.includes(row[field]);
              return true;
            }),
          );
          for (const [field, direction] of [...state.orders].reverse()) {
            found.sort((left, right) => {
              const order = String(left[field]).localeCompare(String(right[field]));
              return direction?.ascending === false ? -order : order;
            });
          }
          const count = options.counts?.[key] ?? options.counts?.[table] ?? found.length;
          const selectedFields = {
            tb_expenses: ["id", "total_amount", "category_id", "category"],
            tb_expense_items: ["id", "expense_id", "total_amount", "category_id", "category"],
            tb_categories: ["id", "name", "movement_type", "level", "parent_id", "is_active"],
          }[table];
          let data = found.slice(state.from, state.to + 1);
          if (selectedFields) {
            data = data.map((row) => Object.fromEntries(
              selectedFields.map((field) => [field, row[field]]),
            ));
          }
          if (options.incomplete?.[key] && data.length) data = data.slice(0, -1);
          return { data, error: null, count };
        }).then(resolve, reject);
        return query;
      };
      return query;
    },
  };
  return { client, operations };
}

function loader(overrides, runtime = {}) {
  const cache = new Map();
  function load(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (!realFiles.has(resolved)) return {};
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const loadedModule = { exports: {} };
    cache.set(resolved, loadedModule);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      fileName: resolved,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText;
    const localRequire = (name) => {
      const next = name.startsWith("@/")
        ? file(name.slice(2) + ".ts")
        : name.startsWith(".")
          ? path.resolve(path.dirname(resolved), name + ".ts")
          : null;
      return next ? load(next) : require(name);
    };
    new Function(
      "require", "module", "exports", "process", "fetch",
      "setTimeout", "clearTimeout", output,
    )(
      localRequire, loadedModule, loadedModule.exports,
      { env: { OPENAI_API_KEY: "local-fake-key" } },
      runtime.fetch ?? (() => { throw new Error("Unexpected network call"); }),
      runtime.setTimeout ?? setTimeout,
      runtime.clearTimeout ?? clearTimeout,
    );
    return loadedModule.exports;
  }
  return load;
}

function fixture(options = {}, runtime = {}) {
  const db = databaseDouble(options.rows ?? baseRows(), options);
  const overrides = new Map([
    [paths.database, { getSupabaseAdminClient: () => db.client }],
    [paths.draft, { getActiveAgentDraft: async () => null }],
  ]);
  const load = loader(overrides, runtime);
  return {
    db,
    load,
    repository: load(paths.repository),
    service: load(paths.service),
    calculator: load(paths.categoryCalculator),
    presentation: load(paths.presentation),
    tool: load(paths.tool),
    adapter: load(paths.adapter),
  };
}

async function main() {
  const data = baseRows();
  const { tool, repository, db, presentation } = fixture();
  const { copMoneyToCents, formatCopCents, formatCopMoney } = presentation;
  assert.equal(formatCopMoney(10000), "$ 10.000");
  assert.equal(formatCopMoney(100000), "$ 100.000");
  assert.equal(formatCopMoney(1250500), "$ 1.250.500");
  assert.equal(formatCopMoney(10000.5), "$ 10.000,50");
  assert.equal(formatCopMoney(0), "$ 0");
  assert.equal(formatCopMoney(-0.99), "-$ 0,99");
  assert.equal(
    formatCopCents(copMoneyToCents(0.1) + copMoneyToCents(0.2)),
    "$ 0,30",
  );
  const safeCentBoundary = BigInt(Number.MAX_SAFE_INTEGER);
  assert.equal(formatCopCents(safeCentBoundary), "$ 90.071.992.547.409,91");
  assert.equal(
    formatCopCents(safeCentBoundary + 1n),
    "$ 90.071.992.547.409,92",
  );
  assert.equal(
    formatCopCents(-safeCentBoundary - 1n),
    "-$ 90.071.992.547.409,92",
  );
  assert.throws(() => formatCopCents(Number.MAX_SAFE_INTEGER), TypeError);
  for (const invalidAmount of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.001,
    90071992547410,
  ]) {
    assert.throws(() => formatCopMoney(invalidAmount), RangeError);
  }
  const parsed = tool.parsePeriodExpenseCategorySummaryArguments(interval);
  assert.deepEqual(parsed, interval);
  for (const bad of [
    { ...interval, householdId },
    { ...interval, level: "GENERAL" },
    { ...interval, categoryName: " " },
    { ...interval, from: "2026-02-30" },
    { ...interval, unexpected: true },
  ]) assert.equal(tool.parsePeriodExpenseCategorySummaryArguments(bad), null);
  const thirtyTwoDayPeriod = { ...interval, from: "2026-01-01", to: "2026-02-01" };
  const leapYearPeriod = { ...interval, from: "2024-01-01", to: "2024-12-31" };
  assert.deepEqual(tool.parsePeriodExpenseCategorySummaryArguments(thirtyTwoDayPeriod), thirtyTwoDayPeriod);
  assert.deepEqual(tool.parsePeriodExpenseCategorySummaryArguments(leapYearPeriod), leapYearPeriod);
  assert.equal(tool.parsePeriodExpenseCategorySummaryArguments({
    ...interval,
    from: "2024-01-01",
    to: "2025-01-01",
  }), null);

  const tooLong = fixture();
  const rejectedLongPeriod = await tooLong.tool.getPeriodExpenseCategorySummaryTool(context, {
    ...interval,
    from: "2024-01-01",
    to: "2025-01-01",
  });
  assert.equal(rejectedLongPeriod.complete, false);
  assert.equal(rejectedLongPeriod.failureReason, "PERIOD_TOO_LONG");
  assert.equal(tooLong.db.operations.some((entry) => entry[0] === "from"), false);
  const maxLengthFixture = fixture({ rows: {
    tb_expenses: [],
    tb_expense_items: [],
    tb_categories: categories,
  } });
  const maxLengthSummary = await maxLengthFixture.tool.getPeriodExpenseCategorySummaryTool(context, leapYearPeriod);
  assert.equal(maxLengthSummary.complete, true);
  assert.equal(maxLengthSummary.expenseCount, 0);
  const thirtyTwoDayFixture = fixture({ rows: {
    tb_expenses: [{
      id: uuid(16500), household_id: householdId, status: "CONFIRMED",
      expense_date: "2026-02-01", total_amount: "2.00", category_id: uuid(1), category: relation(uuid(1)),
    }],
    tb_expense_items: [],
    tb_categories: categories,
  } });
  const thirtyTwoDaySummary = await thirtyTwoDayFixture.tool.getPeriodExpenseCategorySummaryTool(context, thirtyTwoDayPeriod);
  assert.equal(thirtyTwoDaySummary.complete, true);
  assert.equal(thirtyTwoDaySummary.totalSpent, 2);
  assert.equal(thirtyTwoDaySummary.expenseCount, 1);


  const macroSummary = await tool.getPeriodExpenseCategorySummaryTool(context, interval);
  assert.equal(macroSummary.complete, true);
  assert.equal(macroSummary.expenseCount, 503);
  assert.equal(macroSummary.totalSpent, 1505);
  assert.equal(macroSummary.topCategory.categoryName, "Alimentación");
  assert.equal(macroSummary.topCategory.amount, 1504);
  assert.equal(macroSummary.uncategorizedAmount, 1);
  assert.equal(macroSummary.unmappedAmount, 0);
  assert.ok(operation(db, "range", "tb_expenses", ([from, to]) => from === 0 && to === 499));
  assert.ok(operation(db, "range", "tb_expenses", ([from, to]) => from === 500 && to === 999));
  assert.ok(operation(db, "range", "tb_expense_items", ([from, to]) => from === 0 && to === 499));
  assert.ok(operation(db, "range", "tb_expense_items", ([from, to]) => from === 500 && to === 999));
  assert.ok(operation(db, "eq", "tb_expenses", ([field, value]) => field === "household_id" && value === householdId));
  assert.ok(operation(db, "eq", "tb_expenses", ([field, value]) => field === "status" && value === "CONFIRMED"));
  assert.ok(operation(db, "gte", "tb_expenses", ([field, value]) => field === "expense_date" && value === interval.from));
  assert.ok(operation(db, "lte", "tb_expenses", ([field, value]) => field === "expense_date" && value === interval.to));
  assert.ok(operation(db, "abortSignal", "tb_expenses"));
  assert.ok(operation(db, "abortSignal", "tb_expense_items"));
  assert.ok(operation(db, "abortSignal", "tb_categories"));

  let forwardedFilters;
  const forwardingFixture = fixture();
  await tool.getPeriodExpenseCategorySummaryTool(context, interval, {
    loadData: (serviceContext, filters, signal) => {
      forwardedFilters = filters;
      return forwardingFixture.service.getPeriodExpenseCategoryData(
        serviceContext,
        filters,
        signal,
      );
    },
  });
  assert.deepEqual(forwardedFilters, { from: interval.from, to: interval.to });

  const microFixture = fixture();
  const micro = await microFixture.tool.getPeriodExpenseCategorySummaryTool(context, {
    ...interval, level: "MICRO",
  });
  assert.equal(micro.complete, true);
  assert.equal(micro.topCategory.categoryName, "Frutas");
  assert.equal(micro.topCategory.amount, 501);
  assert.equal(micro.unmappedAmount, 1002.5);
  assert.equal(micro.uncategorizedAmount, 1);
  assert.ok(micro.categories.some((row) => row.categoryName === "Antiguas" && row.isActive === false && row.amount === 0.5));

  const match = await fixture().tool.getPeriodExpenseCategorySummaryTool(context, {
    ...interval, categoryName: " alimentacion ",
  });
  assert.equal(match.complete, true);
  assert.deepEqual(match.matchedCategory, {
    categoryName: "Alimentación", amount: 1504, isActive: true,
  });
  const ambiguous = await fixture().tool.getPeriodExpenseCategorySummaryTool(context, {
    ...interval, categoryName: "cafe",
  });
  assert.equal(ambiguous.complete, false);
  assert.equal(ambiguous.failureReason, "CATEGORY_AMBIGUOUS");
  const inactive = await fixture().tool.getPeriodExpenseCategorySummaryTool(context, {
    ...interval, level: "MICRO", categoryName: "Antiguas",
  });
  assert.equal(inactive.failureReason, "CATEGORY_INACTIVE");
  const unresolved = await fixture().tool.getPeriodExpenseCategorySummaryTool(context, {
    ...interval, categoryName: "Alimen",
  });
  assert.equal(unresolved.failureReason, "CATEGORY_UNRESOLVED");

  const tieCategories = [
    { id: uuid(30), name: "Beta", movementType: "EXPENSE", level: "MACRO", parentId: null, isActive: true },
    { id: uuid(31), name: "Alfa", movementType: "EXPENSE", level: "MACRO", parentId: null, isActive: true },
  ];
  const tie = fixture().calculator.calculatePeriodExpenseCategorySummary({
    categories: tieCategories,
    expenses: [
      { totalAmount: "2.00", categoryId: uuid(30), categoryName: "Beta", items: [] },
      { totalAmount: "2.00", categoryId: uuid(31), categoryName: "Alfa", items: [] },
    ],
  }, { from: interval.from, to: interval.to, level: "MACRO", categoryName: null });
  assert.deepEqual(tie.categories.map((row) => row.categoryName), ["Alfa", "Beta"]);
  assert.equal(tie.topCategory.categoryName, "Alfa");

  const noMatches = fixture({
    rows: { ...data, tb_expenses: data.tb_expenses, tb_expense_items: data.tb_expense_items },
  });
  const empty = await noMatches.tool.getPeriodExpenseCategorySummaryTool(context, {
    ...interval, from: "2026-11-01", to: "2026-11-30",
  });
  assert.equal(empty.complete, true);
  assert.equal(empty.totalSpent, 0);
  assert.equal(empty.expenseCount, 0);
  assert.deepEqual(empty.categories, []);
  assert.equal(empty.topCategory, null);

  const longRangeRows = baseRows();
  longRangeRows.tb_expenses.push(
    {
      id: uuid(16001), household_id: householdId, status: "CONFIRMED",
      expense_date: "2026-01-01", total_amount: "2.00", category_id: uuid(1), category: relation(uuid(1)),
    },
    {
      id: uuid(16002), household_id: householdId, status: "CONFIRMED",
      expense_date: "2026-10-16", total_amount: "4.00", category_id: uuid(2), category: relation(uuid(2)),
    },
    {
      id: uuid(16003), household_id: householdId, status: "CONFIRMED",
      expense_date: "2025-12-31", total_amount: "500.00", category_id: uuid(1), category: relation(uuid(1)),
    },
    {
      id: uuid(16004), household_id: householdId, status: "CONFIRMED",
      expense_date: "2026-10-17", total_amount: "500.00", category_id: uuid(1), category: relation(uuid(1)),
    },
    {
      id: uuid(16005), household_id: uuid(99), status: "CONFIRMED",
      expense_date: "2026-10-16", total_amount: "500.00", category_id: uuid(1), category: relation(uuid(1)),
    },
    {
      id: uuid(16006), household_id: householdId, status: "PENDING",
      expense_date: "2026-10-16", total_amount: "500.00", category_id: uuid(1), category: relation(uuid(1)),
    },
  );
  const threeMonthPeriod = { ...interval, from: "2026-08-01", to: "2026-10-31" };
  const threeMonthFixture = fixture({ rows: longRangeRows });
  const threeMonthSummary = await threeMonthFixture.tool.getPeriodExpenseCategorySummaryTool(context, threeMonthPeriod);
  assert.equal(threeMonthSummary.complete, true);
  assert.equal(threeMonthSummary.expenseCount, 506);
  assert.equal(threeMonthSummary.totalSpent, 2089);
  assert.ok(operation(threeMonthFixture.db, "gte", "tb_expenses", ([field, value]) => field === "expense_date" && value === threeMonthPeriod.from));
  assert.ok(operation(threeMonthFixture.db, "lte", "tb_expenses", ([field, value]) => field === "expense_date" && value === threeMonthPeriod.to));

  const tenMonthPeriod = { ...interval, from: "2026-01-01", to: "2026-10-16" };
  const tenMonthFixture = fixture({ rows: longRangeRows });
  const tenMonthSummary = await tenMonthFixture.tool.getPeriodExpenseCategorySummaryTool(context, tenMonthPeriod);
  assert.equal(tenMonthSummary.complete, true);
  assert.equal(tenMonthSummary.expenseCount, 504);
  assert.equal(tenMonthSummary.totalSpent, 1589);
  assert.ok(operation(tenMonthFixture.db, "gte", "tb_expenses", ([field, value]) => field === "expense_date" && value === tenMonthPeriod.from));
  assert.ok(operation(tenMonthFixture.db, "lte", "tb_expenses", ([field, value]) => field === "expense_date" && value === tenMonthPeriod.to));
  assert.ok(operation(tenMonthFixture.db, "range", "tb_expenses", ([from, to]) => from === 500 && to === 999));

  const emptyInterval = {
    ...interval,
    from: "2026-11-01",
    to: "2026-11-30",
  };
  const emptySummaryIntegration = fixture(
    {
      rows: {
        tb_expenses: [],
        tb_expense_items: [],
        tb_categories: categories,
      },
    },
    {
      fetch: async () => ({
        ok: true,
        json: async () => ({
          id: "response-empty-category",
          status: "completed",
          output: [{
            type: "function_call",
            name: "get_period_expense_category_summary",
            call_id: "empty-category-call",
            arguments: JSON.stringify(emptyInterval),
          }],
        }),
      }),
    },
  );
  const emptySummaryMessage = await emptySummaryIntegration
    .load(paths.conversation)
    .processAgentMessage(context, {
      message: "Resume los gastos por categoría de noviembre.",
    });
  assert.equal(
    emptySummaryMessage.message,
    [
      "Período 2026-11-01 a 2026-11-30 (fechas incluidas).",
      "Total de gastos confirmados: $ 0.",
      "No hubo gastos asignables a categorías en el período.",
    ].join("\n"),
  );

  const manyTaxonomyRows = baseRows();
  manyTaxonomyRows.tb_categories = [
    ...manyTaxonomyRows.tb_categories,
    ...Array.from({ length: 495 }, (_, index) => ({
      id: uuid(50000 + index),
      name: `Categoría adicional ${index + 1}`,
      movement_type: "EXPENSE",
      level: "MACRO",
      parent_id: null,
      is_active: true,
    })),
  ];

  for (const options of [
    { failures: { "tb_expenses:500": new Error("later expense page failed") } },
    { failures: { "tb_expense_items:500": new Error("later item page failed") } },
    { counts: { "tb_expenses:500": 504 } },
    { incomplete: { "tb_expenses:500": true } },
    { incomplete: { "tb_expense_items:500": true } },
    {
      rows: manyTaxonomyRows,
      failures: { "tb_categories:500": new Error("later taxonomy page failed") },
    },
    { rows: manyTaxonomyRows, counts: { "tb_categories:500": 500 } },
    { rows: manyTaxonomyRows, incomplete: { "tb_categories:500": true } },
    {
      invalid: {
        "tb_categories:0": { data: { unexpected: true }, error: null, count: 6 },
      },
    },
    { counts: { "tb_expenses:0": 5001 } },
    { counts: { "tb_expense_items:0": 50001 } },
    { counts: { "tb_categories:0": 5001 } },
  ]) {
    const failed = fixture(options);
    const result = await failed.tool.getPeriodExpenseCategorySummaryTool(context, interval);
    assert.equal(result.complete, false);
    assert.equal(Object.hasOwn(result, "totalSpent"), false);
    assert.equal(Object.hasOwn(result, "categories"), false);
    if (options.rows?.tb_categories?.length > 500) {
      assert.ok(
        operation(
          failed.db,
          "range",
          "tb_categories",
          ([from]) => from === 500,
        ),
      );
    }
  }

  const malformedRows = baseRows();
  malformedRows.tb_expenses[0].total_amount = "1.009";
  assert.equal((await fixture({ rows: malformedRows }).tool
    .getPeriodExpenseCategorySummaryTool(context, interval)).complete, false);
  const inconsistentRows = baseRows();
  inconsistentRows.tb_expense_items[0].total_amount = "4.00";
  assert.equal((await fixture({ rows: inconsistentRows }).tool
    .getPeriodExpenseCategorySummaryTool(context, interval)).complete, false);
  const malformedRelationRows = baseRows();
  malformedRelationRows.tb_expense_items[0].category = { id: uuid(5), name: "Other" };
  assert.equal((await fixture({ rows: malformedRelationRows }).tool
    .getPeriodExpenseCategorySummaryTool(context, interval)).complete, false);

  const overflowFixture = fixture();
  const maxExpense = {
    totalAmount: "999999999999.99", categoryId: uuid(1), categoryName: "Alimentación", items: [],
  };
  assert.throws(() => overflowFixture.calculator.calculatePeriodExpenseCategorySummary({
    expenses: Array.from({ length: 100 }, () => maxExpense),
    categories: categories.map((row) => ({
      id: row.id, name: row.name, movementType: row.movement_type, level: row.level,
      parentId: row.parent_id, isActive: row.is_active,
    })),
  }, { from: interval.from, to: interval.to, level: "MACRO", categoryName: null }));

  let fireTimeout;
  let signal;
  const timeoutFixture = fixture({}, {
    setTimeout: (callback) => { fireTimeout = callback; return 1; },
    clearTimeout: () => {},
  });
  const pending = timeoutFixture.tool.getPeriodExpenseCategorySummaryTool(context, interval, {
    loadData: (_context, _period, abortSignal) => {
      signal = abortSignal;
      return new Promise(() => {});
    },
    setTimeout: (callback) => { fireTimeout = callback; return 1; },
    clearTimeout: () => {},
  });
  await Promise.resolve();
  fireTimeout();
  assert.equal((await pending).complete, false);
  assert.equal(signal.aborted, true);

  const requests = [];
  const fakeFetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return {
      ok: true,
      json: async () => ({
        id: "response-category",
        status: "completed",
        output: [{
          type: "function_call",
          name: "get_period_expense_category_summary",
          call_id: "category-call",
          arguments: JSON.stringify(interval),
        }],
      }),
    };
  };
  const integration = fixture({}, { fetch: fakeFetch });
  const call = await integration.adapter.interpretExpenseMessage("¿Cuánto gastamos por categoría?");
  assert.equal(call.kind, "GET_PERIOD_EXPENSE_CATEGORY_SUMMARY_TOOL_CALL");
  const registered = requests[0].tools.find((row) => row.name === "get_period_expense_category_summary");
  assert.equal(registered.strict, true);
  assert.equal(registered.parameters.additionalProperties, false);
  assert.deepEqual(registered.parameters.required, ["from", "to", "level", "categoryName"]);
  for (const badBody of [
    {
      id: "response-category", status: "completed",
      output: [{ type: "function_call", name: "unknown_tool", call_id: "x", arguments: "{}" }],
    },
    {
      id: "response-category", status: "completed",
      output: [
        { type: "function_call", name: "get_period_expense_category_summary", call_id: "x", arguments: "{}" },
        { type: "function_call", name: "get_period_expense_category_summary", call_id: "y", arguments: "{}" },
      ],
    },
    {
      id: "response-category", status: "completed",
      output: [{ type: "function_call", name: "get_period_expense_category_summary", call_id: "x", arguments: "{" }],
    },
  ]) {
    const badAdapter = fixture({}, {
      fetch: async () => ({ ok: true, json: async () => badBody }),
    }).adapter;
    await assert.rejects(
      badAdapter.interpretExpenseMessage("Consulta por categoría"),
      { code: "INTERPRETATION_ERROR" },
    );
  }

  const app = await integration.load(paths.conversation).processAgentMessage(context, {
    message: "¿Cuál fue la categoría de mayor gasto?",
  });
  assert.equal(app.operation, "GET_PERIOD_EXPENSE_CATEGORY_SUMMARY");
  assert.equal(app.data.complete, true);
  assert.match(app.message, /Mayor gasto por categoría: Alimentación/);
  assert.equal(
    app.message,
    [
      "Período 2026-10-01 a 2026-10-31 (fechas incluidas).",
      "Total de gastos confirmados: $ 1.505.",
      "Mayor gasto por categoría: Alimentación ($ 1.504).",
      "Ranking: Alimentación $ 1.504.",
      "Sin categoría: $ 1.",
    ].join("\n"),
  );

  const largeAmountRows = {
    tb_expenses: [{
      id: uuid(70001),
      household_id: householdId,
      status: "CONFIRMED",
      expense_date: "2026-10-15",
      total_amount: "1250500.00",
      category_id: uuid(1),
      category: relation(uuid(1)),
    }],
    tb_expense_items: [],
    tb_categories: categories,
  };
  const largeAmountIntegration = fixture({ rows: largeAmountRows }, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        id: "response-large-category",
        status: "completed",
        output: [{
          type: "function_call",
          name: "get_period_expense_category_summary",
          call_id: "large-category-call",
          arguments: JSON.stringify(interval),
        }],
      }),
    }),
  });
  const largeAmountResult = await largeAmountIntegration.load(paths.conversation)
    .processAgentMessage(context, {
      message: "¿Cuánto gastamos por categoría macro?",
    });
  assert.equal(
    largeAmountResult.message,
    [
      "Período 2026-10-01 a 2026-10-31 (fechas incluidas).",
      "Total de gastos confirmados: $ 1.250.500.",
      "Mayor gasto por categoría: Alimentación ($ 1.250.500).",
      "Ranking: Alimentación $ 1.250.500.",
    ].join("\n"),
  );
  console.log("PASS period expense category summary pagination, attribution, taxonomy, limits and dispatch");
}

function operation(db, method, table, predicate = () => true) {
  return db.operations.some((entry) =>
    entry[0] === method && entry[1] === table && predicate(entry.slice(2)),
  );
}

main().catch((error) => {
  console.error("FAIL period expense category summary functional harness:", error);
  process.exitCode = 1;
});
