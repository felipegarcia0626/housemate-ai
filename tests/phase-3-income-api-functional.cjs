const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const serviceModule = path.join(
  root,
  "modules",
  "incomes",
  "income.service.ts",
);
const routeModule = path.join(root, "app", "api", "incomes", "route.ts");
const authServiceModule = path.join(
  root,
  "modules",
  "context",
  "authenticated-context.service.ts",
);
const authTypesModule = path.join(
  root,
  "modules",
  "context",
  "authenticated-context.types.ts",
);
const updateRouteModule = path.join(
  root,
  "app",
  "api",
  "incomes",
  "[id]",
  "route.ts",
);

const householdA = "42000000-0000-4000-8000-000000000001";
const householdB = "42000000-0000-4000-8000-000000000002";
const missingHousehold = "42000000-0000-4000-8000-000000000003";
const memberA = "42000000-0000-4000-8000-000000000011";
const memberB = "42000000-0000-4000-8000-000000000012";
const memberC = "42000000-0000-4000-8000-000000000014";
const missingMember = "42000000-0000-4000-8000-000000000013";
const categoryA = "42000000-0000-4000-8000-000000000021";
const incomeMacroCategory = "42000000-0000-4000-8000-000000000023";
const incomeCategoryB = "42000000-0000-4000-8000-000000000030";
const incomeMacroCategoryB = "42000000-0000-4000-8000-000000000037";
const incomeCategoryC = "42000000-0000-4000-8000-000000000038";
const expenseCategory = "42000000-0000-4000-8000-000000000024";
const inactiveIncomeCategory = "42000000-0000-4000-8000-000000000025";
const legacyCategory = "42000000-0000-4000-8000-000000000026";
const inactiveIncomeMacroCategory = "42000000-0000-4000-8000-000000000035";
const activeUnderInactiveIncomeMacro =
  "42000000-0000-4000-8000-000000000036";
const missingCategory = "42000000-0000-4000-8000-000000000022";
const invalidHierarchyIncomeCategory = "42000000-0000-4000-8000-000000000028";
const incomeFirst = "42000000-0000-4000-8000-000000000031";
const incomeSecond = "42000000-0000-4000-8000-000000000032";
const incomeThird = "42000000-0000-4000-8000-000000000033";
const incomeOtherHousehold = "42000000-0000-4000-8000-000000000034";

let authContextState = { kind: "valid", householdId: householdA };
class FakeAuthenticatedContextError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fakeAuthTypes = { AuthenticatedContextError: FakeAuthenticatedContextError };
const fakeAuthService = {
  resolveAuthenticatedContext: async () => {
    if (authContextState.kind !== "valid") {
      throw new FakeAuthenticatedContextError(authContextState.kind);
    }
    return {
      authUserId: "auth-user",
      userId: "app-user",
      householdId: authContextState.householdId,
      memberId: memberA,
      source: "web",
    };
  },
};

const households = [{ id: householdA }, { id: householdB }];
const members = [
  { id: memberA, household_id: householdA },
  { id: memberB, household_id: householdB },
  { id: memberC, household_id: householdA },
];
const baselineIncomes = [
  {
    id: incomeThird,
    household_id: householdA,
    created_by: memberA,
    member_id: memberA,
    amount: "30.03",
    income_date: "2026-08-02",
    description: "Older",
    category_id: null,
    created_at: "2026-08-02T12:00:00+00:00",
    updated_at: "2026-08-02T12:00:00+00:00",
  },
  {
    id: incomeSecond,
    household_id: householdA,
    created_by: memberA,
    member_id: memberA,
    amount: "20.02",
    income_date: "2026-08-03",
    description: "Same timestamp second ID",
    category_id: categoryA,
    created_at: "2026-08-03T13:00:00+00:00",
    updated_at: "2026-08-03T13:00:00+00:00",
  },
  {
    id: incomeFirst,
    household_id: householdA,
    created_by: memberA,
    member_id: memberA,
    amount: "10.01",
    income_date: "2026-08-03",
    description: "Same timestamp first ID",
    category_id: categoryA,
    created_at: "2026-08-03T13:00:00+00:00",
    updated_at: "2026-08-03T13:00:00+00:00",
  },
  {
    id: "42000000-0000-4000-8000-000000000034",
    household_id: householdB,
    created_by: memberB,
    member_id: memberB,
    amount: "999.99",
    income_date: "2026-08-04",
    description: "Other household",
    category_id: null,
    created_at: "2026-08-04T14:00:00+00:00",
    updated_at: "2026-08-04T14:00:00+00:00",
  },
];
const categories = [
  {
    id: categoryA,
    name: "Income Micro Alpha",
    movement_type: "INCOME",
    level: "MICRO",
    parent_id: incomeMacroCategory,
    is_active: true,
  },
  {
    id: incomeCategoryB,
    name: "Income Micro Beta",
    movement_type: "INCOME",
    level: "MICRO",
    parent_id: incomeMacroCategory,
    is_active: true,
  },
  {
    id: incomeCategoryC,
    name: "Income Micro Gamma",
    movement_type: "INCOME",
    level: "MICRO",
    parent_id: incomeMacroCategoryB,
    is_active: true,
  },
  {
    id: incomeMacroCategory,
    name: "Income Macro Alpha",
    movement_type: "INCOME",
    level: "MACRO",
    parent_id: null,
    is_active: true,
  },
  {
    id: incomeMacroCategoryB,
    name: "Income Macro Beta",
    movement_type: "INCOME",
    level: "MACRO",
    parent_id: null,
    is_active: true,
  },
  {
    id: expenseCategory,
    name: "Expense Micro",
    movement_type: "EXPENSE",
    level: "MICRO",
    parent_id: "42000000-0000-4000-8000-000000000027",
    is_active: true,
  },
  {
    id: inactiveIncomeCategory,
    name: "Inactive Income Micro",
    movement_type: "INCOME",
    level: "MICRO",
    parent_id: incomeMacroCategory,
    is_active: false,
  },
  {
    id: inactiveIncomeMacroCategory,
    name: "Inactive Income Macro",
    movement_type: "INCOME",
    level: "MACRO",
    parent_id: null,
    is_active: false,
  },
  {
    id: activeUnderInactiveIncomeMacro,
    name: "Inactive Parent Child",
    movement_type: "INCOME",
    level: "MICRO",
    parent_id: inactiveIncomeMacroCategory,
    is_active: true,
  },
  {
    id: invalidHierarchyIncomeCategory,
    name: "Invalid Hierarchy Income Micro",
    movement_type: "INCOME",
    level: "MICRO",
    parent_id: "42000000-0000-4000-8000-000000000029",
    is_active: true,
  },
  { id: legacyCategory },
];

