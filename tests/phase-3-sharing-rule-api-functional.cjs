const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const routeModule = path.join(root, "app", "api", "sharing-rules", "route.ts");
const householdA = "52000000-0000-4000-8000-000000000001";
const householdB = "52000000-0000-4000-8000-000000000002";
const ruleA = "52000000-0000-4000-8000-000000000011";
const ruleB = "52000000-0000-4000-8000-000000000012";
const operations = [];
let failedTable;
const households = [{ id: householdA }, { id: householdB }];
const rules = [
  { id: ruleA, household_id: householdA, name: "50/50" },
  { id: ruleB, household_id: householdB, name: "Other household" },
];
const members = [
  {
    sharing_rule_id: ruleA,
    household_member_id: "member-a",
    percentage: "50.00",
  },
  {
    sharing_rule_id: ruleA,
    household_member_id: "member-b",
    percentage: "50.00",
  },
  {
    sharing_rule_id: ruleB,
    household_member_id: "member-c",
    percentage: "100.00",
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
    this.filters.push({ operator: "eq", column, value });
    operations.push({
      type: "filter",
      table: this.table,
      operator: "eq",
      column,
      value,
    });
    return this;
  }
  in(column, values) {
    this.filters.push({ operator: "in", column, values });
    operations.push({
      type: "filter",
      table: this.table,
      operator: "in",
      column,
      values,
    });
    return this;
  }
  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
  maybeSingle() {
    const result = this.execute();
    return Promise.resolve({
      data: result.error ? null : (result.data[0] ?? null),
      error: result.error,
    });
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
        : this.table === "tb_sharing_rules"
          ? rules
          : members;
    const data = source.filter((row) =>
      this.filters.every((filter) => {
        if (filter.operator === "eq")
          return row[filter.column] === filter.value;
        return filter.values.includes(row[filter.column]);
      }),
    );
    return { data, error: null };
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

async function json(response) {
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
      "sharing-rule.repository",
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
    const response = await route.GET();
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), {
      data: [
        {
          id: ruleA,
          name: "50/50",
          type: "PERCENTAGE",
          splits: [
            { memberId: "member-a", percentage: 50 },
            { memberId: "member-b", percentage: 50 },
          ],
        },
      ],
    });
    assert.ok(
      operations.some(
        (op) =>
          op.type === "filter" &&
          op.column === "household_id" &&
          op.value === householdA,
      ),
    );
    assert.equal(operations.filter((op) => op.type === "rpc").length, 0);
    assert.equal(
      operations.filter(
        (op) =>
          op.type === "insert" || op.type === "update" || op.type === "delete",
      ).length,
      0,
    );
    console.log(
      "PASS Sharing Rules GET returns isolated public DTO without writes or RPC",
    );

    const emptyRules = loader(
      new Map([
        [
          path.resolve(
            path.join(root, "modules/sharing-rules/sharing-rule.service.ts"),
          ),
          { listSharingRules: async () => [] },
        ],
      ]),
    )(routeModule);
    assert.deepEqual(await json(await emptyRules.GET()), { data: [] });
    console.log("PASS empty Sharing Rules result");

    for (const configured of [
      undefined,
      "invalid",
      "52000000-0000-4000-8000-000000000099",
    ]) {
      if (configured === undefined)
        delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
      else process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = configured;
      const failed = await route.GET();
      assert.equal(failed.status, 500);
      assert.deepEqual(await json(failed), {
        error: {
          code: "INTERNAL_ERROR",
          message: "No fue posible completar la operación.",
        },
      });
    }
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    failedTable = "tb_sharing_rules";
    const technical = await route.GET();
    assert.equal(technical.status, 500);
    assert.deepEqual(await json(technical), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    failedTable = undefined;
    console.log("PASS context and persistence errors are sanitized");
  } finally {
    if (previous === undefined) delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
    else process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = previous;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
