const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const routeModule = path.join(root, "app", "api", "sharing-rules", "route.ts");

const authUserA = "58000000-0000-4000-8000-000000000021";
const authUserB = "58000000-0000-4000-8000-000000000022";
const authUserWithoutMembership = "58000000-0000-4000-8000-000000000023";
const authUserWithMultipleMemberships = "58000000-0000-4000-8000-000000000024";
const authUserWithoutRules = "58000000-0000-4000-8000-000000000025";
const userA = "58000000-0000-4000-8000-000000000031";
const userB = "58000000-0000-4000-8000-000000000032";
const userWithoutMembership = "58000000-0000-4000-8000-000000000033";
const userWithMultipleMemberships = "58000000-0000-4000-8000-000000000034";
const userWithoutRules = "58000000-0000-4000-8000-000000000035";
const householdA = "58000000-0000-4000-8000-000000000001";
const householdB = "58000000-0000-4000-8000-000000000002";
const householdC = "58000000-0000-4000-8000-000000000003";
const householdD = "58000000-0000-4000-8000-000000000004";
const householdWithoutRules = "58000000-0000-4000-8000-000000000005";
const memberA1 = "58000000-0000-4000-8000-000000000011";
const memberA2 = "58000000-0000-4000-8000-000000000012";
const memberB = "58000000-0000-4000-8000-000000000013";

const users = [
  { id: userA, auth_user_id: authUserA },
  { id: userB, auth_user_id: authUserB },
  { id: userWithoutMembership, auth_user_id: authUserWithoutMembership },
  {
    id: userWithMultipleMemberships,
    auth_user_id: authUserWithMultipleMemberships,
  },
  { id: userWithoutRules, auth_user_id: authUserWithoutRules },
];

const members = [
  {
    id: memberA1,
    household_id: householdA,
    user_id: userA,
    display_name: "Member A1",
  },
  {
    id: memberA2,
    household_id: householdA,
    user_id: "58000000-0000-4000-8000-000000000036",
    display_name: "Member A2",
  },
  {
    id: memberB,
    household_id: householdB,
    user_id: userB,
    display_name: "Member B",
  },
  {
    id: "58000000-0000-4000-8000-000000000014",
    household_id: householdC,
    user_id: userWithMultipleMemberships,
    display_name: "Member C",
  },
  {
    id: "58000000-0000-4000-8000-000000000015",
    household_id: householdD,
    user_id: userWithMultipleMemberships,
    display_name: "Member D",
  },
  {
    id: "58000000-0000-4000-8000-000000000016",
    household_id: householdWithoutRules,
    user_id: userWithoutRules,
    display_name: "Context Member",
  },
];

const ruleA = "58000000-0000-4000-8000-000000000041";
const ruleB = "58000000-0000-4000-8000-000000000042";
const rules = [
  { id: ruleA, household_id: householdA, name: "60 / 40" },
  { id: ruleB, household_id: householdB, name: "100" },
];
const ruleMembers = [
  {
    sharing_rule_id: ruleA,
    household_member_id: memberA1,
    percentage: "60.00",
  },
  {
    sharing_rule_id: ruleA,
    household_member_id: memberA2,
    percentage: "40.00",
  },
  {
    sharing_rule_id: ruleB,
    household_member_id: memberB,
    percentage: "100.00",
  },
];

class FakeQuery {
  constructor(table, runtime) {
    this.table = table;
    this.runtime = runtime;
    this.filters = [];
  }

