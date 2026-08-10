const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const householdA = "26000000-0000-4000-8000-000000000001";
const householdB = "26000000-0000-4000-8000-000000000002";
const memberA1 = "26000000-0000-4000-8000-000000000021";
const memberA2 = "26000000-0000-4000-8000-000000000022";
const memberAWithoutIncome = "26000000-0000-4000-8000-000000000024";
const memberB = "26000000-0000-4000-8000-000000000023";
const categorySalary = "26000000-0000-4000-8000-000000000031";
const categoryFreelance = "26000000-0000-4000-8000-000000000032";

const members = [
  { id: memberA1, household_id: householdA },
  { id: memberA2, household_id: householdA },
  { id: memberAWithoutIncome, household_id: householdA },
  { id: memberB, household_id: householdB },
];

const incomes = [
  {
    id: "26000000-0000-4000-8000-000000000041",
    household_id: householdA,
    created_by: memberA1,
    member_id: memberA1,
    amount: "1000.01",
    income_date: "2026-08-03",
    description: "Salary",
    category_id: categorySalary,
    created_at: "2026-08-03T12:00:00+00:00",
    updated_at: "2026-08-03T12:01:00+00:00",
  },
  {
    id: "26000000-0000-4000-8000-000000000042",
    household_id: householdA,
    created_by: memberA1,
    member_id: memberA2,
    amount: "20.02",
    income_date: "2026-08-03",
    description: "Freelance",
    category_id: categoryFreelance,
    created_at: "2026-08-03T13:00:00+00:00",
    updated_at: "2026-08-03T13:01:00+00:00",
  },
  {
    id: "26000000-0000-4000-8000-000000000043",
    household_id: householdA,
    created_by: memberA2,
    member_id: memberA1,
    amount: "3.03",
    income_date: "2026-08-02",
    description: "Uncategorized",
    category_id: null,
    created_at: "2026-08-02T12:00:00+00:00",
    updated_at: "2026-08-02T12:01:00+00:00",
  },
  {
    id: "26000000-0000-4000-8000-000000000044",
    household_id: householdB,
    created_by: memberB,
    member_id: memberB,
    amount: "9999.99",
    income_date: "2026-08-03",
    description: "Other household",
    category_id: null,
    created_at: "2026-08-03T14:00:00+00:00",
    updated_at: "2026-08-03T14:01:00+00:00",
  },
];

const observedIncomeQueries = [];
let failIncomeRead = false;

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orders = [];
  }

  select() {
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "eq", column, value });
    return this;
  }

  gte(column, value) {
    this.filters.push({ operator: "gte", column, value });
    return this;
  }

  lte(column, value) {
    this.filters.push({ operator: "lte", column, value });
    return this;
  }

  order(column, options) {
    this.orders.push({ column, ascending: options.ascending });
    return this;
  }

  apply() {
    const source = this.table === "tb_incomes" ? incomes : members;
    let rows = source.filter((row) =>
      this.filters.every(({ operator, column, value }) => {
        if (operator === "eq") return row[column] === value;
        if (operator === "gte") return row[column] >= value;
        return row[column] <= value;
      }),
    );

    rows = [...rows].sort((left, right) => {
      for (const { column, ascending } of this.orders) {
        if (left[column] === right[column]) continue;
        const comparison = left[column] < right[column] ? -1 : 1;
        return ascending ? comparison : -comparison;
      }
      return 0;
    });

    return rows;
  }

  async maybeSingle() {
    const rows = this.apply();
    return { data: rows[0] ?? null, error: null };
  }

  then(resolve, reject) {
    if (this.table === "tb_incomes") {
      observedIncomeQueries.push([...this.filters]);
    }

    const result = failIncomeRead
      ? { data: null, error: { message: "sensitive database detail" } }
      : { data: this.apply(), error: null };
    return Promise.resolve(result).then(resolve, reject);
  }
}

const fakeClient = {
  from(table) {
    assert.ok(
      table === "tb_incomes" || table === "tb_household_members",
      `Unexpected table: ${table}`,
    );
    return new FakeQuery(table);
  },
};

