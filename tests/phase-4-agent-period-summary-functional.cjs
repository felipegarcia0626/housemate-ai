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
  validation: file("modules/dashboard/dashboard.validation.ts"),
  tool: file("modules/agent/tools/get-period-financial-summary.tool.ts"),
};
const realFiles = new Set([
  paths.adapter, paths.agentTypes, paths.conversation, paths.repository,
  paths.presentation, paths.service, paths.dashboardTypes, paths.validation,
  paths.tool,
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
const interval = { from: "2026-10-01", to: "2026-10-31" };
const defaultRows = {
  tb_expenses: Array.from({ length: 501 }, () => ({ total_amount: "0.01" })),
  tb_incomes: [{ amount: "3.00" }, { amount: "3.00" }],
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
    const state = { table, from: 0, to: 499 };
    const query = {};
    for (const method of ["select", "eq", "gte", "lte", "order", "range", "abortSignal"]) {
      query[method] = (...args) => {
        operations.push([method, table, ...args]);
        if (method === "range") [state.from, state.to] = args;
        return query;
      };
    }
    query.then = (resolve, reject) => {
      const key = `${table}:${state.from}`;
      if (failures[key]) return Promise.resolve({ data: null, error: failures[key], count: null }).then(resolve, reject);
      if (invalid[key]) return Promise.resolve(invalid[key]).then(resolve, reject);
      const allRows = rowsByTable[table] ?? [];
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

  const thirtyTwoDayPeriod = { from: "2026-01-01", to: "2026-02-01" };
  assert.deepEqual(tool.parsePeriodFinancialSummaryArguments(thirtyTwoDayPeriod), thirtyTwoDayPeriod);
  const thirtyTwoDayDb = databaseDouble({
    rows: {
      tb_expenses: [{ expense_date: thirtyTwoDayPeriod.from, total_amount: "2.00" }],
      tb_incomes: [{ income_date: thirtyTwoDayPeriod.to, amount: "3.00" }],
    },
  });
  const thirtyTwoDaySummary = await fixtures(thirtyTwoDayDb).tool
    .getPeriodFinancialSummaryTool(context, thirtyTwoDayPeriod);
  assert.deepEqual([
    thirtyTwoDaySummary.complete,
    thirtyTwoDaySummary.totalIncome,
    thirtyTwoDaySummary.totalSpent,
    thirtyTwoDaySummary.incomeCount,
    thirtyTwoDaySummary.expenseCount,
  ], [true, 3, 2, 1, 1]);

  const maximumPeriod = { from: "2024-01-01", to: "2024-12-31" };
  assert.deepEqual(tool.parsePeriodFinancialSummaryArguments(maximumPeriod), maximumPeriod);
  const maximumPeriodDb = databaseDouble({
    rows: {
      tb_expenses: [
        { expense_date: maximumPeriod.from, total_amount: "0.01" },
        { expense_date: maximumPeriod.to, total_amount: "0.02" },
      ],
      tb_incomes: [
        { income_date: maximumPeriod.from, amount: "1.00" },
        { income_date: maximumPeriod.to, amount: "2.00" },
      ],
    },
  });
  const maximumPeriodSummary = await fixtures(maximumPeriodDb).tool
    .getPeriodFinancialSummaryTool(context, maximumPeriod);
  assert.deepEqual([
    maximumPeriodSummary.complete,
    maximumPeriodSummary.totalIncome,
    maximumPeriodSummary.totalSpent,
    maximumPeriodSummary.incomeCount,
    maximumPeriodSummary.expenseCount,
  ], [true, 3, 0.03, 2, 2]);
  assert.ok(operation(maximumPeriodDb, "gte", "tb_expenses", ([field, value]) =>
    field === "expense_date" && value === maximumPeriod.from));
  assert.ok(operation(maximumPeriodDb, "lte", "tb_expenses", ([field, value]) =>
    field === "expense_date" && value === maximumPeriod.to));
  assert.ok(operation(maximumPeriodDb, "gte", "tb_incomes", ([field, value]) =>
    field === "income_date" && value === maximumPeriod.from));
  assert.ok(operation(maximumPeriodDb, "lte", "tb_incomes", ([field, value]) =>
    field === "income_date" && value === maximumPeriod.to));

  const tooLongPeriod = { from: "2024-01-01", to: "2025-01-01" };
  assert.equal(tool.parsePeriodFinancialSummaryArguments(tooLongPeriod), null);
  const tooLongDb = databaseDouble({ rows: { tb_expenses: [], tb_incomes: [] } });
  const tooLongSummary = await fixtures(tooLongDb).tool
    .getPeriodFinancialSummaryTool(context, tooLongPeriod);
  assert.deepEqual(tooLongSummary, { ...tooLongPeriod, complete: false });
  assert.equal(tooLongDb.operations.length, 0);
  const result = await tool.getPeriodFinancialSummaryTool(context, interval);
  assert.deepEqual([result.complete, result.totalIncome, result.totalSpent, result.netAmount, result.movementCount], [true, 6, 5.01, 0.99, 503]);
  assert.equal(db.operations.filter((entry) => entry[0] === "from" && entry[1] === "tb_expenses").length, 2);
  assert.equal(db.operations.filter((entry) => entry[0] === "from" && entry[1] === "tb_incomes").length, 1);
  expectedSelect(db, "tb_expenses", "total_amount");
  expectedSelect(db, "tb_incomes", "amount");

  const empty = fixtureForRows([], []);
  assert.deepEqual(await empty.tool.getPeriodFinancialSummaryTool(context, interval), {
    ...interval, complete: true, totalIncome: 0, totalSpent: 0, netAmount: 0,
    incomeCount: 0, expenseCount: 0, movementCount: 0,
  });

  for (const bad of [
    fixtureForRows([{ total_amount: 20 }], []),
    fixtureForRows([{ unexpected: "1.00" }], []),
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
    assert.deepEqual(await bad.tool.getPeriodFinancialSummaryTool(context, interval), { ...interval, complete: false });
  }

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
  assert.equal(requests[1].tool_choice, "none");
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
  console.log("PASS period summary snapshot, limits, cancellation, response states and integrated local flow");
}

main().catch((error) => {
  console.error("FAIL period financial summary functional harness:", error);
  process.exitCode = 1;
});
