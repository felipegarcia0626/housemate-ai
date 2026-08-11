const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const serviceModule = path.join(
  root,
  "modules",
  "incomes",
  "income.service.ts",
);
const routeModule = path.join(root, "app", "api", "incomes", "route.ts");

const householdA = "42000000-0000-4000-8000-000000000001";
const householdB = "42000000-0000-4000-8000-000000000002";
const missingHousehold = "42000000-0000-4000-8000-000000000003";
const memberA = "42000000-0000-4000-8000-000000000011";
const memberB = "42000000-0000-4000-8000-000000000012";
const missingMember = "42000000-0000-4000-8000-000000000013";
const categoryA = "42000000-0000-4000-8000-000000000021";
const missingCategory = "42000000-0000-4000-8000-000000000022";
const incomeFirst = "42000000-0000-4000-8000-000000000031";
const incomeSecond = "42000000-0000-4000-8000-000000000032";
const incomeThird = "42000000-0000-4000-8000-000000000033";

const households = [{ id: householdA }, { id: householdB }];
const members = [
  { id: memberA, household_id: householdA },
  { id: memberB, household_id: householdB },
];
const baselineIncomes = [
  {
    id: incomeThird,
    household_id: householdA,
    created_by: memberA,
    member_id: memberA,
    amount: "30.03",
    income_date: "2026-08-02",
    description: "Older",
    category_id: null,
    created_at: "2026-08-02T12:00:00+00:00",
    updated_at: "2026-08-02T12:00:00+00:00",
  },
  {
    id: incomeSecond,
    household_id: householdA,
    created_by: memberA,
    member_id: memberA,
    amount: "20.02",
    income_date: "2026-08-03",
    description: "Same timestamp second ID",
    category_id: categoryA,
    created_at: "2026-08-03T13:00:00+00:00",
    updated_at: "2026-08-03T13:00:00+00:00",
  },
  {
    id: incomeFirst,
    household_id: householdA,
    created_by: memberA,
    member_id: memberA,
    amount: "10.01",
    income_date: "2026-08-03",
    description: "Same timestamp first ID",
    category_id: categoryA,
    created_at: "2026-08-03T13:00:00+00:00",
    updated_at: "2026-08-03T13:00:00+00:00",
  },
  {
    id: "42000000-0000-4000-8000-000000000034",
    household_id: householdB,
    created_by: memberB,
    member_id: memberB,
    amount: "999.99",
    income_date: "2026-08-04",
    description: "Other household",
    category_id: null,
    created_at: "2026-08-04T14:00:00+00:00",
    updated_at: "2026-08-04T14:00:00+00:00",
  },
];

