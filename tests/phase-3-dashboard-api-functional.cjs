const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const routeModule = path.join(
  root,
  "app",
  "api",
  "dashboard",
  "summary",
  "route.ts",
);
const householdA = "54000000-0000-4000-8000-000000000001";
const householdB = "54000000-0000-4000-8000-000000000002";
const memberA = "54000000-0000-4000-8000-000000000011";
const operations = [];
let failedTable;
const members = [
  { id: memberA, household_id: householdA },
  { id: "54000000-0000-4000-8000-000000000012", household_id: householdA },
];
const households = [{ id: householdA }, { id: householdB }];
const incomes = [
  {
    member_id: memberA,
    amount: "1500.00",
    household_id: householdA,
    income_date: "2026-08-01",
  },
];
const expenses = [
  {
    household_id: householdA,
    status: "CONFIRMED",
    total_amount: "500.00",
    category_id: "54000000-0000-4000-8000-000000000021",
    category: {
      id: "54000000-0000-4000-8000-000000000021",
      name: "Food",
    },
    items: [],
  },
];

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
    this.filters.push({ op: "eq", column, value });
    operations.push({ type: "filter", table: this.table, column, value });
    return this;
  }
  gte(column, value) {
    this.filters.push({ op: "gte", column, value });
    operations.push({ type: "filter", table: this.table, column, value });
    return this;
  }
  lte(column, value) {
    this.filters.push({ op: "lte", column, value });
    operations.push({ type: "filter", table: this.table, column, value });
    return this;
  }
  maybeSingle() {
    const result = this.execute();
    return Promise.resolve({
      data: result.error ? null : (result.data[0] ?? null),
      error: result.error,
    });
  }
  execute() {
    if (failedTable === this.table)
      return {
        data: null,
        error: { code: "42501", message: "private detail" },
      };
    const source =
      this.table === "tb_households"
        ? households
        : this.table === "tb_household_members"
          ? members
          : this.table === "tb_incomes"
            ? incomes
            : expenses;
    const data = source.filter((row) =>
      this.filters.every((f) =>
        f.op === "eq"
          ? row[f.column] === f.value
          : f.op === "gte"
            ? row[f.column] >= f.value
            : row[f.column] <= f.value,
      ),
    );
    return { data, error: null };
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
  rpc() {
    throw new Error("Unexpected RPC");
  },
};

function loader(overrides = new Map()) {
  const cache = new Map();
  function load(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (resolved === clientModule)
      return { getSupabaseAdminClient: () => fakeClient };
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const loaded = { exports: {} };
    cache.set(resolved, loaded);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: resolved,
    }).outputText;
    const localRequire = (specifier) =>
      specifier.startsWith("@/")
        ? load(path.join(root, `${specifier.slice(2)}.ts`))
        : specifier.startsWith(".")
          ? load(path.resolve(path.dirname(resolved), `${specifier}.ts`))
          : require(specifier);
    new Function("require", "module", "exports", output)(
      localRequire,
      loaded,
      loaded.exports,
    );
    return loaded.exports;
  }
  return load;
}

async function json(response) {
  assert.equal(response.headers.get("content-type"), "application/json");
  return response.json();
}

