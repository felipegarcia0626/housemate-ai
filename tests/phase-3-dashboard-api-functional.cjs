const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const routeModule = path.join(
  root,
  "app",
  "api",
  "dashboard",
  "summary",
  "route.ts",
);
const dashboardServiceModule = path.join(
  root,
  "modules",
  "dashboard",
  "dashboard.service.ts",
);

const authUserA = "58000000-0000-4000-8000-000000000021";
const authUserB = "58000000-0000-4000-8000-000000000022";
const authUserWithoutApplicationUser = "58000000-0000-4000-8000-000000000023";
const authUserWithoutMembership = "58000000-0000-4000-8000-000000000024";
const authUserWithMultipleMemberships = "58000000-0000-4000-8000-000000000025";
const authUserEmptyHousehold = "58000000-0000-4000-8000-000000000026";

const userA = "58000000-0000-4000-8000-000000000031";
const userB = "58000000-0000-4000-8000-000000000032";
const userWithoutMembership = "58000000-0000-4000-8000-000000000034";
const userWithMultipleMemberships = "58000000-0000-4000-8000-000000000035";
const userEmptyHousehold = "58000000-0000-4000-8000-000000000036";

const householdA = "58000000-0000-4000-8000-000000000001";
const householdB = "58000000-0000-4000-8000-000000000002";
const householdEmpty = "58000000-0000-4000-8000-000000000003";
const householdMultipleA = "58000000-0000-4000-8000-000000000004";
const householdMultipleB = "58000000-0000-4000-8000-000000000005";

const memberA = "58000000-0000-4000-8000-000000000011";
const memberB = "58000000-0000-4000-8000-000000000012";

const users = [
  { id: userA, auth_user_id: authUserA },
  { id: userB, auth_user_id: authUserB },
  { id: userWithoutMembership, auth_user_id: authUserWithoutMembership },
  {
    id: userWithMultipleMemberships,
    auth_user_id: authUserWithMultipleMemberships,
  },
  { id: userEmptyHousehold, auth_user_id: authUserEmptyHousehold },
];

const members = [
  { id: memberA, household_id: householdA, user_id: userA },
  { id: memberB, household_id: householdB, user_id: userB },
  {
    id: "58000000-0000-4000-8000-000000000013",
    household_id: householdMultipleA,
    user_id: userWithMultipleMemberships,
  },
  {
    id: "58000000-0000-4000-8000-000000000014",
    household_id: householdMultipleB,
    user_id: userWithMultipleMemberships,
  },
  {
    id: "58000000-0000-4000-8000-000000000015",
    household_id: householdEmpty,
    user_id: userEmptyHousehold,
  },
];

const incomes = [
  {
    member_id: memberA,
    amount: "1500.00",
    household_id: householdA,
    income_date: "2026-08-01",
  },
  {
    member_id: memberA,
    amount: "20.50",
    household_id: householdA,
    income_date: "2026-08-15",
  },
  {
    member_id: memberB,
    amount: "700.00",
    household_id: householdB,
    income_date: "2026-08-01",
  },
];

const expenses = [
  {
    household_id: householdA,
    status: "CONFIRMED",
    total_amount: "500.00",
    expense_date: "2026-08-02",
    category_id: "58000000-0000-4000-8000-000000000021",
    category: {
      id: "58000000-0000-4000-8000-000000000021",
      name: "Food",
    },
    items: [],
  },
  {
    household_id: householdA,
    status: "PENDING",
    total_amount: "900.00",
    expense_date: "2026-08-02",
    category_id: null,
    category: null,
    items: [],
  },
  {
    household_id: householdB,
    status: "CONFIRMED",
    total_amount: "100.00",
    expense_date: "2026-08-03",
    category_id: null,
    category: null,
    items: [],
  },
];

class FakeQuery {
  constructor(table, runtime) {
    this.table = table;
    this.runtime = runtime;
    this.filters = [];
  }