let incomes = [...baselineIncomes];
let failedTable;
const observedOperations = [];

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orderings = [];
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

  order(column, options) {
    this.orderings.push({ column, ...options });
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
    if (this.table === "tb_incomes") return incomes;
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
        if (operator === "gte") return String(current) >= String(value);
        if (operator === "lte") return String(current) <= String(value);
        return false;
      }),
    );

    if (this.orderings.length > 0) {
      rows = [...rows].sort((left, right) => {
        for (const ordering of this.orderings) {
          const comparison = String(left[ordering.column]).localeCompare(
            String(right[ordering.column]),
          );
          if (comparison !== 0)
            return ordering.ascending ? comparison : -comparison;
        }
        return 0;
      });
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
  return new Request(`http://localhost/api/incomes${query}`);
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
    "tb_incomes",
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
    assert.ok(!routeSource.includes("income.repository"));
    assert.ok(!routeSource.includes("database/client"));
    assert.ok(!routeSource.includes("supabase"));
    assert.ok(!routeSource.includes("process.env"));
    assert.ok(!routeSource.includes("category.service"));

    const route = createTypeScriptLoader()(routeModule);
    assert.deepEqual(Object.keys(route).sort(), ["GET"]);

    observedOperations.length = 0;
    const success = await route.GET(request());
    assert.equal(success.status, 200);
    const successBody = await readJson(success);
    assert.deepEqual(successBody, {
      data: [
        {
          id: incomeFirst,
          createdBy: memberA,
          memberId: memberA,
          amount: 10.01,
          incomeDate: "2026-08-03",
          description: "Same timestamp first ID",
          categoryId: categoryA,
        },
        {
          id: incomeSecond,
          createdBy: memberA,
          memberId: memberA,
          amount: 20.02,
          incomeDate: "2026-08-03",
          description: "Same timestamp second ID",
          categoryId: categoryA,
        },
        {
          id: incomeThird,
          createdBy: memberA,
          memberId: memberA,
          amount: 30.03,
          incomeDate: "2026-08-02",
          description: "Older",
          categoryId: null,
        },
      ],
      summary: { totalIncome: 60.06 },
    });
    for (const item of successBody.data) {
      assert.deepEqual(Object.keys(item).sort(), [
        "amount",
        "categoryId",
        "createdBy",
        "description",
        "id",
        "incomeDate",
        "memberId",
      ]);
      assert.equal(typeof item.amount, "number");
      assert.ok(!Object.hasOwn(item, "householdId"));
      assert.ok(!Object.hasOwn(item, "createdAt"));
      assert.ok(!Object.hasOwn(item, "updatedAt"));
    }
    assert.equal(typeof successBody.summary.totalIncome, "number");
    assert.doesNotThrow(() => JSON.stringify(successBody));
    assert.ok(
      hasOperation({
        type: "filter",
        table: "tb_incomes",
        column: "household_id",
        value: householdA,
      }),
    );
    assert.deepEqual(
      observedOperations
        .filter(({ type, table }) => type === "order" && table === "tb_incomes")
        .map(({ column, ascending }) => ({ column, ascending })),
      [
        { column: "income_date", ascending: false },
        { column: "created_at", ascending: false },
        { column: "id", ascending: true },
      ],
    );
    assert.equal(
      observedOperations.filter(
        ({ type, table }) => type === "from" && table === "tb_incomes",
      ).length,
      1,
    );
    console.log("PASS GET returns exact DTO, summary and deterministic order");
    console.log("PASS household isolation and numeric JSON serialization");

    const filterCases = [
      ["?from=2026-08-02", "gte", "income_date", "2026-08-02"],
      ["?to=2026-08-03", "lte", "income_date", "2026-08-03"],
      [`?memberId=${memberA}`, "eq", "member_id", memberA],
      [`?categoryId=${categoryA}`, "eq", "category_id", categoryA],
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
    console.log("PASS every documented filter maps to Income Read");

    observedOperations.length = 0;
    const combined = await route.GET(
      request(
        `?from=2026-08-03&to=2026-08-03&memberId=${memberA}&categoryId=${categoryA}`,
      ),
    );
    assert.equal(combined.status, 200);
    assert.equal((await readJson(combined)).data.length, 2);
    for (const column of ["income_date", "member_id", "category_id"]) {
      assert.ok(hasOperation({ type: "filter", column }), column);
    }
    console.log("PASS all four filters can be combined");

    incomes = [];
    const empty = await route.GET(request());
    assert.equal(empty.status, 200);
    assert.deepEqual(await readJson(empty), {
      data: [],
      summary: { totalIncome: 0 },
    });
    incomes = [...baselineIncomes];

    const missingCategoryResponse = await route.GET(
      request(`?categoryId=${missingCategory}`),
    );
    assert.equal(missingCategoryResponse.status, 200);
    assert.deepEqual(await readJson(missingCategoryResponse), {
      data: [],
      summary: { totalIncome: 0 },
    });
    console.log(
      "PASS empty and unmatched category results preserve zero summary",
    );

    for (const query of [
      "?from=2026-02-30",
      "?from=2026-08-03&to=2026-08-02",
      "?memberId=invalid",
      "?categoryId=invalid",
      "?from=",
      "?to=",
      "?memberId=",
      "?categoryId=",
    ]) {
      await expectError(
        route,
        query,
        422,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
    }
    console.log("PASS domain filter validation maps to sanitized HTTP 422");

    for (const query of [
      "?foo=bar",
      "?status=CONFIRMED",
      `?householdId=${householdB}`,
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
    console.log(
      "PASS unknown and repeated parameters fail before Context/Service",
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
          ({ type, table }) => type === "from" && table === "tb_incomes",
        ),
      );
    }
    console.log(
      "PASS member filtering enforces household membership without leakage",
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
          ({ type, table }) => type === "from" && table === "tb_incomes",
        ),
      );
    }
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    console.log("PASS unavailable context maps to sanitized HTTP 500");

    failedTable = "tb_incomes";
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
            listIncomes: async () => {
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
    console.log("PASS unexpected failures do not expose internal details");

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
