const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const routeModule = path.join(root, "app", "api", "balance", "route.ts");

const authUserA = "53000000-0000-4000-8000-000000000021";
const authUserB = "53000000-0000-4000-8000-000000000022";
const authUserWithoutMembership = "53000000-0000-4000-8000-000000000023";
const authUserWithMultipleMemberships = "53000000-0000-4000-8000-000000000024";
const authUserWithoutBalanceMembers = "53000000-0000-4000-8000-000000000025";
const userA = "53000000-0000-4000-8000-000000000031";
const userB = "53000000-0000-4000-8000-000000000032";
const userWithoutMembership = "53000000-0000-4000-8000-000000000033";
const userWithMultipleMemberships = "53000000-0000-4000-8000-000000000034";
const userWithoutBalanceMembers = "53000000-0000-4000-8000-000000000035";
const householdA = "53000000-0000-4000-8000-000000000001";
const householdB = "53000000-0000-4000-8000-000000000002";
const householdC = "53000000-0000-4000-8000-000000000003";
const householdD = "53000000-0000-4000-8000-000000000004";
const householdWithoutBalanceMembers =
  "53000000-0000-4000-8000-000000000005";
const memberA = "53000000-0000-4000-8000-000000000011";
const memberB = "53000000-0000-4000-8000-000000000012";
const memberC = "53000000-0000-4000-8000-000000000013";
const memberBHouseholdB = "53000000-0000-4000-8000-000000000015";

const users = [
  { id: userA, auth_user_id: authUserA },
  { id: userB, auth_user_id: authUserB },
  { id: userWithoutMembership, auth_user_id: authUserWithoutMembership },
  {
    id: userWithMultipleMemberships,
    auth_user_id: authUserWithMultipleMemberships,
  },
  {
    id: userWithoutBalanceMembers,
    auth_user_id: authUserWithoutBalanceMembers,
  },
];
const members = [
  { id: memberA, household_id: householdA, user_id: userA },
  {
    id: memberB,
    household_id: householdA,
    user_id: "53000000-0000-4000-8000-000000000036",
  },
  { id: memberBHouseholdB, household_id: householdB, user_id: userB },
  {
    id: memberC,
    household_id: householdC,
    user_id: userWithMultipleMemberships,
  },
  {
    id: "53000000-0000-4000-8000-000000000014",
    household_id: householdD,
    user_id: userWithMultipleMemberships,
  },
  {
    id: "53000000-0000-4000-8000-000000000016",
    household_id: householdWithoutBalanceMembers,
    user_id: userWithoutBalanceMembers,
  },
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
    paid_by: memberBHouseholdB,
    total_amount: "999.00",
    tb_expense_distributions: [
      { household_member_id: memberBHouseholdB, amount: "999.00" },
    ],
  },
];

class FakeQuery {
  constructor(table, runtime) {
    this.table = table;
    this.runtime = runtime;
    this.filters = [];
    this.selectedColumns = undefined;
  }

