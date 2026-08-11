const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const adapterModule = path.join(root, "app", "api", "_lib", "http-context.ts");

const householdA = "40000000-0000-4000-8000-000000000001";
const householdB = "40000000-0000-4000-8000-000000000002";
const missingHousehold = "40000000-0000-4000-8000-000000000003";
const memberA = "40000000-0000-4000-8000-000000000011";
const memberB = "40000000-0000-4000-8000-000000000012";
const missingMember = "40000000-0000-4000-8000-000000000013";

const households = [{ id: householdA }, { id: householdB }];
const members = [
  { id: memberA, household_id: householdA },
  { id: memberB, household_id: householdB },
];

const observedOperations = [];
let failedTable;

class FakeContextQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
  }

  select(columns) {
    this.columns = columns;
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value });
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

  maybeSingle() {
    observedOperations.push({
      type: "select",
      table: this.table,
      columns: this.columns,
      filters: [...this.filters],
    });

    if (failedTable === this.table) {
      return Promise.resolve({
        data: null,
        error: {
          code: "42501",
          message: "sensitive Supabase/PostgreSQL detail",
        },
      });
    }

    const source =
      this.table === "tb_households"
        ? households
        : this.table === "tb_household_members"
          ? members
          : [];
    const row = source.find((candidate) =>
      this.filters.every(({ column, value }) => candidate[column] === value),
    );

    return Promise.resolve({ data: row ? { id: row.id } : null, error: null });
  }
}

const fakeClient = {
  from(table) {
    observedOperations.push({ type: "from", table });
    return new FakeContextQuery(table);
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

function loadTypeScriptModuleFactory() {
  const moduleCache = new Map();

  function loadTypeScriptModule(filename) {
    const resolved = path.resolve(filename);

    if (resolved === clientModule) {
      return { getSupabaseAdminClient: () => fakeClient };
    }
    if (moduleCache.has(resolved)) {
      return moduleCache.get(resolved).exports;
    }

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

async function expectContextError(name, operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.code, expectedCode, `${name}: unexpected error code`);
    assert.ok(!error.message.includes("HOUSEMATE_MVP"));
    assert.ok(!error.message.includes("Supabase"));
    assert.ok(!error.message.includes("42501"));
    return;
  }

  assert.fail(`${name}: expected ${expectedCode}`);
}

function setConfiguredContext(householdId, memberId) {
  if (householdId === undefined) {
    delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  } else {
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdId;
  }

  if (memberId === undefined) {
    delete process.env.HOUSEMATE_MVP_MEMBER_ID;
  } else {
    process.env.HOUSEMATE_MVP_MEMBER_ID = memberId;
  }
}

async function main() {
  const previousHouseholdId = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  const previousMemberId = process.env.HOUSEMATE_MVP_MEMBER_ID;

  try {
    const loadTypeScriptModule = loadTypeScriptModuleFactory();
    const { getConfiguredHttpActorContext, getConfiguredHttpHouseholdContext } =
      loadTypeScriptModule(adapterModule);

    setConfiguredContext(householdA, memberA);
    observedOperations.length = 0;
    assert.deepEqual(await getConfiguredHttpHouseholdContext(), {
      householdId: householdA,
    });
    assert.deepEqual(observedOperations, [
      { type: "from", table: "tb_households" },
      {
        type: "select",
        table: "tb_households",
        columns: "id",
        filters: [{ column: "id", value: householdA }],
      },
    ]);
    console.log("PASS valid configured household context");

    observedOperations.length = 0;
    assert.deepEqual(await getConfiguredHttpActorContext(), {
      householdId: householdA,
      memberId: memberA,
    });
    assert.deepEqual(observedOperations, [
      { type: "from", table: "tb_households" },
      {
        type: "select",
        table: "tb_households",
        columns: "id",
        filters: [{ column: "id", value: householdA }],
      },
      { type: "from", table: "tb_household_members" },
      {
        type: "select",
        table: "tb_household_members",
        columns: "id",
        filters: [
          { column: "id", value: memberA },
          { column: "household_id", value: householdA },
        ],
      },
    ]);
    console.log("PASS valid configured actor is isolated by household");

    observedOperations.length = 0;
    setConfiguredContext(undefined, memberA);
    await expectContextError(
      "missing household variable",
      () => getConfiguredHttpHouseholdContext(),
      "CONFIGURATION_ERROR",
    );
    assert.deepEqual(observedOperations, []);

    setConfiguredContext(householdA, undefined);
    await expectContextError(
      "missing member variable",
      () => getConfiguredHttpActorContext(),
      "CONFIGURATION_ERROR",
    );

    setConfiguredContext("", memberA);
    await expectContextError(
      "empty household variable",
      () => getConfiguredHttpHouseholdContext(),
      "CONFIGURATION_ERROR",
    );

    setConfiguredContext(householdA, "");
    await expectContextError(
      "empty member variable",
      () => getConfiguredHttpActorContext(),
      "CONFIGURATION_ERROR",
    );

    setConfiguredContext("invalid", memberA);
    await expectContextError(
      "invalid household UUID",
      () => getConfiguredHttpHouseholdContext(),
      "CONFIGURATION_ERROR",
    );

    setConfiguredContext(householdA, "invalid");
    await expectContextError(
      "invalid member UUID",
      () => getConfiguredHttpActorContext(),
      "CONFIGURATION_ERROR",
    );
    console.log("PASS missing, empty and invalid configuration is rejected");

    setConfiguredContext(missingHousehold, memberA);
    await expectContextError(
      "missing household",
      () => getConfiguredHttpHouseholdContext(),
      "CONFIGURATION_ERROR",
    );

    setConfiguredContext(householdA, missingMember);
    await expectContextError(
      "missing member",
      () => getConfiguredHttpActorContext(),
      "CONFIGURATION_ERROR",
    );

    setConfiguredContext(householdA, memberB);
    observedOperations.length = 0;
    await expectContextError(
      "member from another household",
      () => getConfiguredHttpActorContext(),
      "CONFIGURATION_ERROR",
    );
    const memberQuery = observedOperations.find(
      ({ type, table }) =>
        type === "select" && table === "tb_household_members",
    );
    assert.ok(memberQuery);
    assert.deepEqual(memberQuery.filters, [
      { column: "id", value: memberB },
      { column: "household_id", value: householdA },
    ]);
    console.log("PASS missing and cross-household records are rejected");

    setConfiguredContext(householdA, memberA);
    failedTable = "tb_households";
    await expectContextError(
      "technical repository failure",
      () => getConfiguredHttpHouseholdContext(),
      "PERSISTENCE_ERROR",
    );
    failedTable = undefined;
    console.log("PASS technical repository errors are sanitized");

    const hypotheticalRequest = {
      body: { householdId: householdB, memberId: memberB },
      headers: { householdId: householdB, memberId: memberB },
      query: { householdId: householdB, memberId: memberB },
    };
    assert.deepEqual(await getConfiguredHttpActorContext(hypotheticalRequest), {
      householdId: householdA,
      memberId: memberA,
    });
    console.log("PASS hypothetical request values cannot override context");

    assert.ok(
      observedOperations.every(
        ({ table }) =>
          table === undefined ||
          table === "tb_households" ||
          table === "tb_household_members",
      ),
    );
    assert.ok(
      observedOperations.every(
        ({ type }) => type === "from" || type === "select",
      ),
    );
    console.log("PASS context validation uses only approved read operations");
  } finally {
    setConfiguredContext(previousHouseholdId, previousMemberId);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
