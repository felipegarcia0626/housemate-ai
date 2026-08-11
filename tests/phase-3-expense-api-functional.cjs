const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const serviceModule = path.join(
  root,
  "modules",
  "expenses",
  "expense.service.ts",
);
const routeModule = path.join(root, "app", "api", "expenses", "route.ts");

const householdA = "41000000-0000-4000-8000-000000000001";
const householdB = "41000000-0000-4000-8000-000000000002";
const missingHousehold = "41000000-0000-4000-8000-000000000003";
const memberA = "41000000-0000-4000-8000-000000000011";
const memberB = "41000000-0000-4000-8000-000000000012";
const missingMember = "41000000-0000-4000-8000-000000000013";
const categoryA = "41000000-0000-4000-8000-000000000021";
const expenseNewer = "41000000-0000-4000-8000-000000000031";
const expenseOlder = "41000000-0000-4000-8000-000000000032";

const households = [{ id: householdA }, { id: householdB }];
const members = [
  { id: memberA, household_id: householdA },
  { id: memberB, household_id: householdB },
];
const categories = [{ id: categoryA, name: "Food" }];
const distributions = [
  { expense_id: expenseNewer, household_member_id: memberA },
  { expense_id: expenseOlder, household_member_id: memberA },
];
const baselineExpenses = [
  {
    id: expenseOlder,
    household_id: householdA,
    category_id: null,
    merchant: "Cafe",
    total_amount: "50.00",
    expense_date: "2026-08-05",
    status: "CONFIRMED",
    private_value: "must not be exposed",
  },
  {
    id: expenseNewer,
    household_id: householdA,
    category_id: categoryA,
    merchant: "Market",
    total_amount: "100.50",
    expense_date: "2026-08-10",
    status: "CONFIRMED",
    private_value: "must not be exposed",
  },
  {
    id: "41000000-0000-4000-8000-000000000033",
    household_id: householdA,
    category_id: null,
    merchant: "Cancelled",
    total_amount: "999.00",
    expense_date: "2026-08-11",
    status: "CANCELLED",
  },
  {
    id: "41000000-0000-4000-8000-000000000034",
    household_id: householdB,
    category_id: null,
    merchant: "Other household",
    total_amount: "500.00",
    expense_date: "2026-08-12",
    status: "CONFIRMED",
  },
];

let expenses = [...baselineExpenses];
let failedTable;
const observedOperations = [];

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
  }

  select(columns) {
    this.columns = columns;
    observedOperations.push({ type: "select", table: this.table, columns });
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "eq", column, value });
    observedOperations.push({
      type: "filter",
      table: this.table,
      operator: "eq",
      column,
      value,
    });
    return this;
  }

  gte(column, value) {
    this.filters.push({ operator: "gte", column, value });
    observedOperations.push({
      type: "filter",
      table: this.table,
      operator: "gte",
      column,
      value,
    });
    return this;
  }

  lte(column, value) {
    this.filters.push({ operator: "lte", column, value });
    observedOperations.push({
      type: "filter",
      table: this.table,
      operator: "lte",
      column,
      value,
    });
    return this;
  }

  in(column, values) {
    this.filters.push({ operator: "in", column, value: values });
    observedOperations.push({
      type: "filter",
      table: this.table,
      operator: "in",
      column,
      value: values,
    });
    return this;
  }

  order(column, options) {
    this.ordering = { column, ...options };
    observedOperations.push({
      type: "order",
      table: this.table,
      column,
      ...options,
    });
    return this;
  }

  insert() {
    observedOperations.push({ type: "insert", table: this.table });
    throw new Error("Unexpected insert");
  }

  update() {
    observedOperations.push({ type: "update", table: this.table });
    throw new Error("Unexpected update");
  }

  delete() {
    observedOperations.push({ type: "delete", table: this.table });
    throw new Error("Unexpected delete");
  }

  sourceRows() {
    if (this.table === "tb_households") return households;
    if (this.table === "tb_household_members") return members;
    if (this.table === "tb_expenses") return expenses;
    if (this.table === "tb_expense_distributions") return distributions;
    if (this.table === "tb_categories") return categories;
    return [];
  }

  execute() {
    if (failedTable === this.table) {
      return {
        data: null,
        error: {
          code: "42501",
          message: "sensitive Supabase/PostgreSQL table detail",
        },
      };
    }

    let rows = this.sourceRows().filter((row) =>
      this.filters.every(({ operator, column, value }) => {
        const current = row[column];
        if (operator === "eq") return current === value;
        if (operator === "in") return value.includes(current);
        const comparableCurrent =
          column === "expense_date" ? String(current) : Number(current);
        const comparableValue =
          column === "expense_date" ? String(value) : Number(value);
        if (operator === "gte") return comparableCurrent >= comparableValue;
        if (operator === "lte") return comparableCurrent <= comparableValue;
        return false;
      }),
    );

    if (this.ordering) {
      const direction = this.ordering.ascending ? 1 : -1;
      rows = [...rows].sort(
        (left, right) =>
          String(left[this.ordering.column]).localeCompare(
            String(right[this.ordering.column]),
          ) * direction,
      );
    }

    return { data: rows, error: null };
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
    observedOperations.push({ type: "from", table });
    return new FakeQuery(table);
  },
  rpc(name) {
    observedOperations.push({ type: "rpc", name });
    throw new Error("Unexpected RPC");
  },
};