  select(columns) {
    this.selectedColumns = columns;
    this.runtime.operations.push({
      type: "select",
      table: this.table,
      columns,
    });
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value });
    this.runtime.operations.push({
      type: "filter",
      table: this.table,
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
          : expenses;
    const householdFilter = this.filters.find(
      (filter) => filter.column === "household_id",
    );
    if (
      this.table === "tb_household_members" &&
      this.selectedColumns === "id" &&
      householdFilter?.value === householdWithoutBalanceMembers
    ) {
      return { data: [], error: null };
    }
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

function createLoader(runtime) {
  const moduleCache = new Map();

  function load(filename) {
    const resolved = path.resolve(filename);
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
            auth: {
              getUser: async () => runtime.authResponse,
            },
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

async function readJson(response) {
  assert.equal(response.headers.get("content-type"), "application/json");
  return response.json();
}

function authResponse(id) {
  return { data: { user: { id } }, error: null };
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
  const load = createLoader(runtime);
  const route = load(routeModule);

  try {
    const source = fs.readFileSync(routeModule, "utf8");
    for (const forbidden of [
      "getConfiguredHttpHouseholdContext",
      "HOUSEMATE_MVP_HOUSEHOLD_ID",
      "process.env",
      "database/client",
      ".from(",
      ".rpc(",
    ]) {
      assert.ok(!source.includes(forbidden), `Route contains ${forbidden}`);
    }
    assert.deepEqual(Object.keys(route), ["GET"]);

    runtime.operations.length = 0;
    const unauthenticated = await route.GET(
      new Request("http://localhost/api/balance?householdId=" + householdA),
    );
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await readJson(unauthenticated), {
      error: {
        code: "UNAUTHENTICATED",
        message: "Se requiere una sesión autenticada.",
      },
    });
    assert.equal(
      runtime.operations.some((operation) =>
        ["tb_users", "tb_household_members", "tb_expenses"].includes(
          operation.table,
        ),
      ),
      false,
    );
    console.log("PASS unauthenticated requests never use the MVP household");

    runtime.authResponse = {
      data: { user: null },
      error: new AuthApiError("token expired", 401, "invalid_token"),
    };
    runtime.operations.length = 0;
    const expired = await route.GET();
    assert.equal(expired.status, 401);
    assert.equal((await readJson(expired)).error.code, "UNAUTHENTICATED");
    assert.equal(runtime.operations.length, 0);
    console.log("PASS expired sessions are not downgraded to the MVP context");

    runtime.authResponse = authResponse(authUserWithoutMembership);
    runtime.operations.length = 0;
    const unlinkedMembership = await route.GET();
    assert.equal(unlinkedMembership.status, 403);
    assert.equal(
      (await readJson(unlinkedMembership)).error.code,
      "NO_ACTIVE_MEMBERSHIP",
    );
    console.log("PASS authenticated users without membership receive no data");

    runtime.authResponse = authResponse(
      "53000000-0000-4000-8000-000000000099",
    );
    runtime.operations.length = 0;
    const unlinkedUser = await route.GET();
    assert.equal(unlinkedUser.status, 403);
    assert.equal(
      (await readJson(unlinkedUser)).error.code,
      "APPLICATION_USER_NOT_FOUND",
    );
    console.log(
      "PASS authenticated users without application linkage are rejected",
    );

    runtime.authResponse = authResponse(authUserWithMultipleMemberships);
    runtime.operations.length = 0;
    const multipleMemberships = await route.GET();
    assert.equal(multipleMemberships.status, 409);
    assert.equal(
      (await readJson(multipleMemberships)).error.code,
      "HOUSEHOLD_SELECTION_REQUIRED",
    );
    console.log("PASS multiple memberships require explicit selection");

    runtime.authResponse = authResponse(authUserA);
    runtime.operations.length = 0;
    const householdAResponse = await route.GET(
      new Request("http://localhost/api/balance?householdId=" + householdB),
    );
    assert.equal(householdAResponse.status, 200);
    assert.deepEqual(await readJson(householdAResponse), {
      data: {
        members: [
          { memberId: memberA, paid: 100, share: 50, balance: 50 },
          { memberId: memberB, paid: 0, share: 50, balance: -50 },
        ],
      },
    });
    assert.ok(
      runtime.operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_household_members" &&
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
          operation.type === "filter" &&
          operation.value === householdB,
      ),
      false,
    );
    assert.equal(
      runtime.operations.filter((operation) => operation.type === "rpc").length,
      0,
    );
    console.log("PASS authenticated user A receives only household A Balance");

    runtime.authResponse = authResponse(authUserB);
    runtime.operations.length = 0;
    const householdBResponse = await route.GET();
    assert.equal(householdBResponse.status, 200);
    assert.deepEqual(await readJson(householdBResponse), {
      data: {
        members: [
          { memberId: memberBHouseholdB, paid: 999, share: 999, balance: 0 },
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
    console.log("PASS authenticated user B receives only household B Balance");

    runtime.authResponse = authResponse(authUserWithoutBalanceMembers);
    runtime.operations.length = 0;
    const emptyBalance = await route.GET();
    assert.equal(emptyBalance.status, 200);
    assert.deepEqual(await readJson(emptyBalance), {
      data: { members: [] },
    });
    console.log("PASS authenticated empty Balance preserves the empty DTO");

    runtime.authResponse = authResponse(authUserA);
    runtime.failedTable = "tb_expenses";
    const technical = await route.GET();
    assert.equal(technical.status, 500);
    assert.deepEqual(await readJson(technical), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    runtime.failedTable = undefined;
    console.log("PASS persistence errors remain sanitized");

    runtime.authResponse = {
      data: { user: null },
      error: new AuthApiError("provider unavailable", 500, "server_error"),
    };
    const providerError = await route.GET();
    assert.equal(providerError.status, 500);
    assert.deepEqual(await readJson(providerError), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    console.log("PASS provider errors remain sanitized");

    const calculateBalance = load(
      path.join(root, "modules/expenses/balance-calculator.ts"),
    ).calculateBalance;
    const largeExpenses = Array.from({ length: 91 }, () => ({
      paidByMemberId: memberA,
      totalAmount: "999999999999.99",
      distributions: [{ memberId: memberA, amount: "999999999999.99" }],
    }));
    assert.throws(
      () => calculateBalance([memberA], largeExpenses),
      /safe numeric range/,
    );
    console.log("PASS Balance rejects unsafe aggregate serialization");
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
