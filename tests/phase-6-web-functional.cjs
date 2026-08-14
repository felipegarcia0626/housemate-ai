const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const page = fs.readFileSync(
  path.join(__dirname, "..", "app", "page.tsx"),
  "utf8",
);
const clientModule = path.join(
  __dirname,
  "..",
  "infrastructure",
  "database",
  "client.ts",
);
const membersRouteModule = path.join(
  __dirname,
  "..",
  "app",
  "api",
  "household-members",
  "route.ts",
);
const householdA = "56000000-0000-4000-8000-000000000001";
const householdB = "56000000-0000-4000-8000-000000000002";
const members = [
  {
    id: "56000000-0000-4000-8000-000000000011",
    household_id: householdA,
    display_name: "Felipe",
  },
  {
    id: "56000000-0000-4000-8000-000000000012",
    household_id: householdB,
    display_name: "Otra persona",
  },
];
const operations = [];
let failedTable;

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
        ? [{ id: householdA }, { id: householdB }]
        : members;
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

function loadTypeScriptModule(filename, overrides = new Map()) {
  const cache = new Map();
  function load(resolvedFilename) {
    const resolved = path.resolve(resolvedFilename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (resolved === path.resolve(clientModule))
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
        return load(path.join(__dirname, "..", specifier.slice(2) + ".ts"));
      if (specifier.startsWith("."))
        return load(path.resolve(path.dirname(resolved), specifier + ".ts"));
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
  return response.json();
}

for (const endpoint of [
  "/api/dashboard/summary",
  "/api/expenses",
  "/api/incomes",
  "/api/categories",
  "/api/sharing-rules",
  "/api/balance",
]) {
  if (!page.includes(endpoint))
    throw new Error(`Missing UI API integration: ${endpoint}`);
}

for (const operation of ["POST", "PATCH", "DELETE"]) {
  if (!page.includes(`method: \"${operation}\"`))
    throw new Error(`Missing UI mutation: ${operation}`);
}

for (const forbidden of [
  "getSupabaseAdminClient",
  ".from(",
  ".rpc(",
  "householdId",
]) {
  if (page.includes(forbidden))
    throw new Error(`UI must not contain ${forbidden}`);
}

for (const label of [
  "Dashboard",
  "Gastos",
  "Ingresos",
  "Balance",
  "Crear gasto",
  "Crear ingreso",
]) {
  if (!page.includes(label)) throw new Error(`Missing UI label: ${label}`);
}

if (!page.includes("value={incomeForm.memberId}"))
  throw new Error("UI must preserve member IDs as form values");

async function main() {
  const previous = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  try {
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    const routeSource = fs.readFileSync(membersRouteModule, "utf8");
    for (const forbidden of [
      "getSupabaseAdminClient",
      "database/client",
      ".from(",
      ".rpc(",
      ".insert(",
      ".update(",
      ".delete(",
    ]) {
      if (routeSource.includes(forbidden))
        throw new Error("Members route contains " + forbidden);
    }
    const route = loadTypeScriptModule(membersRouteModule)(membersRouteModule);
    operations.length = 0;
    const response = await route.GET(
      new Request(
        "http://localhost/api/household-members?householdId=" + householdB,
      ),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      data: [
        {
          id: members[0].id,
          displayName: members[0].display_name,
        },
      ],
    });
    assert.ok(
      operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_household_members" &&
          operation.column === "household_id" &&
          operation.value === householdA,
      ),
    );
    assert.ok(
      operations.some(
        (operation) =>
          operation.type === "select" &&
          operation.table === "tb_household_members" &&
          operation.columns === "id,display_name",
      ),
    );
    assert.equal(
      operations.filter((operation) => operation.type === "rpc").length,
      0,
    );
    assert.equal(
      operations.filter((operation) =>
        ["insert", "update", "delete"].includes(operation.type),
      ).length,
      0,
    );
    console.log(
      "PASS Household Members GET isolates the configured household and maps display names",
    );

    failedTable = "tb_household_members";
    const failed = await route.GET();
    assert.equal(failed.status, 500);
    assert.deepEqual(await readJson(failed), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operaciÃ³n.",
      },
    });
    console.log("PASS Household Members errors are sanitized");
  } finally {
    failedTable = undefined;
    if (previous === undefined) delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
    else process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = previous;
  }

  console.log(
    "PASS Web/PWA loads APIs independently, resolves member names, and isolates section errors",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
