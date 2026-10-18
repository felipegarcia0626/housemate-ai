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
  categoryCalculator: file("modules/dashboard/dashboard-category-summary-calculator.ts"),
  dashboardCalculator: file("modules/dashboard/dashboard-calculator.ts"),
  categoryTypes: file("modules/categories/category.types.ts"),
  repository: file("modules/dashboard/dashboard.repository.ts"),
  service: file("modules/dashboard/dashboard.service.ts"),
  dashboardTypes: file("modules/dashboard/dashboard.types.ts"),
  validation: file("modules/dashboard/dashboard.validation.ts"),
  tool: file("modules/agent/tools/get-period-financial-summary.tool.ts"),
};
const realFiles = new Set([
  paths.adapter, paths.agentTypes, paths.conversation, paths.repository,
  paths.presentation, paths.service, paths.dashboardTypes, paths.validation,
  paths.categoryCalculator, paths.dashboardCalculator, paths.categoryTypes, paths.tool,
]);

function loader(overrides, runtime = {}) {
  const cache = new Map();
  function load(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (!realFiles.has(resolved)) return {};
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      fileName: resolved,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    const localRequire = (name) => {
      const next = name.startsWith("@/")
        ? file(`${name.slice(2)}.ts`)
        : name.startsWith(".")
          ? path.resolve(path.dirname(resolved), `${name}.ts`)
          : null;
      return next ? load(next) : require(name);
    };
    new Function("require", "module", "exports", "process", "fetch", "setTimeout", "clearTimeout", output)(
      localRequire, module, module.exports,
      { env: { OPENAI_API_KEY: "local-fake-key" } },
      runtime.fetch ?? (() => { throw new Error("Unexpected network call"); }),
      runtime.setTimeout ?? setTimeout,
      runtime.clearTimeout ?? clearTimeout,
    );
    return module.exports;
  }
  return load;
}

const context = {
  householdId: "42000000-0000-4000-8000-000000000001",
  actorMemberId: "42000000-0000-4000-8000-000000000011",
  conversationKey: "web:a",
  source: "WEB",
};
const interval = {
  from: "2026-10-01",
  to: "2026-10-31",
  categoryLevel: null,
  categoryName: null,
};
const defaultRows = {
  tb_expenses: Array.from({ length: 501 }, (_, index) => ({
    id: `expense-${String(index).padStart(4, "0")}`,
    household_id: context.householdId,
    status: "CONFIRMED",
    expense_date: "2026-10-15",
    total_amount: "0.01",
  })),
  tb_incomes: [0, 1].map((index) => ({
    id: `income-${index}`,
    household_id: context.householdId,
    income_date: "2026-10-15",
    amount: "3.00",
  })),
};

function databaseDouble(options = {}) {
  const operations = [];
  const rowsByTable = options.rows ?? defaultRows;
  const counts = options.counts ?? {};
  const failures = options.failures ?? {};
  const incomplete = options.incomplete ?? {};
  const invalid = options.invalid ?? {};
  const client = { from(table) {
    operations.push(["from", table]);
    const state = { table, from: 0, to: 499, predicates: [] };
    const query = {};
    for (const method of ["select", "eq", "gte", "lte", "order", "range", "abortSignal"]) {
      query[method] = (...args) => {
        operations.push([method, table, ...args]);
        if (method === "range") [state.from, state.to] = args;
        if (["eq", "gte", "lte"].includes(method)) state.predicates.push([method, ...args]);
        return query;
      };
    }
    query.then = (resolve, reject) => {
      const key = `${table}:${state.from}`;
      if (failures[key]) return Promise.resolve({ data: null, error: failures[key], count: null }).then(resolve, reject);
      if (invalid[key]) return Promise.resolve(invalid[key]).then(resolve, reject);
      const allRows = (rowsByTable[table] ?? []).filter((row) =>
        state.predicates.every(([method, field, value]) => {
          if (method === "eq") return row[field] === value;
          if (method === "gte") return row[field] >= value;
          if (method === "lte") return row[field] <= value;
          return true;
        }),
      );
      allRows.sort((left, right) => String(left.id).localeCompare(String(right.id)));
      let data = allRows.slice(state.from, state.to + 1);
      if (incomplete[key] && data.length > 0) data = data.slice(0, -1);
      return Promise.resolve({ data, error: null, count: counts[key] ?? counts[table] ?? allRows.length }).then(resolve, reject);
    };
    return query;
  } };
  return { client, operations };
}