const moduleCache = new Map();
const clientModule = path.join(root, "infrastructure", "database", "client.ts");

function resolveTypeScriptModule(specifier, parentFile) {
  if (specifier.startsWith("@/")) {
    return path.join(root, `${specifier.slice(2)}.ts`);
  }
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(parentFile), `${specifier}.ts`);
  }
  return null;
}

function loadTypeScriptModule(filename) {
  const resolved = path.resolve(filename);
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

async function expectDomainError(name, operation, expectedCode) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.code, expectedCode, `${name}: unexpected error code`);
    return error;
  }
  assert.fail(`${name}: expected ${expectedCode}`);
}

async function main() {
  const { listIncomes } = loadTypeScriptModule(
    path.join(root, "modules", "incomes", "income.service.ts"),
  );

  const result = await listIncomes({ householdId: householdA }, {});
  assert.deepEqual(
    result.incomes.map((income) => income.id),
    [
      "26000000-0000-4000-8000-000000000042",
      "26000000-0000-4000-8000-000000000041",
      "26000000-0000-4000-8000-000000000043",
    ],
  );
  assert.deepEqual(result.incomes[0], {
    id: "26000000-0000-4000-8000-000000000042",
    householdId: householdA,
    createdBy: memberA1,
    memberId: memberA2,
    amount: 20.02,
    incomeDate: "2026-08-03",
    description: "Freelance",
    categoryId: categoryFreelance,
    createdAt: "2026-08-03T13:00:00+00:00",
    updatedAt: "2026-08-03T13:01:00+00:00",
  });
  assert.equal(result.incomes[2].categoryId, null);
  assert.equal(result.summary.totalIncome, 1023.06);
  console.log("PASS real Service mapping, deterministic order and totalIncome");

  const filtered = await listIncomes(
    { householdId: householdA },
    {
      from: "2026-08-03",
      to: "2026-08-03",
      memberId: memberA2,
      categoryId: categoryFreelance,
    },
  );
  assert.deepEqual(
    filtered.incomes.map((income) => income.id),
    ["26000000-0000-4000-8000-000000000042"],
  );
  assert.equal(filtered.summary.totalIncome, 20.02);

  const empty = await listIncomes(
    { householdId: householdA },
    { memberId: memberAWithoutIncome },
  );
  assert.deepEqual(empty, { incomes: [], summary: { totalIncome: 0 } });
  console.log("PASS real Service combined filters and empty summary");

  await expectDomainError(
    "invalid household UUID",
    () => listIncomes({ householdId: "invalid" }, {}),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "invalid filter UUID",
    () => listIncomes({ householdId: householdA }, { categoryId: "invalid" }),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "invalid date",
    () => listIncomes({ householdId: householdA }, { from: "2026-02-30" }),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "invalid range",
    () =>
      listIncomes(
        { householdId: householdA },
        { from: "2026-08-04", to: "2026-08-03" },
      ),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "foreign member",
    () => listIncomes({ householdId: householdA }, { memberId: memberB }),
    "HOUSEHOLD_MISMATCH",
  );
  await expectDomainError(
    "missing member",
    () =>
      listIncomes(
        { householdId: householdA },
        { memberId: "26000000-0000-4000-8000-000000000099" },
      ),
    "HOUSEHOLD_MISMATCH",
  );
  console.log("PASS real Service validation and household mismatch errors");

  failIncomeRead = true;
  const persistenceError = await expectDomainError(
    "repository failure",
    () => listIncomes({ householdId: householdA }, {}),
    "PERSISTENCE_ERROR",
  );
  assert.equal(persistenceError.message, "Incomes could not be loaded.");
  assert.ok(!persistenceError.message.includes("sensitive database detail"));
  console.log("PASS real Service sanitizes Repository errors");

  assert.ok(observedIncomeQueries.length >= 4);
  for (const filters of observedIncomeQueries) {
    assert.ok(
      filters.some(
        ({ operator, column, value }) =>
          operator === "eq" &&
          column === "household_id" &&
          value === householdA,
      ),
      "Every Income query must be isolated by the controlled household",
    );
  }
  console.log(
    "PASS every real Repository Income query includes household isolation",
  );
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