function resolveTypeScriptModule(specifier, parentFile) {
  if (specifier.startsWith("@/")) {
    return path.join(root, `${specifier.slice(2)}.ts`);
  }
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(parentFile), `${specifier}.ts`);
  }
  return null;
}

function createTypeScriptLoader(overrides = new Map()) {
  const moduleCache = new Map();

  function loadTypeScriptModule(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (resolved === clientModule) {
      return { getSupabaseAdminClient: () => fakeClient };
    }
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

  return loadTypeScriptModule;
}

function request(query = "") {
  return new Request(`http://localhost/api/expenses${query}`);
}

async function readJson(response) {
  assert.equal(response.headers.get("content-type"), "application/json");
  return response.json();
}

async function expectError(route, query, status, code, message) {
  const response = await route.GET(request(query));
  assert.equal(response.status, status, query);
  const body = await readJson(response);
  assert.deepEqual(body, { error: { code, message } });
  const serialized = JSON.stringify(body);
  for (const secret of [
    "Supabase",
    "PostgreSQL",
    "42501",
    "tb_expenses",
    "sensitive",
    householdA,
  ]) {
    assert.ok(!serialized.includes(secret), `${query}: exposed ${secret}`);
  }
}

function hasOperation(expected) {
  return observedOperations.some((operation) =>
    Object.entries(expected).every(([key, value]) => operation[key] === value),
  );
}

async function main() {
  const previousHouseholdId = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;

  try {
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    const routeSource = fs.readFileSync(routeModule, "utf8");
    assert.ok(!routeSource.includes("expense.repository"));
    assert.ok(!routeSource.includes("database/client"));
    assert.ok(!routeSource.includes("supabase"));
    assert.ok(!routeSource.includes("process.env"));

    const route = createTypeScriptLoader()(routeModule);
    assert.deepEqual(Object.keys(route).sort(), ["GET"]);

    observedOperations.length = 0;
    const success = await route.GET(request());
    assert.equal(success.status, 200);
    const successBody = await readJson(success);
    assert.deepEqual(successBody, {
      data: [
        {
          id: expenseNewer,
          merchant: "Market",
          totalAmount: 100.5,
          expenseDate: "2026-08-10",
          category: { id: categoryA, name: "Food" },
        },
        {
          id: expenseOlder,
          merchant: "Cafe",
          totalAmount: 50,
          expenseDate: "2026-08-05",
          category: null,
        },
      ],
    });
    assert.equal(typeof successBody.data[0].totalAmount, "number");
    assert.doesNotThrow(() => JSON.stringify(successBody));
    assert.ok(
      hasOperation({
        type: "filter",
        table: "tb_expenses",
        column: "household_id",
        value: householdA,
      }),
    );
    assert.ok(
      hasOperation({
        type: "filter",
        table: "tb_expenses",
        column: "status",
        value: "CONFIRMED",
      }),
    );
    assert.ok(
      hasOperation({
        type: "select",
        table: "tb_expenses",
        columns: "id,category_id,merchant,total_amount,expense_date",
      }),
    );
    assert.equal(
      observedOperations.filter(
        ({ type, table }) => type === "from" && table === "tb_expenses",
      ).length,
      1,
    );
    console.log(
      "PASS GET without filters preserves domain order and exact public fields",
    );
    console.log(
      "PASS household isolation, CONFIRMED status and numeric serialization",
    );

    const filterCases = [
      ["?from=2026-08-01", "gte", "expense_date", "2026-08-01"],
      ["?to=2026-08-31", "lte", "expense_date", "2026-08-31"],
      [`?categoryId=${categoryA}`, "eq", "category_id", categoryA],
      [`?memberId=${memberA}`, "eq", "household_member_id", memberA],
      ["?merchant=Market", "eq", "merchant", "Market"],
      ["?minAmount=100.5", "gte", "total_amount", 100.5],
      ["?maxAmount=100.5", "lte", "total_amount", 100.5],
    ];
    for (const [query, operator, column, value] of filterCases) {
      observedOperations.length = 0;
      const response = await route.GET(request(query));
      assert.equal(response.status, 200, query);
      await readJson(response);
      assert.ok(
        hasOperation({ type: "filter", operator, column, value }),
        `missing filter for ${query}`,
      );
    }
    console.log("PASS every documented filter maps to the domain query");

    observedOperations.length = 0;
    const combinedQuery =
      `?from=2026-08-01&to=2026-08-31&categoryId=${categoryA}` +
      `&memberId=${memberA}&merchant=Market&minAmount=100&maxAmount=101`;
    const combined = await route.GET(request(combinedQuery));
    assert.equal(combined.status, 200);
    assert.equal((await readJson(combined)).data.length, 1);
    for (const column of [
      "expense_date",
      "category_id",
      "household_member_id",
      "merchant",
      "total_amount",
    ]) {
      assert.ok(hasOperation({ type: "filter", column }), column);
    }
    console.log("PASS all seven filters can be combined");

    expenses = [];
    const empty = await route.GET(request());
    assert.equal(empty.status, 200);
    assert.deepEqual(await readJson(empty), { data: [] });
    expenses = [...baselineExpenses];
    console.log("PASS empty result returns data array");

    for (const query of [
      "?from=2026-02-30",
      "?from=2026-08-10&to=2026-08-01",
      "?categoryId=invalid",
      "?minAmount=invalid",
      "?minAmount=-1",
      "?minAmount=Infinity",
      "?minAmount=200&maxAmount=100",
    ]) {
      await expectError(
        route,
        query,
        422,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
    }
    console.log("PASS domain validation errors map to sanitized HTTP 422");

    for (const query of [
      "?status=CONFIRMED",
      `?householdId=${householdB}`,
      "?foo=bar",
      "?from=2026-08-01&from=2026-08-02",
      `?memberId=${memberA}&memberId=${memberB}`,
    ]) {
      observedOperations.length = 0;
      await expectError(
        route,
        query,
        400,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
      assert.deepEqual(observedOperations, []);
    }
    for (const query of ["?minAmount=", "?maxAmount="]) {
      observedOperations.length = 0;
      await expectError(
        route,
        query,
        422,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
      assert.deepEqual(observedOperations, []);
    }
    console.log(
      "PASS unknown, repeated and empty numeric parameters fail before context/service",
    );

    observedOperations.length = 0;
    const ownMember = await route.GET(request(`?memberId=${memberA}`));
    assert.equal(ownMember.status, 200);
    assert.ok(
      hasOperation({
        type: "filter",
        table: "tb_household_members",
        column: "household_id",
        value: householdA,
      }),
    );
    for (const memberId of [missingMember, memberB]) {
      observedOperations.length = 0;
      await expectError(
        route,
        `?memberId=${memberId}`,
        404,
        "NOT_FOUND",
        "Recurso no encontrado.",
      );
      assert.ok(
        !observedOperations.some(
          ({ type, table }) => type === "from" && table === "tb_expenses",
        ),
      );
    }
    console.log(
      "PASS member filters enforce household membership without leakage",
    );

    for (const configuredHousehold of [
      undefined,
      "invalid",
      missingHousehold,
    ]) {
      if (configuredHousehold === undefined) {
        delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
      } else {
        process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = configuredHousehold;
      }
      observedOperations.length = 0;
      await expectError(
        route,
        "",
        500,
        "INTERNAL_ERROR",
        "No fue posible completar la operación.",
      );
      assert.ok(
        !observedOperations.some(
          ({ type, table }) => type === "from" && table === "tb_expenses",
        ),
      );
    }
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    console.log("PASS unavailable HTTP context maps to sanitized HTTP 500");

    failedTable = "tb_expenses";
    await expectError(
      route,
      "",
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
    failedTable = undefined;
    console.log("PASS repository failures are fully sanitized");

    const unexpectedError = new Error("private unexpected error", {
      cause: new Error("private cause"),
    });
    unexpectedError.stack = "private stack";
    const unexpectedRoute = createTypeScriptLoader(
      new Map([
        [
          serviceModule,
          {
            listExpenses: async () => {
              throw unexpectedError;
            },
          },
        ],
      ]),
    )(routeModule);
    await expectError(
      unexpectedRoute,
      "",
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
    console.log("PASS unexpected errors do not expose internal details");

    assert.ok(
      observedOperations.every(
        ({ type }) =>
          type === "from" ||
          type === "select" ||
          type === "filter" ||
          type === "order",
      ),
    );
    assert.ok(!observedOperations.some(({ type }) => type === "rpc"));
    console.log("PASS Route exports only GET and performs no writes or RPC");
  } finally {
    if (previousHouseholdId === undefined) {
      delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
    } else {
      process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = previousHouseholdId;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