let incomes = [...baselineIncomes];
let failedTable;
let failedDeleteCode;
let nextCreatedIncome = 50;
const observedOperations = [];

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orderings = [];
  }

  select(columns, options = {}) {
    this.columns = columns;
    this.countRequested = options.count === "exact";
    observedOperations.push({ type: "select", table: this.table, columns });
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "eq", column, value });
    observedOperations.push({
      type: "filter",
      table: this.table,
      operator: "eq",
      column,
      value,
    });
    return this;
  }

  in(column, values) {
    this.filters.push({ operator: "in", column, value: values });
    observedOperations.push({
      type: "filter",
      table: this.table,
      operator: "in",
      column,
      value: values,
    });
    return this;
  }

  gte(column, value) {
    this.filters.push({ operator: "gte", column, value });
    observedOperations.push({
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
    observedOperations.push({
      type: "filter",
      table: this.table,
      operator: "lte",
      column,
      value,
    });
    return this;
  }

  ilike(column, value) {
    this.filters.push({ operator: "ilike", column, value });
    observedOperations.push({
      type: "filter",
      table: this.table,
      operator: "ilike",
      column,
      value,
    });
    return this;
  }

  or(expression) {
    this.orExpression = expression;
    observedOperations.push({
      type: "or",
      table: this.table,
      expression,
    });
    return this;
  }

  range(from, to) {
    this.rangeValues = { from, to };
    observedOperations.push({
      type: "range",
      table: this.table,
      from,
      to,
    });
    return this;
  }

  order(column, options) {
    this.orderings.push({ column, ...options });
    observedOperations.push({
      type: "order",
      table: this.table,
      column,
      ...options,
    });
    return this;
  }

  insert(payload) {
    this.insertPayload = payload;
    observedOperations.push({
      type: "insert",
      table: this.table,
      payload,
    });
    return this;
  }

  update() {
    this.updatePayload = arguments[0];
    observedOperations.push({
      type: "update",
      table: this.table,
      payload: this.updatePayload,
    });
    return this;
  }

  delete() {
    this.deleteRequested = true;
    observedOperations.push({ type: "delete", table: this.table });
    return this;
  }

  sourceRows() {
    if (this.table === "tb_households") return households;
    if (this.table === "tb_household_members") return members;
    if (this.table === "tb_categories") return categories;
    if (this.table === "tb_incomes") return incomes;
    return [];
  }

  matchesOr(row) {
    return this.orExpression
      .split(/,(?=(?:description|category_id)\.)/)
      .some((clause) => {
        const ilikeMatch = /^(description|category_id)\.ilike\."(.*)"$/.exec(
          clause,
        );
        if (ilikeMatch) {
          const value = ilikeMatch[2]
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
          const search = value
            .replace(/^%/, "")
            .replace(/%$/, "")
            .replace(/\\([%_*\\])/g, "$1")
            .toLowerCase();
          return String(row[ilikeMatch[1]] ?? "")
            .toLowerCase()
            .includes(search);
        }

        const inMatch = /^category_id\.in\.\((.*)\)$/.exec(clause);
        return inMatch !== null && inMatch[1].split(",").includes(row.category_id);
      });
  }

  execute() {
    if (this.deleteRequested && failedDeleteCode) {
      return {
        data: null,
        error: {
          code: failedDeleteCode,
          message: "sensitive foreign key detail",
        },
      };
    }

    if (failedTable === this.table) {
      return {
        data: null,
        error: {
          code: "42501",
          message: "sensitive Supabase/PostgreSQL table detail",
        },
      };
    }

    if (this.insertPayload !== undefined) {
      const row = {
        id: `42000000-0000-4000-8000-0000000000${nextCreatedIncome++}`,
        household_id: this.insertPayload.household_id,
        created_by: this.insertPayload.created_by,
        member_id: this.insertPayload.member_id,
        amount: String(this.insertPayload.amount),
        income_date: this.insertPayload.income_date,
        description: this.insertPayload.description,
        category_id: this.insertPayload.category_id,
        created_at: "2026-08-12T12:00:00+00:00",
        updated_at: "2026-08-12T12:00:00+00:00",
      };
      incomes.push(row);
      return { data: [row], error: null };
    }

    let rows = this.sourceRows().filter((row) =>
      this.filters.every(({ operator, column, value }) => {
        const current = row[column];
        if (operator === "eq") return current === value;
        if (operator === "in") return value.includes(current);
        if (operator === "gte") return String(current) >= String(value);
        if (operator === "lte") return String(current) <= String(value);
        if (operator === "ilike") {
          const search = String(value)
            .replace(/^%/, "")
            .replace(/%$/, "")
            .replace(/\\([%_\\])/g, "$1")
            .toLowerCase();
          return String(current ?? "").toLowerCase().includes(search);
        }
        return false;
      }),
    );

    if (this.orExpression !== undefined) {
      rows = rows.filter((row) => this.matchesOr(row));
    }

    if (this.deleteRequested) {
      const deletedIds = new Set(rows.map((row) => row.id));
      incomes = incomes.filter((row) => !deletedIds.has(row.id));
      return { data: rows, error: null };
    }

    if (this.updatePayload !== undefined) {
      for (const row of rows) Object.assign(row, this.updatePayload);
    }

    if (this.orderings.length > 0) {
      rows = [...rows].sort((left, right) => {
        for (const ordering of this.orderings) {
          const leftValue = left[ordering.column];
          const rightValue = right[ordering.column];
          const comparison =
            ordering.column === "amount"
              ? Number(leftValue) - Number(rightValue)
              : String(leftValue).localeCompare(String(rightValue));
          if (comparison !== 0)
            return ordering.ascending ? comparison : -comparison;
        }
        return 0;
      });
    }

    const total = rows.length;
    if (this.rangeValues) {
      rows = rows.slice(this.rangeValues.from, this.rangeValues.to + 1);
    }

    return { data: rows, error: null, count: this.countRequested ? total : null };
  }

  maybeSingle() {
    const result = this.execute();
    return Promise.resolve({
      data: result.error ? null : (result.data[0] ?? null),
      error: result.error,
    });
  }

  single() {
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
    observedOperations.push({ type: "from", table });
    return new FakeQuery(table);
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

function createTypeScriptLoader(overrides = new Map()) {
  const moduleCache = new Map();

  function loadTypeScriptModule(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
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

  return loadTypeScriptModule;
}

function request(query = "") {
  return new Request(`http://localhost/api/incomes${query}`);
}

function postRequest(body, query = "") {
  return new Request(`http://localhost/api/incomes${query}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function patchRequest(id, body) {
  return new Request(`http://localhost/api/incomes/${id}`, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function readJson(response) {
  assert.equal(response.headers.get("content-type"), "application/json");
  return response.json();
}

async function expectError(route, query, status, code, message) {
  const response = await route.GET(request(query));
  assert.equal(response.status, status, query);
  const body = await readJson(response);
  assert.deepEqual(body, { error: { code, message } });
  const serialized = JSON.stringify(body);
  for (const secret of [
    "Supabase",
    "PostgreSQL",
    "42501",
    "tb_incomes",
    "sensitive",
    householdA,
  ]) {
    assert.ok(!serialized.includes(secret), `${query}: exposed ${secret}`);
  }
}

async function expectPatchError(route, id, body, status, code, message) {
  const response = await route.PATCH(patchRequest(id, body), {
    params: Promise.resolve({ id }),
  });
  assert.equal(response.status, status);
  const result = await readJson(response);
  assert.equal(result.error.code, code);
  assert.ok(
    result.error.message === message ||
      result.error.message === "Solicitud inválida." ||
      result.error.message === "No fue posible completar la operación.",
  );
}

function hasOperation(expected) {
  return observedOperations.some((operation) =>
    Object.entries(expected).every(([key, value]) => operation[key] === value),
  );
}

async function main() {
  const previousHouseholdId = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  const previousMemberId = process.env.HOUSEMATE_MVP_MEMBER_ID;

  try {
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    process.env.HOUSEMATE_MVP_MEMBER_ID = memberA;
    const routeSource = fs.readFileSync(routeModule, "utf8");
    assert.ok(!routeSource.includes("income.repository"));
    assert.ok(!routeSource.includes("database/client"));
    assert.ok(!routeSource.includes("supabase"));
    assert.ok(!routeSource.includes("process.env"));
    assert.ok(!routeSource.includes("category.service"));

    const route = createTypeScriptLoader(
      new Map([
        [authServiceModule, fakeAuthService],
        [authTypesModule, fakeAuthTypes],
      ]),
    )(routeModule);
    assert.deepEqual(Object.keys(route).sort(), ["GET", "POST"]);

    const routeSourceChecks = [
      "income.repository",
      "database/client",
      "getSupabaseAdminClient",
      ".from(",
      ".rpc(",
      ".insert(",
      ".update(",
      ".delete(",
    ];
    for (const forbidden of routeSourceChecks) {
      assert.ok(
        !routeSource.includes(forbidden),
        `Route contains ${forbidden}`,
      );
    }
    const createBody = {
      memberId: memberA,
      amount: 123.45,
      incomeDate: "2026-08-12",
      description: "Created over HTTP",
      categoryId: categoryA,
    };
    observedOperations.length = 0;
    const created = await route.POST(postRequest(createBody));
    assert.equal(created.status, 201);
    const createdBody = await readJson(created);
    assert.deepEqual(Object.keys(createdBody.data).sort(), [
      "amount",
      "categoryId",
      "createdBy",
      "description",
      "id",
      "incomeDate",
      "memberId",
    ]);
    assert.equal(createdBody.data.createdBy, memberA);
    assert.equal(createdBody.data.memberId, memberA);
    assert.equal(createdBody.data.amount, 123.45);
    assert.equal(createdBody.data.categoryId, categoryA);
    assert.ok(!Object.hasOwn(createdBody.data, "householdId"));
    assert.ok(!Object.hasOwn(createdBody.data, "createdAt"));
    assert.ok(!Object.hasOwn(createdBody.data, "updatedAt"));
    assert.ok(hasOperation({ type: "insert", table: "tb_incomes" }));
    const createInsert = observedOperations.find(
      ({ type, table }) => type === "insert" && table === "tb_incomes",
    );
    assert.deepEqual(createInsert.payload, {
      household_id: householdA,
      created_by: memberA,
      member_id: memberA,
      amount: 123.45,
      income_date: "2026-08-12",
      description: "Created over HTTP",
      category_id: categoryA,
    });
    assert.equal(
      observedOperations.filter(
        ({ type, table }) => type === "insert" && table === "tb_incomes",
      ).length,
      1,
    );
    console.log(
      "PASS Income POST creates the public DTO with controlled actor and household",
    );

    const differentTarget = await route.POST(
      postRequest({ ...createBody, memberId: memberC }),
    );
    assert.equal(differentTarget.status, 201);
    const differentTargetBody = await readJson(differentTarget);
    assert.equal(differentTargetBody.data.createdBy, memberA);
    assert.equal(differentTargetBody.data.memberId, memberC);
    console.log("PASS Income POST preserves actor and target member semantics");

    for (const [body, query] of [
      [{ ...createBody, householdId: householdB }, ""],
      [createBody, `?householdId=${householdB}`],
      [{ ...createBody, createdBy: memberB }, ""],
      [{ ...createBody, status: "CONFIRMED" }, ""],
      [{ ...createBody, createdAt: "2026-08-12T00:00:00Z" }, ""],
      [{ ...createBody, unknown: true }, ""],
    ]) {
      const response = await route.POST(postRequest(body, query));
      assert.equal(response.status, query ? 400 : 400);
      assert.equal((await readJson(response)).error.code, "VALIDATION_ERROR");
    }
    assert.equal(
      observedOperations.filter(({ type }) => type === "insert").length,
      2,
    );
    console.log(
      "PASS Income POST rejects external identity, protected and unknown fields",
    );

    for (const body of [
      "{invalid",
      { ...createBody, amount: 0 },
      { ...createBody, amount: 1.001 },
      { ...createBody, incomeDate: "2026-02-30" },
      { ...createBody, memberId: "invalid" },
      { ...createBody, categoryId: "invalid" },
    ]) {
      const requestBody =
        typeof body === "string" ? body : JSON.stringify(body);
      const response = await route.POST(
        new Request("http://localhost/api/incomes", {
          method: "POST",
          body: requestBody,
          headers: { "content-type": "application/json" },
        }),
      );
      assert.equal(response.status, 422);
      assert.equal((await readJson(response)).error.code, "VALIDATION_ERROR");
    }
    const createMissingCategoryResponse = await route.POST(
      postRequest({ ...createBody, categoryId: missingCategory }),
    );
    assert.equal(createMissingCategoryResponse.status, 404);
    assert.equal(
      (await readJson(createMissingCategoryResponse)).error.code,
      "NOT_FOUND",
    );
    for (const categoryId of [
      expenseCategory,
      incomeMacroCategory,
      inactiveIncomeCategory,
      activeUnderInactiveIncomeMacro,
      legacyCategory,
      missingCategory,
      invalidHierarchyIncomeCategory,
    ]) {
      const response = await route.POST(
        postRequest({ ...createBody, categoryId }),
      );
      assert.equal(response.status, 404);
      assert.equal((await readJson(response)).error.code, "NOT_FOUND");
    }
    const crossHouseholdMember = await route.POST(
      postRequest({ ...createBody, memberId: memberB }),
    );
    assert.equal(crossHouseholdMember.status, 404);
    assert.equal((await readJson(crossHouseholdMember)).error.code, "NOT_FOUND");
    const uncategorizedIncome = await route.POST(
      postRequest({ ...createBody, categoryId: null }),
    );
    assert.equal(uncategorizedIncome.status, 201);
    console.log(
      "PASS Income POST validates JSON, amount, date, members and movement categories",
    );

    authContextState = { kind: "UNAUTHENTICATED", householdId: householdA };
    const unauthenticated = await route.POST(postRequest(createBody));
    assert.equal(unauthenticated.status, 401);
    assert.equal((await readJson(unauthenticated)).error.code, "UNAUTHENTICATED");
    authContextState = { kind: "APPLICATION_USER_NOT_FOUND", householdId: householdA };
    const unlinked = await route.POST(postRequest(createBody));
    assert.equal(unlinked.status, 403);
    assert.equal((await readJson(unlinked)).error.code, "APPLICATION_USER_NOT_FOUND");
    authContextState = { kind: "NO_ACTIVE_MEMBERSHIP", householdId: householdA };
    const noMembership = await route.POST(postRequest(createBody));
    assert.equal(noMembership.status, 403);
    assert.equal((await readJson(noMembership)).error.code, "NO_ACTIVE_MEMBERSHIP");
    authContextState = { kind: "HOUSEHOLD_SELECTION_REQUIRED", householdId: householdA };
    const multipleMemberships = await route.POST(postRequest(createBody));
    assert.equal(multipleMemberships.status, 409);
    assert.equal(
      (await readJson(multipleMemberships)).error.code,
      "HOUSEHOLD_SELECTION_REQUIRED",
    );
    authContextState = { kind: "valid", householdId: householdA };

    failedTable = "tb_incomes";
    const persistenceCreate = await route.POST(postRequest(createBody));
    assert.equal(persistenceCreate.status, 500);
    const persistenceCreateBody = await readJson(persistenceCreate);
    assert.equal(persistenceCreateBody.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(persistenceCreateBody).includes("42501"));
    failedTable = undefined;
    console.log("PASS Income POST sanitizes context and persistence errors");
    incomes = [...baselineIncomes];

    const updateRoute = createTypeScriptLoader(
      new Map([
        [authServiceModule, fakeAuthService],
        [authTypesModule, fakeAuthTypes],
      ]),
    )(updateRouteModule);
    assert.deepEqual(Object.keys(updateRoute).sort(), ["DELETE", "PATCH"]);
    const updateRouteSource = fs.readFileSync(updateRouteModule, "utf8");
    for (const forbidden of [
      "income.repository",
      "database/client",
      "getSupabaseAdminClient",
      ".from(",
      ".rpc(",
      ".insert(",
      ".update(",
      ".delete(",
    ]) {
      assert.ok(
        !updateRouteSource.includes(forbidden),
        `Route contains ${forbidden}`,
      );
    }
    console.log(
      "PASS PATCH Route has no direct persistence or Supabase access",
    );

    const deleteRequest = (id, query = "") =>
      new Request(`http://localhost/api/incomes/${id}${query}`, {
        method: "DELETE",
      });
    const deleteSource = fs.readFileSync(updateRouteModule, "utf8");
    for (const forbidden of [
      "income.repository",
      "database/client",
      "getSupabaseAdminClient",
      ".from(",
      ".rpc(",
      ".insert(",
      ".update(",
      ".delete(",
    ]) {
      assert.ok(
        !deleteSource.includes(forbidden),
        `Route contains ${forbidden}`,
      );
    }
    observedOperations.length = 0;
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdB;
    const deleted = await updateRoute.DELETE(deleteRequest(incomeFirst), {
      params: Promise.resolve({ id: incomeFirst }),
    });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");
    assert.equal(
      incomes.some(({ id }) => id === incomeFirst),
      false,
    );
    assert.equal(
      observedOperations.filter(
        ({ type, table }) => type === "delete" && table === "tb_incomes",
      ).length,
      1,
    );
    incomes = [...baselineIncomes];
    authContextState = { kind: "UNAUTHENTICATED", householdId: householdA };
    const unauthenticatedDelete = await updateRoute.DELETE(
      deleteRequest(incomeFirst),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(unauthenticatedDelete.status, 401);
    assert.equal((await readJson(unauthenticatedDelete)).error.code, "UNAUTHENTICATED");
    authContextState = { kind: "APPLICATION_USER_NOT_FOUND", householdId: householdA };
    const unlinkedDelete = await updateRoute.DELETE(
      deleteRequest(incomeFirst),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(unlinkedDelete.status, 403);
    assert.equal((await readJson(unlinkedDelete)).error.code, "APPLICATION_USER_NOT_FOUND");
    authContextState = { kind: "NO_ACTIVE_MEMBERSHIP", householdId: householdA };
    const noMembershipDelete = await updateRoute.DELETE(
      deleteRequest(incomeFirst),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(noMembershipDelete.status, 403);
    assert.equal((await readJson(noMembershipDelete)).error.code, "NO_ACTIVE_MEMBERSHIP");
    authContextState = { kind: "HOUSEHOLD_SELECTION_REQUIRED", householdId: householdA };
    const selectionRequiredDelete = await updateRoute.DELETE(
      deleteRequest(incomeFirst),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(selectionRequiredDelete.status, 409);
    assert.equal(
      (await readJson(selectionRequiredDelete)).error.code,
      "HOUSEHOLD_SELECTION_REQUIRED",
    );
    authContextState = { kind: "valid", householdId: householdA };
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    console.log("PASS Income DELETE uses authenticated household and maps auth errors");

    for (const [id, status, code] of [
      ["invalid", 422, "VALIDATION_ERROR"],
      [missingHousehold, 404, "NOT_FOUND"],
      ["42000000-0000-4000-8000-000000000034", 404, "NOT_FOUND"],
    ]) {
      const response = await updateRoute.DELETE(deleteRequest(id), {
        params: Promise.resolve({ id }),
      });
      assert.equal(response.status, status);
      assert.equal((await readJson(response)).error.code, code);
    }
    assert.equal(
      incomes.some(({ id }) => id === "42000000-0000-4000-8000-000000000034"),
      true,
    );
    for (const query of [
      `?householdId=${householdB}`,
      "?memberId=" + memberA,
    ]) {
      observedOperations.length = 0;
      const response = await updateRoute.DELETE(
        deleteRequest(incomeSecond, query),
        { params: Promise.resolve({ id: incomeSecond }) },
      );
      assert.equal(response.status, 400);
      assert.equal((await readJson(response)).error.code, "VALIDATION_ERROR");
      assert.deepEqual(observedOperations, []);
    }
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = missingHousehold;
    const configuredHouseholdIgnoredDelete = await updateRoute.DELETE(
      deleteRequest(incomeSecond),
      { params: Promise.resolve({ id: incomeSecond }) },
    );
    assert.equal(configuredHouseholdIgnoredDelete.status, 204);
    incomes = [...baselineIncomes];
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    failedTable = "tb_incomes";
    const persistenceDelete = await updateRoute.DELETE(
      deleteRequest(incomeSecond),
      { params: Promise.resolve({ id: incomeSecond }) },
    );
    assert.equal(persistenceDelete.status, 500);
    assert.equal(
      (await readJson(persistenceDelete)).error.code,
      "INTERNAL_ERROR",
    );
    failedTable = undefined;
    incomes = [...baselineIncomes];
    console.log(
      "PASS Income DELETE validates isolation, errors and route boundaries",
    );
    const originalIncome = structuredClone(incomes[2]);
    const categoryAFixture = categories.find(({ id }) => id === categoryA);
    const categoryBFixture = categories.find(({ id }) => id === incomeCategoryB);
    const incomeMacroFixture = categories.find(
      ({ id }) => id === incomeMacroCategory,
    );
    assert.equal(categoryAFixture.movement_type, "INCOME");
    assert.equal(categoryBFixture.movement_type, "INCOME");
    assert.equal(categoryAFixture.level, "MICRO");
    assert.equal(categoryBFixture.level, "MICRO");
    assert.equal(categoryAFixture.parent_id, incomeMacroCategory);
    assert.equal(categoryBFixture.parent_id, incomeMacroCategory);
    assert.equal(incomeMacroFixture.movement_type, "INCOME");
    assert.equal(incomeMacroFixture.level, "MACRO");
    assert.notEqual(categoryA, incomeCategoryB);

    const categoryUpdated = await updateRoute.PATCH(
      patchRequest(incomeFirst, { categoryId: incomeCategoryB }),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(categoryUpdated.status, 200);
    const categoryUpdatedBody = await readJson(categoryUpdated);
    assert.deepEqual(categoryUpdatedBody.data, {
      id: incomeFirst,
      createdBy: originalIncome.created_by,
      memberId: originalIncome.member_id,
      amount: Number(originalIncome.amount),
      incomeDate: originalIncome.income_date,
      description: originalIncome.description,
      categoryId: incomeCategoryB,
    });
    assert.equal(
      incomes.find(({ id }) => id === incomeFirst).category_id,
      incomeCategoryB,
    );
    const categoryUpdateOperation = [...observedOperations]
      .reverse()
      .find(
        ({ type, table }) => type === "update" && table === "tb_incomes",
      );
    assert.deepEqual(categoryUpdateOperation.payload, {
      category_id: incomeCategoryB,
    });
    Object.assign(incomes[2], originalIncome);
    console.log(
      "PASS Income PATCH changes a valid Micro INCOME category without changing other fields",
    );

    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdB;
    const authenticatedPatch = await updateRoute.PATCH(
      patchRequest(incomeFirst, { description: "Authenticated household update" }),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(authenticatedPatch.status, 200);
    const authenticatedContext =
      await fakeAuthService.resolveAuthenticatedContext();
    assert.equal(authenticatedContext.memberId, memberA);
    assert.notEqual(memberA, memberC);
    assert.equal(
      members.find(({ id }) => id === memberA).household_id,
      householdA,
    );
    assert.equal(
      members.find(({ id }) => id === memberC).household_id,
      householdA,
    );
    const targetMemberPatch = await updateRoute.PATCH(
      patchRequest(incomeFirst, { memberId: memberC }),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(targetMemberPatch.status, 200);
    assert.equal((await readJson(targetMemberPatch)).data.memberId, memberC);
    assert.equal(
      incomes.find(({ id }) => id === incomeFirst).member_id,
      memberC,
    );
    Object.assign(incomes[2], originalIncome);
    console.log("PASS PATCH preserves a valid target member distinct from authenticated member");
    authContextState = { kind: "UNAUTHENTICATED", householdId: householdA };
    await expectPatchError(
      updateRoute,
      incomeFirst,
      { amount: 77.77 },
      401,
      "UNAUTHENTICATED",
      "Se requiere una sesión autenticada.",
    );
    authContextState = { kind: "APPLICATION_USER_NOT_FOUND", householdId: householdA };
    await expectPatchError(
      updateRoute,
      incomeFirst,
      { amount: 77.77 },
      403,
      "APPLICATION_USER_NOT_FOUND",
      "La identidad autenticada no tiene acceso a la aplicación.",
    );
    authContextState = { kind: "NO_ACTIVE_MEMBERSHIP", householdId: householdA };
    await expectPatchError(
      updateRoute,
      incomeFirst,
      { amount: 77.77 },
      403,
      "NO_ACTIVE_MEMBERSHIP",
      "La identidad autenticada no tiene un hogar activo.",
    );
    authContextState = { kind: "HOUSEHOLD_SELECTION_REQUIRED", householdId: householdA };
    await expectPatchError(
      updateRoute,
      incomeFirst,
      { amount: 77.77 },
      409,
      "HOUSEHOLD_SELECTION_REQUIRED",
      "Debes seleccionar un hogar antes de continuar.",
    );
    authContextState = { kind: "valid", householdId: householdA };
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    const crossHouseholdPatch = await updateRoute.PATCH(
      patchRequest(incomeOtherHousehold, { description: "Cross household attempt" }),
      { params: Promise.resolve({ id: incomeOtherHousehold }) },
    );
    assert.equal(crossHouseholdPatch.status, 404);
    assert.equal((await readJson(crossHouseholdPatch)).error.code, "NOT_FOUND");
    console.log("PASS Income PATCH uses authenticated household and maps auth errors");

    const updated = await updateRoute.PATCH(
      patchRequest(incomeFirst, {
        amount: 77.77,
        description: "Updated over HTTP",
        memberId: memberA,
        incomeDate: "2026-08-09",
        categoryId: null,
      }),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(updated.status, 200);
    const updatedBody = await readJson(updated);
    assert.deepEqual(updatedBody.data, {
      id: incomeFirst,
      createdBy: memberA,
      memberId: memberA,
      amount: 77.77,
      incomeDate: "2026-08-09",
      description: "Updated over HTTP",
      categoryId: null,
    });
    assert.ok(!("householdId" in updatedBody.data));
    assert.ok(!("createdAt" in updatedBody.data));
    assert.ok(!("updatedAt" in updatedBody.data));
    assert.equal(typeof updatedBody.data.amount, "number");
    assert.ok(hasOperation({ type: "update", table: "tb_incomes" }));
    Object.assign(incomes[2], originalIncome);
    const invalidUpdatedCategory = await updateRoute.PATCH(
      patchRequest(incomeFirst, { categoryId: expenseCategory }),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(invalidUpdatedCategory.status, 404);
    assert.equal(
      (await readJson(invalidUpdatedCategory)).error.code,
      "NOT_FOUND",
    );
    console.log(
      "PASS Income PATCH updates domain fields and projects public DTO",
    );

    for (const [id, body, status] of [
      ["invalid", { amount: 1 }, 422],
      [incomeFirst, {}, 422],
      [incomeFirst, { unknown: true }, 422],
      [incomeFirst, { amount: 0 }, 422],
    ]) {
      await expectPatchError(
        updateRoute,
        id,
        body,
        status,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
    }
    await expectPatchError(
      updateRoute,
      "42000000-0000-4000-8000-000000000099",
      { amount: 1 },
      404,
      "NOT_FOUND",
      "Recurso no encontrado.",
    );
    console.log(
      "PASS Income PATCH validates input and sanitizes not-found errors",
    );

    const malformedJsonRequest = new Request(
      `http://localhost/api/incomes/${incomeFirst}`,
      {
        method: "PATCH",
        body: "{",
        headers: { "content-type": "application/json" },
      },
    );
    await expectPatchError(
      updateRoute,
      incomeFirst,
      undefined,
      422,
      "VALIDATION_ERROR",
      "Solicitud invÃ¡lida.",
    );
    const malformedResponse = await updateRoute.PATCH(malformedJsonRequest, {
      params: Promise.resolve({ id: incomeFirst }),
    });
    assert.equal(malformedResponse.status, 422);
    const malformedBodyAgain = await readJson(malformedResponse);
    assert.equal(malformedBodyAgain.error.code, "VALIDATION_ERROR");
    assert.equal(malformedBodyAgain.error.message, "Solicitud inválida.");
    /*
      assert.deepEqual(await readJson(malformedResponse), {
        error: { code: "VALIDATION_ERROR", message: "Solicitud invÃ¡lida." },
      });
    */
    for (const body of [null, [], "text", 42]) {
      await expectPatchError(
        updateRoute,
        incomeFirst,
        body,
        422,
        "VALIDATION_ERROR",
        "Solicitud invÃ¡lida.",
      );
    }
    for (const [field, value] of [
      ["memberId", "invalid"],
      ["incomeDate", "2026-02-30"],
      ["categoryId", "invalid"],
      ["amount", 1.234],
      ["amount", 0],
    ]) {
      await expectPatchError(
        updateRoute,
        incomeFirst,
        { [field]: value },
        422,
        "VALIDATION_ERROR",
        "Solicitud invÃ¡lida.",
      );
    }
    for (const field of [
      "id",
      "householdId",
      "createdBy",
      "createdAt",
      "updatedAt",
      "unknown",
    ]) {
      await expectPatchError(
        updateRoute,
        incomeFirst,
        { [field]: "forbidden" },
        422,
        "VALIDATION_ERROR",
        "Solicitud invÃ¡lida.",
      );
    }
    await expectPatchError(
      updateRoute,
      "42000000-0000-0000-0000-000000000034",
      { amount: 1 },
      404,
      "NOT_FOUND",
      "Recurso no encontrado.",
    );
    await expectPatchError(
      updateRoute,
      incomeFirst,
      { memberId: memberB },
      404,
      "NOT_FOUND",
      "Recurso no encontrado.",
    );
    observedOperations.length = 0;
    await expectPatchError(
      updateRoute,
      incomeFirst,
      { amount: 1, householdId: householdB },
      422,
      "VALIDATION_ERROR",
      "Solicitud inválida.",
    );
    assert.ok(
      !observedOperations.some(
        ({ type, table }) => type === "update" && table === "tb_incomes",
      ),
    );
    observedOperations.length = 0;
    const queryOverrideResponse = await updateRoute.PATCH(
      patchRequest(`${incomeFirst}?householdId=${householdB}`, {
        amount: 77.77,
      }),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(queryOverrideResponse.status, 200);
    assert.ok(
      observedOperations.some(
        ({ type, table, column, value }) =>
          type === "filter" &&
          table === "tb_incomes" &&
          column === "household_id" &&
          value === householdA,
      ),
    );
    assert.equal(
      observedOperations.filter(({ type }) => type === "update").length,
      1,
    );
    assert.equal(
      observedOperations.filter(({ type }) => type === "rpc").length,
      0,
    );
    console.log(
      "PASS PATCH query householdId cannot override context and performs one update",
    );
    Object.assign(incomes[2], originalIncome);
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = missingHousehold;
    const configuredHouseholdIgnored = await updateRoute.PATCH(
      patchRequest(incomeFirst, { amount: 1 }),
      { params: Promise.resolve({ id: incomeFirst }) },
    );
    assert.equal(configuredHouseholdIgnored.status, 200);
    Object.assign(incomes[2], originalIncome);
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    failedTable = "tb_incomes";
    await expectPatchError(
      updateRoute,
      incomeFirst,
      { amount: 1 },
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operaciÃ³n.",
    );
    failedTable = undefined;
    const unexpectedUpdate = createTypeScriptLoader(
      new Map([
        [
          serviceModule,
          {
            updateIncome: async () => {
              throw new Error("private persistence details");
            },
          },
        ],
      ]),
    )(updateRouteModule);
    await expectPatchError(
      unexpectedUpdate,
      incomeFirst,
      { amount: 1 },
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operaciÃ³n.",
    );
    console.log("PASS PATCH parsing, validation, isolation and error handling");

    observedOperations.length = 0;
    const success = await route.GET(request());
    assert.equal(success.status, 200);
    const successBody = await readJson(success);
    assert.deepEqual(successBody, {
      data: [
        {
          id: incomeFirst,
          createdBy: memberA,
          memberId: memberA,
          amount: 10.01,
          incomeDate: "2026-08-03",
          description: "Same timestamp first ID",
          categoryId: categoryA,
        },
        {
          id: incomeSecond,
          createdBy: memberA,
          memberId: memberA,
          amount: 20.02,
          incomeDate: "2026-08-03",
          description: "Same timestamp second ID",
          categoryId: categoryA,
        },
        {
          id: incomeThird,
          createdBy: memberA,
          memberId: memberA,
          amount: 30.03,
          incomeDate: "2026-08-02",
          description: "Older",
          categoryId: null,
        },
      ],
      pagination: {
        page: 1,
        pageSize: 25,
        total: 3,
        totalPages: 1,
      },
      summary: { totalIncome: 60.06 },
    });
    for (const item of successBody.data) {
      assert.deepEqual(Object.keys(item).sort(), [
        "amount",
        "categoryId",
        "createdBy",
        "description",
        "id",
        "incomeDate",
        "memberId",
      ]);
      assert.equal(typeof item.amount, "number");
      assert.ok(!Object.hasOwn(item, "householdId"));
      assert.ok(!Object.hasOwn(item, "createdAt"));
      assert.ok(!Object.hasOwn(item, "updatedAt"));
    }
    assert.equal(typeof successBody.summary.totalIncome, "number");
    assert.doesNotThrow(() => JSON.stringify(successBody));
    assert.ok(
      hasOperation({
        type: "filter",
        table: "tb_incomes",
        column: "household_id",
        value: householdA,
      }),
    );
    const incomeOrderings = observedOperations
      .filter(({ type, table }) => type === "order" && table === "tb_incomes")
      .map(({ column, ascending }) => ({ column, ascending }));
    assert.deepEqual(incomeOrderings.slice(0, 3), [
      { column: "income_date", ascending: false },
      { column: "created_at", ascending: false },
      { column: "id", ascending: true },
    ]);
    assert.deepEqual(incomeOrderings.slice(3), [
      { column: "id", ascending: true },
    ]);
    assert.equal(
      observedOperations.filter(
        ({ type, table }) => type === "from" && table === "tb_incomes",
      ).length,
      2,
    );
    console.log("PASS GET returns exact DTO, summary and deterministic order");
    console.log("PASS household isolation and numeric JSON serialization");

    const filterCases = [
      ["?from=2026-08-02", "gte", "income_date", "2026-08-02"],
      ["?to=2026-08-03", "lte", "income_date", "2026-08-03"],
      [`?memberId=${memberA}`, "eq", "member_id", memberA],
      [`?categoryId=${categoryA}`, "eq", "category_id", categoryA],
      ["?minAmount=20", "gte", "amount", 20],
      ["?maxAmount=20.02", "lte", "amount", 20.02],
    ];
    for (const [query, operator, column, value] of filterCases) {
      observedOperations.length = 0;
      const response = await route.GET(request(query));
      assert.equal(response.status, 200, query);
      await readJson(response);
      assert.ok(
        hasOperation({ type: "filter", operator, column, value }),
        `missing filter for ${query}`,
      );
    }
    console.log("PASS every documented filter maps to Income Read");

    observedOperations.length = 0;
    const combined = await route.GET(
      request(
        `?from=2026-08-03&to=2026-08-03&memberId=${memberA}&categoryId=${categoryA}`,
      ),
    );
    assert.equal(combined.status, 200);
    assert.equal((await readJson(combined)).data.length, 2);
    for (const column of ["income_date", "member_id", "category_id"]) {
      assert.ok(hasOperation({ type: "filter", column }), column);
    }
    console.log("PASS all four filters can be combined");

    incomes = [...baselineIncomes];
    const amountRange = await route.GET(
      request("?minAmount=20&maxAmount=30.03"),
    );
    assert.equal(amountRange.status, 200);
    const amountRangeBody = await readJson(amountRange);
    assert.deepEqual(
      amountRangeBody.data.map(({ id }) => id),
      [incomeSecond, incomeThird],
    );
    assert.deepEqual(amountRangeBody.pagination, {
      page: 1,
      pageSize: 25,
      total: 2,
      totalPages: 1,
    });
    assert.equal(amountRangeBody.summary.totalIncome, 50.05);
    assert.ok(
      hasOperation({
        type: "filter",
        operator: "gte",
        column: "amount",
        value: 20,
      }),
    );
    assert.ok(
      hasOperation({
        type: "filter",
        operator: "lte",
        column: "amount",
        value: 30.03,
      }),
    );
    console.log("PASS Income amount range filters update data, pagination and summary");

    const paginatedFixtures = Array.from({ length: 26 }, (_, index) => ({
      id: `42000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
      household_id: householdA,
      created_by: memberA,
      member_id: memberA,
      amount: String(100 + index),
      income_date: "2026-09-01",
      description: `Paginated ${index}`,
      category_id: index === 0 ? incomeCategoryC : categoryA,
      created_at: `2026-09-${String(1 + (index % 9)).padStart(2, "0")}T12:00:00+00:00`,
      updated_at: `2026-09-${String(1 + (index % 9)).padStart(2, "0")}T12:00:00+00:00`,
    }));
    incomes = [...baselineIncomes, ...paginatedFixtures];
    const expectedPaginatedTotal = incomes
      .filter(({ household_id }) => household_id === householdA)
      .reduce((total, income) => total + Number(income.amount), 0);

    const pageOne = await route.GET(request("?page=1&pageSize=25"));
    const pageOneBody = await readJson(pageOne);
    assert.equal(pageOne.status, 200);
    assert.equal(pageOneBody.data.length, 25);
    assert.deepEqual(pageOneBody.pagination, {
      page: 1,
      pageSize: 25,
      total: 29,
      totalPages: 2,
    });
    assert.equal(pageOneBody.summary.totalIncome, expectedPaginatedTotal);

    const pageTwo = await route.GET(request("?page=2&pageSize=25"));
    const pageTwoBody = await readJson(pageTwo);
    assert.equal(pageTwo.status, 200);
    assert.equal(pageTwoBody.data.length, 4);
    assert.equal(
      new Set(pageOneBody.data.map(({ id }) => id)).size,
      25,
    );
    assert.equal(
      pageTwoBody.data.some(({ id }) =>
        pageOneBody.data.some((pageOneItem) => pageOneItem.id === id),
      ),
      false,
    );
    assert.ok(
      observedOperations.some(
        ({ type, table, from, to }) =>
          type === "range" && table === "tb_incomes" && from === 0 && to === 24,
      ),
    );
    assert.ok(
      observedOperations.some(
        ({ type, table, from, to }) =>
          type === "range" && table === "tb_incomes" && from === 25 && to === 49,
      ),
    );

    const searchResult = await route.GET(request("?search=Paginated%205"));
    const searchBody = await readJson(searchResult);
    assert.equal(searchBody.data.length, 1);
    assert.equal(searchBody.data[0].description, "Paginated 5");
    assert.ok(
      observedOperations.some(
        ({ type, table, expression }) =>
          type === "or" &&
          table === "tb_incomes" &&
          expression.includes('description.ilike."%Paginated 5%"'),
      ),
    );
    const literalWildcardSearch = await route.GET(request("?search=%25"));
    const literalWildcardBody = await readJson(literalWildcardSearch);
    assert.equal(literalWildcardSearch.status, 200);
    assert.deepEqual(literalWildcardBody.data, []);

    const alphaMicroIncomes = incomes.filter(
      ({ household_id, category_id }) =>
        household_id === householdA && category_id === categoryA,
    );
    const gammaMicroIncomes = incomes.filter(
      ({ household_id, category_id }) =>
        household_id === householdA && category_id === incomeCategoryC,
    );
    const alphaSearch = await route.GET(
      request(`?search=${encodeURIComponent("Income Micro Alpha")}&pageSize=100`),
    );
    const alphaSearchBody = await readJson(alphaSearch);
    assert.equal(alphaSearch.status, 200);
    assert.deepEqual(
      alphaSearchBody.data.map(({ id }) => id).sort(),
      alphaMicroIncomes.map(({ id }) => id).sort(),
    );

    const partialMicroSearch = await route.GET(
      request(`?search=${encodeURIComponent("Micro Alph")}&pageSize=100`),
    );
    const partialMicroSearchBody = await readJson(partialMicroSearch);
    assert.equal(partialMicroSearch.status, 200);
    assert.deepEqual(
      partialMicroSearchBody.data.map(({ id }) => id).sort(),
      alphaMicroIncomes.map(({ id }) => id).sort(),
    );

    const macroSearch = await route.GET(
      request(`?search=${encodeURIComponent("Income Macro Beta")}`),
    );
    const macroSearchBody = await readJson(macroSearch);
    assert.equal(macroSearch.status, 200);
    assert.deepEqual(
      macroSearchBody.data.map(({ id }) => id).sort(),
      gammaMicroIncomes.map(({ id }) => id).sort(),
    );

    const partialMacroSearch = await route.GET(
      request(`?search=${encodeURIComponent("Macro Bet")}`),
    );
    const partialMacroSearchBody = await readJson(partialMacroSearch);
    assert.equal(partialMacroSearch.status, 200);
    assert.deepEqual(
      partialMacroSearchBody.data.map(({ id }) => id).sort(),
      gammaMicroIncomes.map(({ id }) => id).sort(),
    );

    const noCategoryMatch = await route.GET(
      request(`?search=${encodeURIComponent("No income category match")}`),
    );
    const noCategoryMatchBody = await readJson(noCategoryMatch);
    assert.equal(noCategoryMatch.status, 200);
    assert.deepEqual(noCategoryMatchBody.data, []);

    const searchWithMacro = await route.GET(
      request(
        `?search=${encodeURIComponent("Income Macro Alpha")}&macroId=${incomeMacroCategory}&pageSize=100`,
      ),
    );
    const searchWithMacroBody = await readJson(searchWithMacro);
    assert.equal(searchWithMacro.status, 200);
    assert.deepEqual(
      searchWithMacroBody.data.map(({ id }) => id).sort(),
      alphaMicroIncomes.map(({ id }) => id).sort(),
    );

    const searchWithCategory = await route.GET(
      request(
        `?search=${encodeURIComponent("Income Macro Alpha")}&categoryId=${categoryA}&pageSize=100`,
      ),
    );
    const searchWithCategoryBody = await readJson(searchWithCategory);
    assert.equal(searchWithCategory.status, 200);
    assert.deepEqual(
      searchWithCategoryBody.data.map(({ id }) => id).sort(),
      alphaMicroIncomes.map(({ id }) => id).sort(),
    );

    const mismatchedSearchAndCategory = await route.GET(
      request(
        `?search=${encodeURIComponent("Income Micro Gamma")}&categoryId=${categoryA}`,
      ),
    );
    const mismatchedSearchAndCategoryBody = await readJson(
      mismatchedSearchAndCategory,
    );
    assert.equal(mismatchedSearchAndCategory.status, 200);
    assert.deepEqual(mismatchedSearchAndCategoryBody.data, []);

    const alphaPage = await route.GET(
      request(
        `?search=${encodeURIComponent("Income Macro Alpha")}&page=2&pageSize=25`,
      ),
    );
    const alphaPageBody = await readJson(alphaPage);
    const alphaTotal = alphaMicroIncomes.reduce(
      (total, { amount }) => total + Number(amount),
      0,
    );
    assert.equal(alphaPage.status, 200);
    assert.equal(alphaPageBody.data.length, 2);
    assert.equal(alphaPageBody.pagination.total, alphaMicroIncomes.length);
    assert.equal(alphaPageBody.summary.totalIncome, Math.round(alphaTotal * 100) / 100);

    const macroResult = await route.GET(
      request(`?macroId=${incomeMacroCategoryB}`),
    );
    const macroBody = await readJson(macroResult);
    assert.deepEqual(macroBody.data.map(({ categoryId }) => categoryId), [
      incomeCategoryC,
    ]);
    assert.equal(macroBody.summary.totalIncome, 100);

    for (const categoryId of [
      expenseCategory,
      inactiveIncomeCategory,
      activeUnderInactiveIncomeMacro,
      invalidHierarchyIncomeCategory,
    ]) {
      const categoryFiltered = await route.GET(
        request(`?categoryId=${categoryId}`),
      );
      const categoryFilteredBody = await readJson(categoryFiltered);
      assert.equal(categoryFiltered.status, 200);
      assert.deepEqual(categoryFilteredBody.data, []);
      assert.equal(categoryFilteredBody.summary.totalIncome, 0);
    }

    for (const [sortBy, sortOrder] of [
      ["incomeDate", "asc"],
      ["incomeDate", "desc"],
      ["amount", "asc"],
      ["amount", "desc"],
      ["description", "asc"],
      ["description", "desc"],
    ]) {
      const sorted = await route.GET(
        request(`?sortBy=${sortBy}&sortOrder=${sortOrder}&pageSize=25`),
      );
      const sortedBody = await readJson(sorted);
      assert.equal(sorted.status, 200);
      assert.equal(sortedBody.data.length, 25);
      assert.ok(
        observedOperations.some(
          ({ type, table, column, ascending }) =>
            type === "order" &&
            table === "tb_incomes" &&
            column ===
              (sortBy === "incomeDate"
                ? "income_date"
                : sortBy === "amount"
                  ? "amount"
                  : "description") &&
            ascending === (sortOrder === "asc"),
        ),
      );
    }

    for (const query of [
      "?sortBy=household_id",
      "?sortOrder=sideways",
      "?page=0",
      "?pageSize=10",
      "?search=",
      "?macroId=invalid",
      "?minAmount=",
      "?maxAmount=",
      "?minAmount=-1",
      "?maxAmount=-1",
      "?minAmount=30&maxAmount=20",
    ]) {
      await expectError(
        route,
        query,
        422,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
    }
    incomes = [...baselineIncomes];
    console.log(
      "PASS Income pagination, amount filters, description search, macro filtering, sorting and validation",
    );

    incomes = [];
    const empty = await route.GET(request());
    assert.equal(empty.status, 200);
    assert.deepEqual(await readJson(empty), {
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
      summary: { totalIncome: 0 },
    });
    incomes = [...baselineIncomes];

    const missingCategoryResponse = await route.GET(
      request(`?categoryId=${missingCategory}`),
    );
    assert.equal(missingCategoryResponse.status, 200);
    assert.deepEqual(await readJson(missingCategoryResponse), {
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
      summary: { totalIncome: 0 },
    });
    console.log(
      "PASS empty and unmatched category results preserve zero summary",
    );

    for (const query of [
      "?from=2026-02-30",
      "?from=2026-08-03&to=2026-08-02",
      "?memberId=invalid",
      "?categoryId=invalid",
      "?from=",
      "?to=",
      "?memberId=",
      "?categoryId=",
    ]) {
      await expectError(
        route,
        query,
        422,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
    }
    console.log("PASS domain filter validation maps to sanitized HTTP 422");

    for (const query of [
      "?foo=bar",
      "?status=CONFIRMED",
      `?householdId=${householdB}`,
      "?from=2026-08-01&from=2026-08-02",
      `?memberId=${memberA}&memberId=${memberB}`,
    ]) {
      observedOperations.length = 0;
      await expectError(
        route,
        query,
        400,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
      assert.deepEqual(observedOperations, []);
    }
    console.log(
      "PASS unknown and repeated parameters fail before Context/Service",
    );

    observedOperations.length = 0;
    const ownMember = await route.GET(request(`?memberId=${memberA}`));
    assert.equal(ownMember.status, 200);
    assert.ok(
      hasOperation({
        type: "filter",
        table: "tb_household_members",
        column: "household_id",
        value: householdA,
      }),
    );
    for (const memberId of [missingMember, memberB]) {
      observedOperations.length = 0;
      await expectError(
        route,
        `?memberId=${memberId}`,
        404,
        "NOT_FOUND",
        "Recurso no encontrado.",
      );
      assert.ok(
        !observedOperations.some(
          ({ type, table }) => type === "from" && table === "tb_incomes",
        ),
      );
    }
    console.log(
      "PASS member filtering enforces household membership without leakage",
    );

    for (const authError of ["UNAUTHENTICATED", "NO_ACTIVE_MEMBERSHIP"]) {
      authContextState = { kind: authError, householdId: householdA };
      observedOperations.length = 0;
      await expectError(
        route,
        "",
        authError === "UNAUTHENTICATED" ? 401 : 403,
        authError,
        authError === "UNAUTHENTICATED"
          ? "Se requiere una sesión autenticada."
          : "La identidad autenticada no tiene un hogar activo.",
      );
      assert.ok(
        !observedOperations.some(
          ({ type, table }) => type === "from" && table === "tb_incomes",
        ),
      );
    }
    authContextState = { kind: "HOUSEHOLD_SELECTION_REQUIRED", householdId: householdA };
    await expectError(
      route,
      "",
      409,
      "HOUSEHOLD_SELECTION_REQUIRED",
      "Debes seleccionar un hogar antes de continuar.",
    );
    authContextState = { kind: "APPLICATION_USER_NOT_FOUND", householdId: householdA };
    await expectError(
      route,
      "",
      403,
      "APPLICATION_USER_NOT_FOUND",
      "La identidad autenticada no tiene acceso a la aplicación.",
    );
    authContextState = { kind: "valid", householdId: householdA };
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    console.log("PASS authenticated context errors map to sanitized HTTP responses");

    failedTable = "tb_incomes";
    await expectError(
      route,
      "",
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
    failedTable = undefined;
    console.log("PASS repository failures are fully sanitized");

    const unexpectedError = new Error("private unexpected error", {
      cause: new Error("private cause"),
    });
    unexpectedError.stack = "private stack";
    const unexpectedRoute = createTypeScriptLoader(
      new Map([
        [
          serviceModule,
          {
            listIncomes: async () => {
              throw unexpectedError;
            },
          },
        ],
      ]),
    )(routeModule);
    await expectError(
      unexpectedRoute,
      "",
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
    console.log("PASS unexpected failures do not expose internal details");

    assert.ok(
      observedOperations.every(
        ({ type }) =>
          type === "from" ||
          type === "select" ||
          type === "filter" ||
          type === "order" ||
          type === "range",
      ),
    );
    assert.ok(!observedOperations.some(({ type }) => type === "rpc"));
    console.log("PASS Route exports only GET and performs no writes or RPC");

    const repositoryModule = path.join(
      root,
      "modules",
      "incomes",
      "income.repository.ts",
    );
    const largeIncomeService = createTypeScriptLoader(
      new Map([
        [
          repositoryModule,
          {
            listIncomes: async () => {
              const incomes = Array.from({ length: 91 }, () => ({
                id: incomeFirst,
                householdId: householdA,
                createdBy: memberA,
                memberId: memberA,
                amount: 999999999999.99,
                incomeDate: "2026-08-01",
                description: "Large income",
                categoryId: null,
                createdAt: "2026-08-01T00:00:00+00:00",
                updatedAt: "2026-08-01T00:00:00+00",
              }));
              return {
                incomes,
                allMatchingAmounts: incomes.map(({ amount }) => amount),
                total: incomes.length,
              };
            },
            isIncomeMemberInHousehold: async () => true,
            isIncomeCategoryAvailable: async () => true,
            IncomeRepositoryError: class IncomeRepositoryError extends Error {
              constructor() {
                super();
                this.kind = "TECHNICAL";
              }
            },
          },
        ],
      ]),
    )(serviceModule);
    await assert.rejects(
      () => largeIncomeService.listIncomes({ householdId: householdA }),
      (error) => error?.code === "PERSISTENCE_ERROR",
    );
    console.log("PASS Income rejects unsafe aggregate serialization");
  } finally {
    if (previousHouseholdId === undefined) {
      delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
    } else {
      process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = previousHouseholdId;
    }
    if (previousMemberId === undefined) {
      delete process.env.HOUSEMATE_MVP_MEMBER_ID;
    } else {
      process.env.HOUSEMATE_MVP_MEMBER_ID = previousMemberId;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
