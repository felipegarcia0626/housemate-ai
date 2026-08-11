const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const routeModule = path.join(root, "app", "api", "balance", "route.ts");
const householdA = "53000000-0000-4000-8000-000000000001";
const householdB = "53000000-0000-4000-8000-000000000002";
const memberA = "53000000-0000-4000-8000-000000000011";
const memberB = "53000000-0000-4000-8000-000000000012";
const operations = [];
let failedTable;
const households = [{ id: householdA }, { id: householdB }];
const members = [
  { id: memberA, household_id: householdA },
  { id: memberB, household_id: householdA },
];
const expenses = [
  {
    household_id: householdA,
    status: "CONFIRMED",
    paid_by: memberA,
    total_amount: "100.00",
    tb_expense_distributions: [
      { household_member_id: memberA, amount: "50.00" },
      { household_member_id: memberB, amount: "50.00" },
    ],
  },
  {
    household_id: householdB,
    status: "CONFIRMED",
    paid_by: memberB,
    total_amount: "999.00",
    tb_expense_distributions: [],
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
        ? households
        : this.table === "tb_household_members"
          ? members
          : expenses;
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

function loader(overrides = new Map()) {
  const cache = new Map();
  function load(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (resolved === clientModule)
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
        return load(path.join(root, `${specifier.slice(2)}.ts`));
      if (specifier.startsWith("."))
        return load(path.resolve(path.dirname(resolved), `${specifier}.ts`));
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
  assert.equal(response.headers.get("content-type"), "application/json");
  return response.json();
}

async function main() {
  const previous = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  try {
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    const source = fs.readFileSync(routeModule, "utf8");
    const forbiddenPatterns = [
      "supabase",
      "database/client",
      "balance.repository",
      ".from(",
      ".rpc(",
      ".insert(",
      ".update(",
      ".delete",
    ];
    for (const forbidden of forbiddenPatterns) {
      assert.ok(!source.includes(forbidden), `Route contains ${forbidden}`);
    }
    const route = loader()(routeModule);
    assert.deepEqual(Object.keys(route), ["GET"]);
    operations.length = 0;
    const response = await route.GET(
      new Request("http://localhost/api/balance?householdId=" + householdB),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      data: {
        members: [
          { memberId: memberA, paid: 100, share: 50, balance: 50 },
          { memberId: memberB, paid: 0, share: 50, balance: -50 },
        ],
      },
    });
    assert.ok(
      operations.some(
        (op) =>
          op.type === "filter" &&
          op.table === "tb_household_members" &&
          op.column === "household_id" &&
          op.value === householdA,
      ),
    );
    assert.ok(
      operations.some(
        (op) =>
          op.type === "filter" &&
          op.table === "tb_expenses" &&
          op.column === "household_id" &&
          op.value === householdA,
      ),
    );
    assert.equal(operations.filter((op) => op.type === "rpc").length, 0);
    console.log(
      "PASS Balance GET returns exact isolated DTO and ignores client household",
    );

    const empty = loader(
      new Map([
        [
          path.resolve(path.join(root, "modules/expenses/balance.service.ts")),
          { getBalance: async () => ({ members: [] }) },
        ],
      ]),
    )(routeModule);
    assert.deepEqual(await readJson(await empty.GET()), {
      data: { members: [] },
    });
    console.log("PASS empty Balance result");

    for (const configured of [
      undefined,
      "invalid",
      "53000000-0000-4000-8000-000000000099",
    ]) {
      if (configured === undefined)
        delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
      else process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = configured;
      const failed = await route.GET();
      assert.equal(failed.status, 500);
      assert.deepEqual(await readJson(failed), {
        error: {
          code: "INTERNAL_ERROR",
          message: "No fue posible completar la operación.",
        },
      });
    }
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    failedTable = "tb_expenses";
    const technical = await route.GET();
    assert.equal(technical.status, 500);
    assert.deepEqual(await readJson(technical), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    console.log("PASS Balance context and persistence errors are sanitized");
  } finally {
    if (previous === undefined) delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
    else process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = previous;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