function operation(db, method, table, predicate = () => true) {
  return db.operations.some((entry) => entry[0] === method && entry[1] === table && predicate(entry.slice(2)));
}

function fixtureForRows(expenses, incomes, options = {}) {
  return fixtures(databaseDouble({
    ...options,
    rows: { tb_expenses: expenses, tb_incomes: incomes },
  }));
}

const expenseRow = (overrides = {}) => ({
  id: "expense-test",
  household_id: context.householdId,
  status: "CONFIRMED",
  expense_date: "2024-06-01",
  total_amount: "1.00",
  ...overrides,
});
const incomeRow = (overrides = {}) => ({
  id: "income-test",
  household_id: context.householdId,
  income_date: "2024-06-01",
  amount: "1.00",
  ...overrides,
});

function expectedSelect(db, table, column) {
  assert.ok(operation(db, "select", table, ([fields, options]) =>
    fields === `${column}::text` && options?.count === "exact"));
  assert.ok(operation(db, "eq", table, ([field, value]) =>
    field === "household_id" && value === context.householdId));
  assert.ok(operation(db, "abortSignal", table));
  if (table === "tb_expenses") {
    assert.ok(operation(db, "eq", table, ([field, value]) =>
      field === "status" && value === "CONFIRMED"));
  }
}

function fixtures(database, runtime = {}) {
  const overrides = new Map([
    [paths.database, { getSupabaseAdminClient: () => database.client }],
    [paths.draft, { getActiveAgentDraft: async () => null }],
  ]);
  const load = loader(overrides, runtime);
  return { load, repository: load(paths.repository), tool: load(paths.tool), adapter: load(paths.adapter) };
}

const completedCall = () => ({ id: "response-1", status: "completed", output: [
  { type: "function_call", name: "get_period_financial_summary", call_id: "call-1", arguments: JSON.stringify(interval) },
] });
const completedObservation = () => ({ status: "completed", output: [
  { type: "message", content: [{ type: "output_text", text: '{"observation":"INCOME_EXCEEDS_EXPENSE"}' }] },
] });