  select(columns) {
    this.runtime.operations.push({
      type: "select",
      table: this.table,
      columns,
    });
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

  in(column, values) {
    this.filters.push({ operator: "in", column, values });
    this.runtime.operations.push({
      type: "filter",
      table: this.table,
      operator: "in",
      column,
      values,
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
          : this.table === "tb_sharing_rules"
            ? rules
            : ruleMembers;
    return {
      data: source.filter((row) =>
        this.filters.every((filter) => {
          if (filter.operator === "eq")
            return row[filter.column] === filter.value;
          return filter.values.includes(row[filter.column]);
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
      ".insert(",
      ".update(",
      ".delete",
    ]) {
      assert.ok(!source.includes(forbidden), `Route contains ${forbidden}`);
    }
    assert.deepEqual(Object.keys(route), ["GET"]);

    runtime.operations.length = 0;
    const unauthenticated = await route.GET(
      new Request("http://localhost/api/sharing-rules"),
    );
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await readJson(unauthenticated), {
      error: {
        code: "UNAUTHENTICATED",
        message: "Se requiere una sesión autenticada.",
      },
    });
    assert.equal(runtime.operations.length, 0);
    console.log("PASS unauthenticated requests do not query sharing rules");

    runtime.authResponse = {
      data: { user: null },
      error: new AuthApiError("token expired", 401, "invalid_token"),
    };
    runtime.operations.length = 0;
    const expired = await route.GET();
    assert.equal(expired.status, 401);
    assert.equal((await readJson(expired)).error.code, "UNAUTHENTICATED");
    assert.equal(runtime.operations.length, 0);
    console.log("PASS expired sessions remain unauthenticated");

    runtime.authResponse = authResponse(
      "58000000-0000-4000-8000-000000000099",
    );
    runtime.operations.length = 0;
    const unlinkedUser = await route.GET();
    assert.equal(unlinkedUser.status, 403);
    assert.equal(
      (await readJson(unlinkedUser)).error.code,
      "APPLICATION_USER_NOT_FOUND",
    );
    console.log("PASS Auth users without application linkage are rejected");

    runtime.authResponse = authResponse(authUserWithoutMembership);
    runtime.operations.length = 0;
    const noMembership = await route.GET();
    assert.equal(noMembership.status, 403);
    assert.equal(
      (await readJson(noMembership)).error.code,
      "NO_ACTIVE_MEMBERSHIP",
    );
    console.log("PASS users without membership receive no data");

    runtime.authResponse = authResponse(authUserWithMultipleMemberships);
    runtime.operations.length = 0;
    const multipleMemberships = await route.GET();
    assert.equal(multipleMemberships.status, 409);
    assert.equal(
      (await readJson(multipleMemberships)).error.code,
      "HOUSEHOLD_SELECTION_REQUIRED",
    );
    console.log("PASS multiple memberships require selection");

    runtime.authResponse = authResponse(authUserA);
    runtime.operations.length = 0;
    const householdAResponse = await route.GET(
      new Request(
        `http://localhost/api/sharing-rules?householdId=${householdB}`,
      ),
    );
    assert.equal(householdAResponse.status, 200);
    assert.deepEqual(await readJson(householdAResponse), {
      data: [
        {
          id: ruleA,
          name: "60 / 40",
          type: "PERCENTAGE",
          splits: [
            { memberId: memberA1, percentage: 60 },
            { memberId: memberA2, percentage: 40 },
          ],
        },
      ],
    });
    assert.ok(
      runtime.operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_sharing_rules" &&
          operation.operator === "eq" &&
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
    console.log("PASS authenticated user A receives only household A rules");

    runtime.authResponse = authResponse(authUserB);
    runtime.operations.length = 0;
    const householdBResponse = await route.GET();
    assert.equal(householdBResponse.status, 200);
    assert.deepEqual(await readJson(householdBResponse), {
      data: [
        {
          id: ruleB,
          name: "100",
          type: "PERCENTAGE",
          splits: [{ memberId: memberB, percentage: 100 }],
        },
      ],
    });
    assert.ok(
      runtime.operations.some(
        (operation) =>
          operation.type === "filter" &&
          operation.table === "tb_sharing_rules" &&
          operation.column === "household_id" &&
          operation.value === householdB,
      ),
    );
    console.log("PASS authenticated user B receives only household B rules");

    runtime.authResponse = authResponse(authUserWithoutRules);
    runtime.operations.length = 0;
    const empty = await route.GET();
    assert.equal(empty.status, 200);
    assert.deepEqual(await readJson(empty), { data: [] });
    console.log("PASS authenticated empty household preserves the empty DTO");

    runtime.authResponse = authResponse(authUserA);
    runtime.failedTable = "tb_sharing_rules";
    const persistence = await route.GET();
    assert.equal(persistence.status, 500);
    assert.deepEqual(await readJson(persistence), {
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
    const provider = await route.GET();
    assert.equal(provider.status, 500);
    assert.deepEqual(await readJson(provider), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    console.log("PASS provider errors remain sanitized");
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
