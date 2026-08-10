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
const categories = [{ id: categorySalary }, { id: categoryFreelance }];

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
let failIncomeWrite = false;
let failIncomeUpdate = false;
let nextIncomeSequence = 50;
const observedIncomeInserts = [];
const observedIncomeUpdates = [];

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orders = [];
  }

  select() {
    return this;
  }

  insert(value) {
    this.insertedValue = value;
    observedIncomeInserts.push(value);
    return this;
  }

  update(value) {
    this.updatedValue = value;
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
    const source =
      this.table === "tb_incomes"
        ? incomes
        : this.table === "tb_household_members"
          ? members
          : categories;
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
    if (this.updatedValue !== undefined) {
      observedIncomeUpdates.push({
        filters: [...this.filters],
        payload: { ...this.updatedValue },
      });

      if (failIncomeUpdate) {
        return { data: null, error: { message: "sensitive update detail" } };
      }

      const row = this.apply()[0] ?? null;
      if (row === null) {
        return { data: null, error: null };
      }

      Object.assign(row, this.updatedValue, {
        updated_at: "2026-08-09T16:00:00+00:00",
      });
      return { data: row, error: null };
    }

    const rows = this.apply();
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    if (failIncomeWrite) {
      return { data: null, error: { message: "sensitive insert detail" } };
    }

    assert.equal(this.table, "tb_incomes");
    assert.ok(this.insertedValue);
    const sequence = String(nextIncomeSequence).padStart(2, "0");
    nextIncomeSequence += 1;
    const row = {
      id: `26000000-0000-4000-8000-0000000000${sequence}`,
      ...this.insertedValue,
      amount: String(this.insertedValue.amount),
      created_at: "2026-08-09T15:00:00+00:00",
      updated_at: "2026-08-09T15:00:00+00:00",
    };
    incomes.push(row);
    return { data: row, error: null };
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
      table === "tb_incomes" ||
        table === "tb_household_members" ||
        table === "tb_categories",
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
  const { createIncome, listIncomes, updateIncome } = loadTypeScriptModule(
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

  const created = await createIncome(
    { householdId: householdA, memberId: memberA1 },
    {
      memberId: memberA2,
      amount: 45.67,
      incomeDate: "2026-08-09",
      description: "Created Income",
      categoryId: categorySalary,
    },
  );
  assert.equal(created.householdId, householdA);
  assert.equal(created.createdBy, memberA1);
  assert.equal(created.memberId, memberA2);
  assert.equal(created.amount, 45.67);
  assert.equal(created.incomeDate, "2026-08-09");
  assert.equal(created.description, "Created Income");
  assert.equal(created.categoryId, categorySalary);
  assert.equal(typeof created.id, "string");
  assert.equal(observedIncomeInserts.at(-1).created_by, memberA1);
  assert.equal(observedIncomeInserts.at(-1).household_id, householdA);

  const createdWithoutCategory = await createIncome(
    { householdId: householdA, memberId: memberA2 },
    {
      memberId: memberA1,
      amount: 0.01,
      incomeDate: "2026-08-09",
      description: "No category",
    },
  );
  assert.equal(createdWithoutCategory.categoryId, null);
  assert.equal(createdWithoutCategory.createdBy, memberA2);
  console.log(
    "PASS real createIncome derives createdBy and returns mapped rows",
  );

  await expectDomainError(
    "invalid create amount",
    () =>
      createIncome(
        { householdId: householdA, memberId: memberA1 },
        {
          memberId: memberA1,
          amount: 0,
          incomeDate: "2026-08-09",
          description: "Invalid",
        },
      ),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "invalid create date",
    () =>
      createIncome(
        { householdId: householdA, memberId: memberA1 },
        {
          memberId: memberA1,
          amount: 1,
          incomeDate: "2026-02-30",
          description: "Invalid",
        },
      ),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "missing create description",
    () =>
      createIncome(
        { householdId: householdA, memberId: memberA1 },
        {
          memberId: memberA1,
          amount: 1,
          incomeDate: "2026-08-09",
        },
      ),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "foreign Income member",
    () =>
      createIncome(
        { householdId: householdA, memberId: memberA1 },
        {
          memberId: memberB,
          amount: 1,
          incomeDate: "2026-08-09",
          description: "Invalid",
        },
      ),
    "HOUSEHOLD_MISMATCH",
  );
  await expectDomainError(
    "foreign creator context",
    () =>
      createIncome(
        { householdId: householdA, memberId: memberB },
        {
          memberId: memberA1,
          amount: 1,
          incomeDate: "2026-08-09",
          description: "Invalid",
        },
      ),
    "HOUSEHOLD_MISMATCH",
  );
  await expectDomainError(
    "missing Income member",
    () =>
      createIncome(
        { householdId: householdA, memberId: memberA1 },
        {
          memberId: "26000000-0000-4000-8000-000000000099",
          amount: 1,
          incomeDate: "2026-08-09",
          description: "Invalid",
        },
      ),
    "HOUSEHOLD_MISMATCH",
  );
  await expectDomainError(
    "missing category",
    () =>
      createIncome(
        { householdId: householdA, memberId: memberA1 },
        {
          memberId: memberA1,
          amount: 1,
          incomeDate: "2026-08-09",
          description: "Invalid",
          categoryId: "26000000-0000-4000-8000-000000000099",
        },
      ),
    "NOT_FOUND",
  );
  console.log(
    "PASS real createIncome validation, isolation and category checks",
  );

  failIncomeWrite = true;
  const createPersistenceError = await expectDomainError(
    "create repository failure",
    () =>
      createIncome(
        { householdId: householdA, memberId: memberA1 },
        {
          memberId: memberA1,
          amount: 1,
          incomeDate: "2026-08-09",
          description: "Repository failure",
        },
      ),
    "PERSISTENCE_ERROR",
  );
  assert.ok(
    !createPersistenceError.message.includes("sensitive insert detail"),
  );
  console.log("PASS real createIncome sanitizes Repository errors");

  failIncomeWrite = false;
  const updated = await updateIncome(
    { householdId: householdA },
    "26000000-0000-4000-8000-000000000041",
    {
      memberId: memberA2,
      amount: 123.45,
      incomeDate: "2026-08-09",
      description: "Updated Income",
      categoryId: null,
    },
  );
  assert.deepEqual(updated, {
    id: "26000000-0000-4000-8000-000000000041",
    householdId: householdA,
    createdBy: memberA1,
    memberId: memberA2,
    amount: 123.45,
    incomeDate: "2026-08-09",
    description: "Updated Income",
    categoryId: null,
    createdAt: "2026-08-03T12:00:00+00:00",
    updatedAt: "2026-08-09T16:00:00+00:00",
  });

  const partiallyUpdated = await updateIncome(
    { householdId: householdA },
    "26000000-0000-4000-8000-000000000042",
    {
      description: "Partial Update",
      householdId: householdB,
      createdBy: memberB,
      id: "26000000-0000-4000-8000-000000000044",
    },
  );
  assert.equal(partiallyUpdated.description, "Partial Update");
  assert.equal(partiallyUpdated.memberId, memberA2);
  assert.equal(partiallyUpdated.amount, 20.02);
  assert.equal(partiallyUpdated.categoryId, categoryFreelance);
  console.log(
    "PASS real updateIncome returns hydrated rows and preserves omitted fields",
  );

  await expectDomainError(
    "empty update",
    () =>
      updateIncome(
        { householdId: householdA },
        "26000000-0000-4000-8000-000000000041",
        {},
      ),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "invalid update UUID",
    () => updateIncome({ householdId: householdA }, "invalid", { amount: 1 }),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "invalid update date",
    () =>
      updateIncome(
        { householdId: householdA },
        "26000000-0000-4000-8000-000000000041",
        { incomeDate: "2026-02-30" },
      ),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "invalid update amount",
    () =>
      updateIncome(
        { householdId: householdA },
        "26000000-0000-4000-8000-000000000041",
        { amount: 0 },
      ),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "excess update precision",
    () =>
      updateIncome(
        { householdId: householdA },
        "26000000-0000-4000-8000-000000000041",
        { amount: 1.001 },
      ),
    "VALIDATION_ERROR",
  );
  await expectDomainError(
    "missing Income update",
    () =>
      updateIncome(
        { householdId: householdA },
        "26000000-0000-4000-8000-000000000099",
        { description: "Missing" },
      ),
    "NOT_FOUND",
  );
  await expectDomainError(
    "foreign Income update",
    () =>
      updateIncome(
        { householdId: householdA },
        "26000000-0000-4000-8000-000000000044",
        { description: "Hidden" },
      ),
    "NOT_FOUND",
  );
  await expectDomainError(
    "foreign member update",
    () =>
      updateIncome(
        { householdId: householdA },
        "26000000-0000-4000-8000-000000000041",
        { memberId: memberB },
      ),
    "HOUSEHOLD_MISMATCH",
  );
  await expectDomainError(
    "missing category update",
    () =>
      updateIncome(
        { householdId: householdA },
        "26000000-0000-4000-8000-000000000041",
        { categoryId: "26000000-0000-4000-8000-000000000099" },
      ),
    "NOT_FOUND",
  );

  failIncomeUpdate = true;
  const updatePersistenceError = await expectDomainError(
    "update repository failure",
    () =>
      updateIncome(
        { householdId: householdA },
        "26000000-0000-4000-8000-000000000041",
        { description: "Repository failure" },
      ),
    "PERSISTENCE_ERROR",
  );
  assert.equal(updatePersistenceError.message, "Income could not be updated.");
  assert.ok(
    !updatePersistenceError.message.includes("sensitive update detail"),
  );
  failIncomeUpdate = false;

  const allowedUpdateColumns = new Set([
    "member_id",
    "amount",
    "income_date",
    "description",
    "category_id",
  ]);
  assert.ok(observedIncomeUpdates.length >= 5);
  for (const { filters, payload } of observedIncomeUpdates) {
    assert.ok(
      filters.some(
        ({ operator, column }) => operator === "eq" && column === "id",
      ),
      "Every Income update must filter by id",
    );
    assert.ok(
      filters.some(
        ({ operator, column, value }) =>
          operator === "eq" &&
          column === "household_id" &&
          value === householdA,
      ),
      "Every Income update must use the controlled household",
    );
    assert.ok(
      Object.keys(payload).every((column) => allowedUpdateColumns.has(column)),
      "Income update payload contained an immutable column",
    );
  }
  console.log(
    "PASS real updateIncome validation, isolation, payload and error sanitization",
  );

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