async function main() {
  const db = databaseDouble();
  const { tool } = fixtures(db);
  assert.deepEqual(tool.parsePeriodFinancialSummaryArguments(interval), interval);
  for (const bad of [
    { ...interval, householdId: context.householdId },
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-10-31", to: "2026-10-01" },
  ]) assert.equal(tool.parsePeriodFinancialSummaryArguments(bad), null);
  const thirtyTwoDays = { ...interval, from: "2026-01-01", to: "2026-02-01" };
  const leapYear = { ...interval, from: "2024-01-01", to: "2024-12-31" };
  assert.deepEqual(tool.parsePeriodFinancialSummaryArguments(thirtyTwoDays), thirtyTwoDays);
  assert.deepEqual(tool.parsePeriodFinancialSummaryArguments(leapYear), leapYear);

  const tooLongDb = databaseDouble();
  const tooLong = fixtures(tooLongDb);
  assert.deepEqual(await tooLong.tool.getPeriodFinancialSummaryTool(context, {
    ...interval,
    from: "2024-01-01",
    to: "2025-01-01",
  }), {
    from: "2024-01-01",
    to: "2025-01-01",
    complete: false,
    failureReason: "PERIOD_TOO_LONG",
  });
  assert.equal(tooLongDb.operations.some((entry) => entry[0] === "from"), false);

  const tooLongConversationDb = databaseDouble();
  const tooLongConversation = fixtures(tooLongConversationDb, {
    fetch: async () => ({
      ok: true,
      json: async () => ({
        id: "response-too-long-financial",
        status: "completed",
        output: [{
          type: "function_call",
          name: "get_period_financial_summary",
          call_id: "too-long-financial-call",
          arguments: JSON.stringify({
            ...interval,
            from: "2024-01-01",
            to: "2025-01-01",
          }),
        }],
      }),
    }),
  });
  const tooLongFinancialMessage = await tooLongConversation.load(paths.conversation)
    .processAgentMessage(context, { message: "Resume un periodo muy largo" });
  assert.equal(tooLongFinancialMessage.message, "El período solicitado no puede superar 366 días.");
  assert.equal(tooLongConversationDb.operations.some((entry) => entry[0] === "from"), false);

  const thirtyTwoDayFixture = fixtureForRows(
    [expenseRow({ id: "expense-32d", expense_date: "2026-02-01", total_amount: "2.00" })],
    [incomeRow({ id: "income-32d", income_date: "2026-01-01", amount: "3.00" })],
  );
  const thirtyTwoDaySummary = await thirtyTwoDayFixture.tool.getPeriodFinancialSummaryTool(context, thirtyTwoDays);
  assert.deepEqual([
    thirtyTwoDaySummary.complete,
    thirtyTwoDaySummary.totalIncome,
    thirtyTwoDaySummary.totalSpent,
    thirtyTwoDaySummary.incomeCount,
    thirtyTwoDaySummary.expenseCount,
  ], [true, 3, 2, 1, 1]);

  const macroId = "42000000-0000-4000-8000-000000000099";
  let combinedInterval = null;
  const combinedSummary = await tool.getPeriodFinancialSummaryTool(
    context,
    { ...thirtyTwoDays, categoryLevel: "MACRO", categoryName: null },
    {
      snapshot: async () => { throw new Error("Combined summary must not use snapshot data."); },
      combinedData: async (_dashboardContext, requestedInterval) => {
        combinedInterval = requestedInterval;
        return {
          incomeCount: 1,
          incomeAmount: "3.00",
          categoryData: {
            expenses: [{
              totalAmount: "2.00",
              categoryId: macroId,
              categoryName: "Alimentación",
              items: [],
            }],
            categories: [{
              id: macroId,
              name: "Alimentación",
              movementType: "EXPENSE",
              level: "MACRO",
              parentId: null,
              isActive: true,
            }],
            expenseCount: 1,
            itemCount: 0,
          },
        };
      },
    },
  );
  assert.equal(combinedSummary.complete, true);
  assert.equal(combinedSummary.totalIncome, 3);
  assert.equal(combinedSummary.totalSpent, 2);
  assert.deepEqual(combinedInterval, {
    from: thirtyTwoDays.from,
    to: thirtyTwoDays.to,
  });

  const result = await tool.getPeriodFinancialSummaryTool(context, interval);
  assert.deepEqual([result.complete, result.totalIncome, result.totalSpent, result.netAmount, result.movementCount], [true, 6, 5.01, 0.99, 503]);
  assert.equal(db.operations.filter((entry) => entry[0] === "from" && entry[1] === "tb_expenses").length, 2);
  assert.equal(db.operations.filter((entry) => entry[0] === "from" && entry[1] === "tb_incomes").length, 1);
  expectedSelect(db, "tb_expenses", "total_amount");
  expectedSelect(db, "tb_incomes", "amount");
  assert.ok(operation(db, "gte", "tb_expenses", ([field, value]) => field === "expense_date" && value === interval.from));
  assert.ok(operation(db, "lte", "tb_expenses", ([field, value]) => field === "expense_date" && value === interval.to));
  assert.ok(operation(db, "gte", "tb_incomes", ([field, value]) => field === "income_date" && value === interval.from));
  assert.ok(operation(db, "lte", "tb_incomes", ([field, value]) => field === "income_date" && value === interval.to));

  for (const period of [
    { ...interval, from: "2026-08-01", to: "2026-10-31" },
    { ...interval, from: "2026-01-01", to: "2026-10-16" },
  ]) {
    const periodDb = databaseDouble();
    const periodFixture = fixtures(periodDb);
    assert.equal((await periodFixture.tool.getPeriodFinancialSummaryTool(context, period)).complete, true);
    assert.ok(operation(periodDb, "gte", "tb_expenses", ([field, value]) => field === "expense_date" && value === period.from));
    assert.ok(operation(periodDb, "lte", "tb_expenses", ([field, value]) => field === "expense_date" && value === period.to));
    assert.ok(operation(periodDb, "gte", "tb_incomes", ([field, value]) => field === "income_date" && value === period.from));
    assert.ok(operation(periodDb, "lte", "tb_incomes", ([field, value]) => field === "income_date" && value === period.to));
  }

  const empty = fixtureForRows([], []);
  assert.deepEqual(await empty.tool.getPeriodFinancialSummaryTool(context, interval), {
    from: interval.from, to: interval.to,
    complete: true, totalIncome: 0, totalSpent: 0, netAmount: 0,
    incomeCount: 0, expenseCount: 0, movementCount: 0,
  });

  for (const bad of [
    fixtureForRows([expenseRow({ expense_date: interval.from, total_amount: 20 })], []),
    fixtureForRows([expenseRow({ expense_date: interval.from, unexpected: "1.00", total_amount: undefined })], []),
    fixtures(databaseDouble({ rows: defaultRows, incomplete: { "tb_expenses:500": true } })),
    fixtures(databaseDouble({ rows: defaultRows, counts: { "tb_expenses:500": 502 } })),
    fixtures(databaseDouble({ rows: defaultRows, invalid: { "tb_incomes:0": { data: [], error: null, count: null } } })),
    fixtures(databaseDouble({ rows: defaultRows, counts: { tb_expenses: 5001 } })),
    fixtures(databaseDouble({ rows: defaultRows, counts: { tb_incomes: 5001 } })),
  ]) {
    await assert.rejects(bad.repository.readPeriodFinancialSnapshot(context.householdId, interval.from, interval.to, new AbortController().signal));
    assert.equal((await bad.tool.getPeriodFinancialSummaryTool(context, interval)).complete, false);
  }
  for (const [table, offset] of [["tb_expenses", 500], ["tb_incomes", 0]]) {
    const bad = fixtures(databaseDouble({ rows: defaultRows, failures: { [`${table}:${offset}`]: new Error(`${table} page failed`) } }));
    assert.deepEqual(await bad.tool.getPeriodFinancialSummaryTool(context, interval), {
      from: interval.from,
      to: interval.to,
      complete: false,
      failureReason: "INCOMPLETE",
    });
  }

  const boundaryPeriod = { ...interval, from: "2024-01-01", to: "2024-12-31" };
  const boundaries = fixtureForRows(
    [
      expenseRow({ id: "expense-first", expense_date: boundaryPeriod.from, total_amount: "0.01" }),
      expenseRow({ id: "expense-last", expense_date: boundaryPeriod.to, total_amount: "0.02" }),
      expenseRow({ id: "expense-before", expense_date: "2023-12-31", total_amount: "100.00" }),
      expenseRow({ id: "expense-after", expense_date: "2025-01-01", total_amount: "100.00" }),
      expenseRow({ id: "expense-other-household", household_id: "42000000-0000-4000-8000-000000000099", total_amount: "100.00" }),
      expenseRow({ id: "expense-pending", status: "PENDING", total_amount: "100.00" }),
    ],
    [
      incomeRow({ id: "income-first", income_date: boundaryPeriod.from, amount: "10.00" }),
      incomeRow({ id: "income-last", income_date: boundaryPeriod.to, amount: "20.00" }),
      incomeRow({ id: "income-before", income_date: "2023-12-31", amount: "100.00" }),
      incomeRow({ id: "income-after", income_date: "2025-01-01", amount: "100.00" }),
      incomeRow({ id: "income-other-household", household_id: "42000000-0000-4000-8000-000000000099", amount: "100.00" }),
    ],
  );
  const boundaryResult = await boundaries.tool.getPeriodFinancialSummaryTool(context, boundaryPeriod);
  assert.deepEqual([
    boundaryResult.complete,
    boundaryResult.totalIncome,
    boundaryResult.totalSpent,
    boundaryResult.netAmount,
    boundaryResult.incomeCount,
    boundaryResult.expenseCount,
  ], [true, 30, 0.03, 29.97, 2, 2]);

  const exactLargeTotal = fixtureForRows(
    [
      expenseRow({ id: "expense-large-a", expense_date: interval.from, total_amount: "45035996273650.00" }),
      expenseRow({ id: "expense-large-b", expense_date: interval.from, total_amount: "45035996273650.00" }),
    ],
    [],
  );
  const exactLargeResult = await exactLargeTotal.tool.getPeriodFinancialSummaryTool(context, interval);
  assert.equal(exactLargeResult.complete, true);
  assert.equal(exactLargeResult.totalSpent, 90071992547300);
  assert.equal(exactLargeResult.netAmount, -90071992547300);

  let resolvePending;
  let fireTimeout;
  let signal;
  const pendingTool = fixtures(databaseDouble(), {
    setTimeout: (callback) => { fireTimeout = callback; return 1; },
    clearTimeout: () => {},
  }).tool;
  const pending = pendingTool.getPeriodFinancialSummaryTool(context, interval, {
    snapshot: (_ctx, _interval, value) => {
      signal = value;
      return new Promise((resolve) => { resolvePending = resolve; });
    },
  });
  await Promise.resolve();
  assert.equal((await pendingTool.getPeriodFinancialSummaryTool(context, interval, { snapshot: async () => { throw new Error("Unexpected repeated query"); } })).complete, false);
  fireTimeout();
  assert.equal((await pending).complete, false);
  assert.equal(signal.aborted, true);
  resolvePending({ incomeCount: 1, expenseCount: 1, incomeAmount: "100.00", expenseAmount: "20.00" });
  await Promise.resolve();
  assert.equal((await pendingTool.getPeriodFinancialSummaryTool(context, interval, { snapshot: async () => { throw new Error("Unexpected query during cooldown"); } })).complete, false);

  const requests = [];
  const fakeFetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return { ok: true, json: async () => request.previous_response_id ? completedObservation() : completedCall() };
  };
  const integrated = fixtures(databaseDouble(), { fetch: fakeFetch });
  const conversation = integrated.load(paths.conversation);
  const response = await conversation.processAgentMessage(context, { message: "Resume el período" });
  assert.equal(response.operation, "GET_PERIOD_FINANCIAL_SUMMARY");
  assert.equal(
    response.message,
    [
      "Período 2026-10-01 a 2026-10-31 (fechas incluidas).",
      "Ingresos: $ 6. Gastos confirmados: $ 5,01. Neto financiero (ingresos menos gastos): $ 0,99. Movimientos: 503.",
      "Los ingresos superaron a los gastos confirmados del período.",
    ].join("\n"),
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].parallel_tool_calls, false);
  assert.equal(requests[1].tool_choice, "none");
  const registeredTool = requests[0].tools.find((row) => row.name === "get_period_financial_summary");
  assert.equal(registeredTool.strict, true);
  assert.deepEqual(registeredTool.parameters.required, [
    "from", "to", "categoryLevel", "categoryName",
  ]);
  const call = await integrated.adapter.interpretExpenseMessage("Resumen");
  assert.equal(await integrated.adapter.explainPeriodFinancialSummary(call, result), "Los ingresos superaron a los gastos confirmados del período.");

  for (const status of ["incomplete", "failed", "cancelled", null]) {
    const adapter = fixtures(databaseDouble(), { fetch: async (_url, options) => ({
      ok: true,
      json: async () => JSON.parse(options.body).previous_response_id
        ? { ...completedObservation(), status }
        : { ...completedCall(), status },
    }) }).adapter;
    await assert.rejects(adapter.interpretExpenseMessage("Resumen"), { code: "INTERPRETATION_ERROR" });
    assert.equal(await adapter.explainPeriodFinancialSummary(call, result), null);
  }
  for (const bad of [
    { ...completedCall(), output: [{ type: "function_call", name: "unknown", call_id: "x", arguments: "{}" }] },
    { ...completedCall(), output: [...completedCall().output, ...completedCall().output] },
    { ...completedCall(), output: [{ type: "function_call", name: "get_period_financial_summary", call_id: "x", arguments: "{" }] },
  ]) {
    const adapter = fixtures(databaseDouble(), { fetch: async () => ({ ok: true, json: async () => bad }) }).adapter;
    await assert.rejects(adapter.interpretExpenseMessage("Resumen"), { code: "INTERPRETATION_ERROR" });
  }

  const diagnosticEvents = [];
  const originalWarn = console.warn;
  console.warn = (...args) => diagnosticEvents.push(args);
  try {
    const failedRequestAdapter = fixtures(databaseDouble(), {
      fetch: async () => ({ ok: false, status: 400 }),
    }).adapter;
    await assert.rejects(
      failedRequestAdapter.interpretExpenseMessage("Mensaje financiero privado de prueba"),
      { code: "INTERPRETATION_ERROR" },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(diagnosticEvents, [[
    "[agent-interpretation-diagnostic]",
    { stage: "http_rejected", status: 400 },
  ]]);
  assert.equal(JSON.stringify(diagnosticEvents).includes("privado"), false);
  assert.equal(JSON.stringify(diagnosticEvents).includes("local-fake-key"), false);
  console.log("PASS period summary snapshot, limits, cancellation, response states and integrated local flow");
}

main().catch((error) => {
  console.error("FAIL period financial summary functional harness:", error);
  process.exitCode = 1;
});