  select(columns) {
    this.runtime.operations.push({ type: "select", table: this.table, columns });
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "eq", column, value });
    this.runtime.operations.push({
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
    this.runtime.operations.push({
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
    this.runtime.operations.push({
      type: "filter",
      table: this.table,
      operator: "lte",
      column,
      value,
    });
    return this;
  }

  execute() {
    if (this.runtime.failedTable === this.table) {
      return {
        data: null,
        error: { code: "42501", message: "private database detail" },
      };
    }

    const source =
      this.table === "tb_users"
        ? users
        : this.table === "tb_household_members"
          ? members
          : this.table === "tb_incomes"
            ? incomes
            : expenses;
    return {
      data: source.filter((row) =>
        this.filters.every((filter) => {
          if (filter.operator === "eq") return row[filter.column] === filter.value;
          if (filter.operator === "gte") return row[filter.column] >= filter.value;
          return row[filter.column] <= filter.value;
        }),
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

function createLoader(runtime, overrides = new Map()) {
  const moduleCache = new Map();

  function load(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
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

    const fakeClient = {
      from(table) {
        runtime.operations.push({ type: "from", table });
        return new FakeQuery(table, runtime);
      },
      rpc(name) {
        runtime.operations.push({ type: "rpc", name });
        throw new Error("Unexpected RPC");
      },
    };

    const localRequire = (specifier) => {
      if (specifier === "@supabase/ssr") {
        return {
          createServerClient: () => ({
            auth: { getUser: async () => runtime.authResponse },
          }),
        };
      }
      if (specifier === "next/headers") {
        return {
          cookies: async () => ({
            getAll: () => [],
            set: () => undefined,
          }),
        };
      }
      if (specifier === "@/infrastructure/database/client") {
        return { getSupabaseAdminClient: () => fakeClient };
      }
      if (specifier.startsWith("@/")) {
        return load(path.join(root, `${specifier.slice(2)}.ts`));
      }
      if (specifier.startsWith(".")) {
        return load(path.resolve(path.dirname(resolved), `${specifier}.ts`));
      }
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

function authResponse(id) {
  return { data: { user: { id } }, error: null };
}

async function readJson(response) {
  assert.equal(response.headers.get("content-type"), "application/json");
  return response.json();
}

async function main() {
  const { AuthApiError, AuthSessionMissingError } = require(
    "@supabase/supabase-js",
  );
  const previousMvpHousehold = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  const previousSupabaseUrl = process.env.SUPABASE_URL;
  const previousSupabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdB;
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "test-anon-key";

  const runtime = {
    authResponse: {
      data: { user: null },
      error: new AuthSessionMissingError(),
    },
    failedTable: undefined,
    operations: [],
  };
  const route = createLoader(runtime)(routeModule);

  try {
    const source = fs.readFileSync(routeModule, "utf8");
    for (const forbidden of [
      "getConfiguredHttpHouseholdContext",
      "HOUSEMATE_MVP_HOUSEHOLD_ID",
      "process.env",
      "database/client",
      ".from(",
      ".rpc(",
      ".insert(",
      ".update(",
      ".delete",
    ]) {
      assert.ok(!source.includes(forbidden), `Route contains ${forbidden}`);
    }
    assert.deepEqual(Object.keys(route), ["GET"]);

    const noSession = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(noSession.status, 401);
    assert.equal((await readJson(noSession)).error.code, "UNAUTHENTICATED");
    assert.equal(runtime.operations.length, 0);
    console.log("PASS unauthenticated Dashboard requests return 401");

    runtime.authResponse = {
      data: { user: null },
      error: new AuthApiError("token expired", 401, "invalid_token"),
    };
    runtime.operations.length = 0;
    const expired = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(expired.status, 401);
    assert.equal((await readJson(expired)).error.code, "UNAUTHENTICATED");
    assert.equal(runtime.operations.length, 0);
    console.log("PASS expired Dashboard sessions return 401");

    runtime.authResponse = authResponse(authUserWithoutApplicationUser);
    runtime.operations.length = 0;
    const unlinked = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(unlinked.status, 403);
    assert.equal((await readJson(unlinked)).error.code, "APPLICATION_USER_NOT_FOUND");
    console.log("PASS unlinked Auth users return 403");

    runtime.authResponse = authResponse(authUserWithoutMembership);
    runtime.operations.length = 0;
    const noMembership = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(noMembership.status, 403);
    assert.equal((await readJson(noMembership)).error.code, "NO_ACTIVE_MEMBERSHIP");
    console.log("PASS users without active membership return 403");

    runtime.authResponse = authResponse(authUserWithMultipleMemberships);
    runtime.operations.length = 0;
    const multipleMemberships = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(multipleMemberships.status, 409);
    assert.equal(
      (await readJson(multipleMemberships)).error.code,
      "HOUSEHOLD_SELECTION_REQUIRED",
    );
    console.log("PASS multiple memberships return 409");

    runtime.authResponse = authResponse(authUserA);
    runtime.operations.length = 0;
    const householdAResponse = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(householdAResponse.status, 200);
    assert.deepEqual(await readJson(householdAResponse), {
      data: {
        totalIncome: 1520.5,
        totalSpent: 500,
        netAmount: 1020.5,
        expenseCount: 1,
        memberIncome: [{ memberId: memberA, amount: 1520.5 }],
        byCategory: [
          {
            categoryId: "58000000-0000-4000-8000-000000000021",
            categoryName: "Food",
            amount: 500,
          },
        ],
      },
    });
    assert.ok(
      runtime.operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_incomes" &&
          operation.column === "household_id" &&
          operation.value === householdA,
      ),
    );
    assert.ok(
      runtime.operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_expenses" &&
          operation.column === "household_id" &&
          operation.value === householdA,
      ),
    );
    assert.equal(
      runtime.operations.some(
        (operation) =>
          operation.type === "filter" && operation.value === householdB,
      ),
      false,
    );
    assert.equal(
      runtime.operations.some((operation) =>
        ["insert", "update", "delete", "rpc"].includes(operation.type),
      ),
      false,
    );
    console.log("PASS authenticated Dashboard uses only household A");

    runtime.operations.length = 0;
    const forbiddenHousehold = await route.GET(
      new Request(
        `http://localhost/api/dashboard/summary?householdId=${householdB}`,
      ),
    );
    assert.equal(forbiddenHousehold.status, 422);
    assert.equal((await readJson(forbiddenHousehold)).error.code, "VALIDATION_ERROR");
    assert.equal(runtime.operations.length, 0);
    console.log("PASS client householdId cannot change authenticated context");

    runtime.authResponse = authResponse(authUserB);
    runtime.operations.length = 0;
    const householdBResponse = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(householdBResponse.status, 200);
    assert.deepEqual(await readJson(householdBResponse), {
      data: {
        totalIncome: 700,
        totalSpent: 100,
        netAmount: 600,
        expenseCount: 1,
        memberIncome: [{ memberId: memberB, amount: 700 }],
        byCategory: [
          { categoryId: null, categoryName: null, amount: 100 },
        ],
      },
    });
    assert.ok(
      runtime.operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_expenses" &&
          operation.column === "household_id" &&
          operation.value === householdB,
      ),
    );
    console.log("PASS authenticated Dashboard isolates household B");

    runtime.authResponse = authResponse(authUserEmptyHousehold);
    runtime.operations.length = 0;
    const empty = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(await readJson(empty), {
      data: {
        totalIncome: 0,
        totalSpent: 0,
        netAmount: 0,
        expenseCount: 0,
        memberIncome: [],
        byCategory: [],
      },
    });
    console.log("PASS authenticated empty Dashboard preserves zero DTO");

    runtime.authResponse = authResponse(authUserA);
    runtime.operations.length = 0;
    const filtered = await route.GET(
      new Request(
        "http://localhost/api/dashboard/summary?from=2026-08-01&to=2026-08-10",
      ),
    );
    assert.equal(filtered.status, 200);
    assert.ok(
      runtime.operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_incomes" &&
          operation.column === "income_date" &&
          operation.operator === "gte" &&
          operation.value === "2026-08-01",
      ),
    );
    assert.ok(
      runtime.operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_expenses" &&
          operation.column === "expense_date" &&
          operation.operator === "lte" &&
          operation.value === "2026-08-10",
      ),
    );
    console.log("PASS Dashboard forwards inclusive from/to filters");

    for (const url of ["?from=2026-08-01", "?to=2026-08-10"]) {
      const partial = await route.GET(
        new Request("http://localhost/api/dashboard/summary" + url),
      );
      assert.equal(partial.status, 200);
    }
    console.log("PASS Dashboard supports partial date filters");

    for (const url of [
      "?from=2026-02-30",
      "?from=2026-12-31&to=2026-01-01",
    ]) {
      const invalid = await route.GET(
        new Request("http://localhost/api/dashboard/summary" + url),
      );
      assert.equal(invalid.status, 422);
      assert.equal((await readJson(invalid)).error.code, "VALIDATION_ERROR");
    }
    console.log("PASS Dashboard validates partial, invalid and inverted date filters");

    for (const url of [
      "?unknown=x",
      "?householdId=" + householdB,
      "?from=2026-01-01&from=2026-02-01",
    ]) {
      runtime.operations.length = 0;
      const invalid = await route.GET(
        new Request("http://localhost/api/dashboard/summary" + url),
      );
      assert.equal(invalid.status, 422);
      assert.deepEqual(await readJson(invalid), {
        error: { code: "VALIDATION_ERROR", message: "Solicitud inválida." },
      });
      assert.equal(runtime.operations.length, 0);
    }
    console.log("PASS Dashboard rejects unknown and repeated parameters");

    runtime.failedTable = "tb_expenses";
    const persistence = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(persistence.status, 500);
    assert.deepEqual(await readJson(persistence), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    runtime.failedTable = undefined;
    console.log("PASS Dashboard persistence errors remain sanitized");

    runtime.authResponse = {
      data: { user: null },
      error: new AuthApiError("provider unavailable", 500, "server_error"),
    };
    const provider = await route.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(provider.status, 500);
    assert.deepEqual(await readJson(provider), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    console.log("PASS Dashboard provider errors remain sanitized");

    const unexpected = createLoader(
      runtime,
      new Map([
        [
          path.resolve(dashboardServiceModule),
          {
            getDashboard: async () => {
              throw new Error("secret internal detail");
            },
          },
        ],
      ]),
    )(routeModule);
    runtime.authResponse = authResponse(authUserA);
    const unexpectedResponse = await unexpected.GET(
      new Request("http://localhost/api/dashboard/summary"),
    );
    assert.equal(unexpectedResponse.status, 500);
    const unexpectedBody = await readJson(unexpectedResponse);
    assert.equal(unexpectedBody.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(unexpectedBody).includes("secret internal detail"));
    console.log("PASS Dashboard unexpected errors remain sanitized");
  } finally {
    if (previousMvpHousehold === undefined)
      delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
    else process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = previousMvpHousehold;
    if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousSupabaseUrl;
    if (previousSupabaseAnonKey === undefined)
      delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = previousSupabaseAnonKey;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