async function main() {
  const previous = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  try {
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    const source = fs.readFileSync(routeModule, "utf8");
    for (const forbidden of [
      "supabase",
      "database/client",
      ".from(",
      ".rpc(",
      ".insert(",
      ".update(",
      ".delete",
    ])
      assert.ok(!source.includes(forbidden), `Route contains ${forbidden}`);
    const route = loader()(routeModule);
    assert.deepEqual(Object.keys(route), ["GET"]);
    operations.length = 0;
    const response = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), {
      data: {
        totalIncome: 1500,
        totalSpent: 500,
        netAmount: 1000,
        expenseCount: 1,
        memberIncome: [{ memberId: memberA, amount: 1500 }],
        byCategory: [
          {
            categoryId: "54000000-0000-4000-8000-000000000021",
            categoryName: "Food",
            amount: 500,
          },
        ],
      },
    });
    assert.ok(
      operations.every((op) => op.type !== "rpc" && op.type !== "write"),
    );
    assert.ok(
      operations.some(
        (op) =>
          op.type === "filter" &&
          op.table === "tb_incomes" &&
          op.column === "household_id" &&
          op.value === householdA,
      ),
    );
    console.log(
      "PASS Dashboard GET returns public DTO, applies filters and ignores client household",
    );

    operations.length = 0;
    const filtered = await route.GET(
      new Request(
        "http://localhost/api/dashboard/summary?from=2026-01-01&to=2026-12-31",
      ),
    );
    assert.equal(filtered.status, 200);
    assert.ok(
      operations.some(
        (op) =>
          op.type === "filter" &&
          op.table === "tb_incomes" &&
          op.column === "income_date" &&
          op.value === "2026-01-01",
      ),
    );
    assert.ok(
      operations.some(
        (op) =>
          op.type === "filter" &&
          op.table === "tb_expenses" &&
          op.column === "expense_date" &&
          op.value === "2026-12-31",
      ),
    );
    console.log("PASS Dashboard forwards from/to filters as strings");

    for (const url of [
      "?householdId=" + householdB,
      "?unknown=x",
      "?from=2026-01-01&from=2026-02-01",
    ]) {
      operations.length = 0;
      const invalid = await route.GET(
        new Request("http://localhost/api/dashboard/summary" + url),
      );
      assert.equal(invalid.status, 422);
      assert.deepEqual(await json(invalid), {
        error: { code: "VALIDATION_ERROR", message: "Solicitud inválida." },
      });
      assert.equal(operations.length, 0);
    }
    console.log("PASS Dashboard rejects unknown and repeated parameters");

    for (const url of ["?from=2026-02-30", "?from=2026-12-31&to=2026-01-01"]) {
      const invalid = await route.GET(
        new Request("http://localhost/api/dashboard/summary" + url),
      );
      assert.equal(invalid.status, 422);
      assert.equal((await json(invalid)).error.code, "VALIDATION_ERROR");
    }
    console.log("PASS Dashboard validates dates and range");

    failedTable = "tb_expenses";
    const failed = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(failed.status, 500);
    assert.deepEqual(await json(failed), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    console.log("PASS Dashboard errors are sanitized");

    const empty = loader(
      new Map([
        [
          path.resolve(
            path.join(root, "modules/dashboard/dashboard.service.ts"),
          ),
          {
            getDashboard: async () => ({
              totalIncome: 0,
              totalSpent: 0,
              netAmount: 0,
              expenseCount: 0,
              memberIncome: [],
              byCategory: [],
            }),
          },
        ],
      ]),
    )(routeModule);
    assert.deepEqual(
      await json(
        await empty.GET(new Request("http://localhost/api/dashboard/summary")),
      ),
      {
        data: {
          totalIncome: 0,
          totalSpent: 0,
          netAmount: 0,
          expenseCount: 0,
          memberIncome: [],
          byCategory: [],
        },
      },
    );
    console.log("PASS Dashboard empty result");

    for (const configured of [
      undefined,
      "invalid",
      "54000000-0000-4000-8000-000000000099",
    ]) {
      if (configured === undefined)
        delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
      else process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = configured;
      const invalidContext = await route.GET(
        new Request("http://localhost/api/dashboard/summary"),
      );
      assert.equal(invalidContext.status, 500);
      assert.equal((await json(invalidContext)).error.code, "INTERNAL_ERROR");
    }
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    console.log("PASS Dashboard sanitizes context errors");

    const unexpected = loader(
      new Map([
        [
          path.resolve(
            path.join(root, "modules/dashboard/dashboard.service.ts"),
          ),
          {
            getDashboard: async () => {
              throw new Error("secret internal detail");
            },
          },
        ],
      ]),
    )(routeModule);
    const unexpectedResponse = await unexpected.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(unexpectedResponse.status, 500);
    const unexpectedBody = await json(unexpectedResponse);
    assert.equal(unexpectedBody.error.code, "INTERNAL_ERROR");
    assert.ok(
      !JSON.stringify(unexpectedBody).includes("secret internal detail"),
    );
    console.log("PASS Dashboard sanitizes unexpected errors");
  } finally {
    if (previous === undefined) delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
    else process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = previous;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
