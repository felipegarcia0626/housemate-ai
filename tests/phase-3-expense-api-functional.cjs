const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const serviceModule = path.join(
  root,
  "modules",
  "expenses",
  "expense.service.ts",
);
const routeModule = path.join(root, "app", "api", "expenses", "route.ts");
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
const detailRouteModule = path.join(
  root,
  "app",
  "api",
  "expenses",
  "[id]",
  "route.ts",
);

const householdA = "41000000-0000-4000-8000-000000000001";
const householdB = "41000000-0000-4000-8000-000000000002";
const missingHousehold = "41000000-0000-4000-8000-000000000003";
const memberA = "41000000-0000-4000-8000-000000000011";
const memberB = "41000000-0000-4000-8000-000000000012";
const missingMember = "41000000-0000-4000-8000-000000000013";
const categoryA = "41000000-0000-4000-8000-000000000021";
const expenseMacroCategory = "41000000-0000-4000-8000-000000000022";
const incomeCategory = "41000000-0000-4000-8000-000000000023";
const inactiveExpenseCategory = "41000000-0000-4000-8000-000000000024";
const legacyCategory = "41000000-0000-4000-8000-000000000025";
const missingCategory = "41000000-0000-4000-8000-000000000026";
const invalidHierarchyExpenseCategory = "41000000-0000-4000-8000-000000000028";
const expenseNewer = "41000000-0000-4000-8000-000000000031";
const expenseOlder = "41000000-0000-4000-8000-000000000032";
const expenseCancelled = "41000000-0000-4000-8000-000000000033";
const expenseOtherHousehold = "41000000-0000-4000-8000-000000000034";
const expensePending = "41000000-0000-4000-8000-000000000035";

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
  { id: memberA, household_id: householdA, display_name: "Member A" },
  { id: memberB, household_id: householdB, display_name: "Member B" },
];
const categories = [
  {
    id: categoryA,
    name: "Food",
    movement_type: "EXPENSE",
    level: "MICRO",
    parent_id: expenseMacroCategory,
    is_active: true,
  },
  {
    id: expenseMacroCategory,
    name: "Food macro",
    movement_type: "EXPENSE",
    level: "MACRO",
    parent_id: null,
    is_active: true,
  },
  {
    id: incomeCategory,
    name: "Salary",
    movement_type: "INCOME",
    level: "MICRO",
    parent_id: "41000000-0000-4000-8000-000000000027",
    is_active: true,
  },
  {
    id: inactiveExpenseCategory,
    name: "Inactive expense",
    movement_type: "EXPENSE",
    level: "MICRO",
    parent_id: expenseMacroCategory,
    is_active: false,
  },
  {
    id: invalidHierarchyExpenseCategory,
    name: "Invalid hierarchy expense",
    movement_type: "EXPENSE",
    level: "MICRO",
    parent_id: "41000000-0000-4000-8000-000000000029",
    is_active: true,
  },
  { id: legacyCategory, name: "Legacy category" },
];
const distributions = [
  {
    id: "41000000-0000-4000-8000-000000000041",
    expense_id: expenseNewer,
    household_member_id: memberA,
    amount: "100.50",
    percentage: "100.00",
  },
  {
    id: "41000000-0000-4000-8000-000000000042",
    expense_id: expenseOlder,
    household_member_id: memberA,
    amount: "50.00",
    percentage: "100.00",
  },
];
const items = [
  {
    id: "41000000-0000-4000-8000-000000000051",
    expense_id: expenseNewer,
    name: "Groceries",
    quantity: "2.000",
    unit_price: "50.25",
    total_amount: "100.50",
    category_id: categoryA,
    created_at: "2026-08-10T12:00:00.000Z",
  },
];
const baselineExpenses = [
  {
    id: expenseOlder,
    household_id: householdA,
    category_id: null,
    merchant: "Cafe",
    total_amount: "50.00",
    expense_date: "2026-08-05",
    status: "CONFIRMED",
    created_by: memberA,
    paid_by: memberA,
    currency: "COP",
    description: "Cafe expense",
    source: "WEB",
    created_at: "2026-08-05T12:00:00.000Z",
    updated_at: "2026-08-05T12:00:00.000Z",
    private_value: "must not be exposed",
  },
  {
    id: expenseNewer,
    household_id: householdA,
    category_id: categoryA,
    merchant: "Market",
    total_amount: "100.50",
    expense_date: "2026-08-10",
    status: "CONFIRMED",
    created_by: memberA,
    paid_by: memberA,
    currency: "COP",
    description: "Market expense",
    source: "WEB",
    created_at: "2026-08-10T12:00:00.000Z",
    updated_at: "2026-08-10T12:00:00.000Z",
    private_value: "must not be exposed",
  },
  {
    id: expenseCancelled,
    household_id: householdA,
    category_id: null,
    merchant: null,
    total_amount: "999.00",
    expense_date: "2026-08-11",
    status: "CANCELLED",
    created_by: memberA,
    paid_by: memberA,
    currency: "COP",
    description: "Cancelled expense",
    source: "WEB",
    created_at: "2026-08-11T12:00:00.000Z",
    updated_at: "2026-08-11T12:00:00.000Z",
  },
  {
    id: expenseOtherHousehold,
    household_id: householdB,
    category_id: null,
    merchant: "Other household",
    total_amount: "500.00",
    expense_date: "2026-08-12",
    status: "CONFIRMED",
    created_by: memberB,
    paid_by: memberB,
    currency: "COP",
    description: "Other household expense",
    source: "WEB",
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  },
  {
    id: expensePending,
    household_id: householdA,
    category_id: null,
    merchant: "Pending market",
    total_amount: "20.00",
    expense_date: "2026-08-13",
    status: "PENDING",
    created_by: memberA,
    paid_by: memberA,
    currency: "COP",
    description: "Pending expense",
    source: "WEB",
    created_at: "2026-08-13T12:00:00.000Z",
    updated_at: "2026-08-13T12:00:00.000Z",
  },
];

let expenses = [...baselineExpenses];
let failedTable;
let aggregateError;
let aggregateValueOverride;
let aggregateDataOverride;
let aggregateNull = false;
let fallbackMaxRows;
let fallbackIncompleteFrom;
let fallbackErrorFrom;
let rpcError;
let forceHydrationFailure = false;
let nextCreatedExpense = 60;
const observedOperations = [];

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
  }

  select(columns, options) {
    this.columns = columns;
    this.selectOptions = options;
    observedOperations.push({ type: "select", table: this.table, columns });
    return this;
  }

  or(value) {
    this.orFilter = value;
    observedOperations.push({
      type: "or",
      table: this.table,
      value,
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

  order(column, options) {
    this.orderings = [...(this.orderings ?? []), { column, ...options }];
    observedOperations.push({
      type: "order",
      table: this.table,
      column,
      ...options,
    });
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

  sourceRows() {
    if (this.table === "tb_households") return households;
    if (this.table === "tb_household_members") return members;
    if (this.table === "tb_expenses") return expenses;
    if (this.table === "tb_expense_distributions") return distributions;
    if (this.table === "tb_expense_items") return items;
    if (this.table === "tb_categories") return categories;
    return [];
  }

  execute() {
    if (failedTable === this.table) {
      return {
        data: null,
        error: {
          code: "42501",
          message: "sensitive Supabase/PostgreSQL table detail",
        },
      };
    }

    let rows = this.sourceRows().filter((row) =>
      this.filters.every(({ operator, column, value }) => {
        const current = row[column];
        if (operator === "eq") return current === value;
        if (operator === "in") return value.includes(current);
        if (operator === "ilike") {
          if (typeof current !== "string") return false;
          const normalizedPattern = String(value)
            .replace(/^%|%$/g, "")
            .replace(/\\([\\%_*])/g, "$1")
            .toLowerCase();
          return current.toLowerCase().includes(normalizedPattern);
        }
        const comparableCurrent =
          column === "expense_date" ? String(current) : Number(current);
        const comparableValue =
          column === "expense_date" ? String(value) : Number(value);
        if (operator === "gte") return comparableCurrent >= comparableValue;
        if (operator === "lte") return comparableCurrent <= comparableValue;
        return false;
      }),
    );

    if (this.orFilter) {
      const term = decodeSearchTerm(this.orFilter);
      const normalized = term.toLowerCase();
      const categoryIdsMatch = /category_id\.in\.\(([^)]*)\)/.exec(
        this.orFilter,
      );
      const categoryIds = categoryIdsMatch
        ? categoryIdsMatch[1].split(",").filter(Boolean)
        : [];
      rows = rows.filter((row) =>
        [row.merchant, row.description].some(
          (value) =>
            typeof value === "string" && value.toLowerCase().includes(normalized),
        ) || categoryIds.includes(row.category_id),
      );
    }

    if (this.orderings) {
      rows = [...rows].sort((left, right) => {
        for (const ordering of this.orderings) {
          const direction = ordering.ascending ? 1 : -1;
          const leftValue = left[ordering.column];
          const rightValue = right[ordering.column];
          const result =
            ordering.column === "total_amount" ||
            typeof leftValue === "number" ||
            typeof rightValue === "number"
              ? Number(leftValue) - Number(rightValue)
              : String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
          if (result !== 0) return result * direction;
        }
        return 0;
      });
    }

    const count = this.selectOptions?.count === "exact" ? rows.length : null;
    if (this.columns.includes(".sum()")) {
      if (aggregateError) {
        return { data: null, error: aggregateError };
      }
      if (aggregateNull) {
        return { data: [{ sum: null }], error: null, count };
      }
      if (aggregateValueOverride !== undefined) {
        return {
          data: [{ sum: aggregateValueOverride }],
          error: null,
          count,
        };
      }
      if (aggregateDataOverride !== undefined) {
        return { data: aggregateDataOverride, error: null, count };
      }
      const sum = rows.reduce((total, row) => total + Number(row.total_amount), 0);
      return { data: [{ sum }], error: null, count };
    }

    let pagedRows = this.rangeValues
      ? rows.slice(this.rangeValues.from, this.rangeValues.to + 1)
      : rows;
    if (this.columns === "total_amount") {
      const from = this.rangeValues?.from ?? 0;
      if (fallbackErrorFrom === from) {
        return {
          data: null,
          error: {
            code: "42501",
            message: "fallback block failed",
          },
        };
      }
      if (fallbackMaxRows !== undefined) {
        pagedRows = pagedRows.slice(0, fallbackMaxRows);
      }
      if (this.rangeValues && fallbackIncompleteFrom === from) {
        pagedRows = pagedRows.slice(0, Math.max(0, pagedRows.length - 1));
      }
    }
    return { data: pagedRows, error: null, count };
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
    observedOperations.push({ type: "from", table });
    return new FakeQuery(table);
  },
  rpc(name) {
    const args = arguments[1];
    observedOperations.push({ type: "rpc", name, args });
    if (name === "fn_delete_expense") {
      if (rpcError) return Promise.resolve({ data: null, error: rpcError });
      const index = expenses.findIndex(
        (row) =>
          row.id === args.p_expense_id &&
          row.household_id === args.p_household_id,
      );
      if (index < 0)
        return Promise.resolve({ data: null, error: { code: "P0002" } });
      const expense = expenses[index];
      if (expense.status === "PENDING") {
        expenses.splice(index, 1);
        return Promise.resolve({ data: "DELETED", error: null });
      }
      if (expense.status === "CONFIRMED") {
        expense.status = "CANCELLED";
        return Promise.resolve({ data: "CANCELLED", error: null });
      }
      return Promise.resolve({ data: "ALREADY_CANCELLED", error: null });
    }
    if (name === "fn_update_expense") {
      if (rpcError) return Promise.resolve({ data: null, error: rpcError });
      const expense = expenses.find(
        (row) =>
          row.id === args.p_expense_id &&
          row.household_id === args.p_household_id,
      );
      if (!expense)
        return Promise.resolve({ data: null, error: { code: "P0002" } });
      if (args.p_set_merchant) expense.merchant = args.p_merchant;
      if (args.p_set_description) expense.description = args.p_description;
      if (args.p_total_amount !== null)
        expense.total_amount = String(args.p_total_amount);
      if (args.p_expense_date !== null)
        expense.expense_date = args.p_expense_date;
      if (args.p_paid_by !== null) expense.paid_by = args.p_paid_by;
      if (args.p_set_category_id) expense.category_id = args.p_category_id;
      return Promise.resolve({ data: expense.id, error: null });
    }
    if (name !== "fn_create_expense") {
      throw new Error("Unexpected RPC");
    }
    if (rpcError) {
      return Promise.resolve({ data: null, error: rpcError });
    }

    const id = `41000000-0000-4000-8000-0000000000${nextCreatedExpense++}`;
    if (!forceHydrationFailure) {
      expenses.push({
        id,
        household_id: args.p_household_id,
        category_id: args.p_category_id,
        merchant: args.p_merchant,
        total_amount: String(args.p_total_amount),
        expense_date: args.p_expense_date,
        status: "CONFIRMED",
        created_by: args.p_created_by,
        paid_by: args.p_paid_by,
        currency: "COP",
        description: args.p_description,
        source: args.p_source,
        created_at: "2026-08-12T12:00:00.000Z",
        updated_at: "2026-08-12T12:00:00.000Z",
      });
      for (const [index, item] of args.p_items.entries()) {
        items.push({
          id: `41000000-0000-4000-8000-0000000000${70 + index}`,
          expense_id: id,
          name: item.name,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          total_amount: String(item.totalAmount),
          category_id: item.categoryId,
          created_at: "2026-08-12T12:00:00.000Z",
        });
      }
      for (const [index, distribution] of args.p_distributions.entries()) {
        distributions.push({
          id: `41000000-0000-4000-8000-0000000000${80 + index}`,
          expense_id: id,
          household_member_id:
            distribution.householdMemberId ?? distribution.memberId,
          amount: String(distribution.amount),
          percentage: String(distribution.percentage),
        });
      }
    }
    return Promise.resolve({ data: id, error: null });
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
  return new Request(`http://localhost/api/expenses${query}`);
}

function detailRequest(expenseId, query = "") {
  return new Request(`http://localhost/api/expenses/${expenseId}${query}`);
}

function postRequest(body, query = "") {
  return new Request(`http://localhost/api/expenses${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
    "tb_expenses",
    "sensitive",
    householdA,
  ]) {
    assert.ok(!serialized.includes(secret), `${query}: exposed ${secret}`);
  }
}

function hasOperation(expected) {
  return observedOperations.some((operation) =>
    Object.entries(expected).every(([key, value]) => operation[key] === value),
  );
}

function decodeSearchTerm(orFilter) {
  const marker = 'merchant.ilike."';
  const start = orFilter.indexOf(marker) + marker.length;
  let encoded = "";
  for (let index = start; index < orFilter.length; index += 1) {
    const character = orFilter[index];
    if (character === "\\") {
      encoded += character;
      if (index + 1 < orFilter.length) {
        encoded += orFilter[index + 1];
        index += 1;
      }
      continue;
    }
    if (character === '"') break;
    encoded += character;
  }

  const pattern = encoded.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
  return pattern
    .replace(/^%|%$/g, "")
    .replace(/\\([\\%_*])/g, "$1");
}

async function main() {
  const previousHouseholdId = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  const previousMemberId = process.env.HOUSEMATE_MVP_MEMBER_ID;

  try {
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    const routeSource = fs.readFileSync(routeModule, "utf8");
    assert.ok(!routeSource.includes("expense.repository"));
    assert.ok(!routeSource.includes("database/client"));
    assert.ok(!routeSource.includes("supabase"));
    assert.ok(!routeSource.includes("process.env"));

    const route = createTypeScriptLoader(
      new Map([
        [authServiceModule, fakeAuthService],
        [authTypesModule, fakeAuthTypes],
      ]),
    )(routeModule);
    assert.deepEqual(Object.keys(route).sort(), ["GET", "POST"]);

    observedOperations.length = 0;
    const success = await route.GET(request());
    assert.equal(success.status, 200);
    const successBody = await readJson(success);
    assert.deepEqual(successBody, {
      data: [
        {
          id: expenseNewer,
          merchant: "Market",
          description: "Market expense",
          totalAmount: 100.5,
          expenseDate: "2026-08-10",
          category: {
            id: categoryA,
            name: "Food",
            parentId: expenseMacroCategory,
            parentName: "Food macro",
          },
          paidBy: { memberId: memberA, name: "Member A" },
          distributions: [
            {
              memberId: memberA,
              memberName: "Member A",
              percentage: 100,
              amount: 100.5,
            },
          ],
        },
        {
          id: expenseOlder,
          merchant: "Cafe",
          description: "Cafe expense",
          totalAmount: 50,
          expenseDate: "2026-08-05",
          category: null,
          paidBy: { memberId: memberA, name: "Member A" },
          distributions: [
            {
              memberId: memberA,
              memberName: "Member A",
              percentage: 100,
              amount: 50,
            },
          ],
        },
      ],
      pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
      summary: { totalCount: 2, totalAmount: 150.5 },
    });
    assert.equal(typeof successBody.data[0].totalAmount, "number");
    assert.doesNotThrow(() => JSON.stringify(successBody));
    assert.ok(
      hasOperation({
        type: "filter",
        table: "tb_expenses",
        column: "household_id",
        value: householdA,
      }),
    );
    assert.ok(
      hasOperation({
        type: "filter",
        table: "tb_expenses",
        column: "status",
        value: "CONFIRMED",
      }),
    );
    assert.ok(
      hasOperation({
        type: "select",
        table: "tb_expenses",
        columns:
          "id,category_id,merchant,paid_by,description,total_amount,expense_date,created_at",
      }),
    );
    assert.equal(
      observedOperations.filter(
        ({ type, table }) => type === "from" && table === "tb_expenses",
      ).length,
      2,
    );
    console.log(
      "PASS GET without filters preserves domain order and exact public fields",
    );
    console.log(
      "PASS household isolation, CONFIRMED status and numeric serialization",
    );

    const filterCases = [
      ["?from=2026-08-01", "gte", "expense_date", "2026-08-01"],
      ["?to=2026-08-31", "lte", "expense_date", "2026-08-31"],
      [`?categoryId=${categoryA}`, "eq", "category_id", categoryA],
      [`?memberId=${memberA}`, "eq", "household_member_id", memberA],
      ["?merchant=Market", "eq", "merchant", "Market"],
      ["?minAmount=100.5", "gte", "total_amount", 100.5],
      ["?maxAmount=100.5", "lte", "total_amount", 100.5],
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
    console.log("PASS every documented filter maps to the domain query");

    observedOperations.length = 0;
    const combinedQuery =
      `?from=2026-08-01&to=2026-08-31&categoryId=${categoryA}` +
      `&memberId=${memberA}&merchant=Market&minAmount=100&maxAmount=101`;
    const combined = await route.GET(request(combinedQuery));
    assert.equal(combined.status, 200);
    const combinedBody = await readJson(combined);
    assert.equal(combinedBody.data.length, 1);
    assert.equal(combinedBody.summary.totalCount, 1);
    assert.equal(combinedBody.summary.totalAmount, 100.5);
    for (const column of [
      "expense_date",
      "category_id",
      "household_member_id",
      "merchant",
      "total_amount",
    ]) {
      assert.ok(hasOperation({ type: "filter", column }), column);
    }
    console.log("PASS all seven filters can be combined");

    const paginationFixtures = Array.from({ length: 27 }, (_, index) => ({
      id: `41000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
      household_id: householdA,
      category_id: null,
      merchant: `Pagination ${index}`,
      total_amount:
        index < 2 ? "75.00" : index < 4 ? "76.00" : String(200 + index),
      expense_date: "2026-08-20",
      status: "CONFIRMED",
      created_by: memberA,
      paid_by: memberA,
      currency: "COP",
      description: `Pagination description ${index}`,
      source: "WEB",
      created_at: `2026-08-20T12:${String(index < 4 ? (index < 2 ? index : 2) : index).padStart(2, "0")}:00.000Z`,
      updated_at: "2026-08-20T12:00:00.000Z",
    }));
    const expensesBeforePagination = expenses;
    const distributionsBeforePagination = distributions.length;
    distributions.push(
      {
        id: "41000000-0000-4000-8000-000000000061",
        expense_id: paginationFixtures[2].id,
        household_member_id: memberA,
        amount: "202.00",
        percentage: "100.00",
      },
      {
        id: "41000000-0000-4000-8000-000000000062",
        expense_id: paginationFixtures[0].id,
        household_member_id: memberA,
        amount: "200.00",
        percentage: "100.00",
      },
    );
    expenses = [...baselineExpenses, ...paginationFixtures];
    observedOperations.length = 0;
    const firstPage = await route.GET(request("?page=1&pageSize=25"));
    const firstPageBody = await readJson(firstPage);
    assert.equal(firstPage.status, 200);
    assert.equal(firstPageBody.pagination.page, 1);
    assert.equal(firstPageBody.pagination.pageSize, 25);
    assert.equal(firstPageBody.pagination.total, 29);
    assert.equal(firstPageBody.pagination.totalPages, 2);
    assert.equal(firstPageBody.summary.totalCount, 29);
    assert.equal(firstPageBody.summary.totalAmount, 5397.5);
    assert.equal(firstPageBody.data.length, 25);
    assert.ok(hasOperation({ type: "range", table: "tb_expenses", from: 0, to: 24 }));
    const firstPageIds = new Set(firstPageBody.data.map(({ id }) => id));
    const firstPageDistributionQuery = observedOperations.find(
      ({ type, table, operator }) =>
        type === "filter" &&
        table === "tb_expense_distributions" &&
        operator === "in",
    );
    assert.ok(firstPageDistributionQuery);
    assert.ok(
      firstPageDistributionQuery.value.every((id) => firstPageIds.has(id)),
    );
    assert.equal(
      observedOperations.filter(
        ({ type, table }) =>
          type === "from" && table === "tb_expense_distributions",
      ).length,
      1,
    );
    assert.equal(
      observedOperations.filter(
        ({ type, table }) =>
          type === "from" && table === "tb_household_members",
      ).length,
      1,
    );
    assert.deepEqual(
      firstPageBody.data.find(({ id }) => id === paginationFixtures[2].id).distributions,
      [
        {
          memberId: memberA,
          memberName: "Member A",
          percentage: 100,
          amount: 202,
        },
      ],
    );

    observedOperations.length = 0;
    const secondPage = await route.GET(request("?page=2&pageSize=25"));
    const secondPageBody = await readJson(secondPage);
    assert.equal(secondPageBody.data.length, 4);
    assert.equal(
      secondPageBody.data.some(({ id }) =>
        firstPageBody.data.some((first) => first.id === id),
      ),
      false,
    );
    assert.deepEqual(secondPageBody.pagination, {
      page: 2,
      pageSize: 25,
      total: 29,
      totalPages: 2,
    });
    assert.equal(secondPageBody.summary.totalAmount, 5397.5);
    const secondPageIds = new Set(secondPageBody.data.map(({ id }) => id));
    const secondPageDistributionQuery = observedOperations.find(
      ({ type, table, operator }) =>
        type === "filter" &&
        table === "tb_expense_distributions" &&
        operator === "in",
    );
    assert.ok(secondPageDistributionQuery);
    assert.ok(
      secondPageDistributionQuery.value.every((id) => secondPageIds.has(id)),
    );
    assert.equal(
      observedOperations.filter(
        ({ type, table }) =>
          type === "from" && table === "tb_expense_distributions",
      ).length,
      1,
    );
    assert.equal(
      observedOperations.filter(
        ({ type, table }) =>
          type === "from" && table === "tb_household_members",
      ).length,
      1,
    );
    assert.deepEqual(
      secondPageBody.data.find(({ id }) => id === paginationFixtures[0].id)
        .distributions,
      [
        {
          memberId: memberA,
          memberName: "Member A",
          percentage: 100,
          amount: 200,
        },
      ],
    );
    for (const pageSize of [50, 100]) {
      const response = await route.GET(request(`?pageSize=${pageSize}`));
      const body = await readJson(response);
      assert.equal(body.pagination.pageSize, pageSize);
      assert.equal(body.pagination.total, 29);
      assert.equal(body.summary.totalAmount, 5397.5);
    }

    const amountTiePage = await route.GET(
      request("?sort=amount&sortDirection=asc&pageSize=100"),
    );
    const amountTieIds = (await readJson(amountTiePage)).data.map(({ id }) => id);
    assert.deepEqual(amountTieIds.slice(1, 3), [paginationFixtures[1].id, paginationFixtures[0].id]);
    assert.deepEqual(amountTieIds.slice(3, 5), [paginationFixtures[2].id, paginationFixtures[3].id]);
    const dateTiePage = await route.GET(request("?pageSize=100"));
    const dateTieIds = (await readJson(dateTiePage)).data.map(({ id }) => id);
    assert.deepEqual(dateTieIds.slice(0, 2), [paginationFixtures[26].id, paginationFixtures[25].id]);
    expenses = expensesBeforePagination;
    distributions.length = distributionsBeforePagination;
    console.log("PASS server pagination, cross-page summary and stable tie-break ordering");

    const searchMerchant = await route.GET(request("?search=Market"));
    assert.deepEqual((await readJson(searchMerchant)).data.map(({ id }) => id), [
      expenseNewer,
    ]);
    const searchDescription = await route.GET(request("?search=Cafe expense"));
    assert.deepEqual((await readJson(searchDescription)).data.map(({ id }) => id), [
      expenseOlder,
    ]);
    observedOperations.length = 0;
    const searchMicro = await route.GET(request("?search=Food"));
    assert.deepEqual((await readJson(searchMicro)).data.map(({ id }) => id), [
      expenseNewer,
    ]);
    assert.ok(
      hasOperation({
        type: "filter",
        table: "tb_categories",
        operator: "ilike",
        column: "name",
      }),
    );
    const searchMacro = await route.GET(request("?search=Food macro"));
    assert.deepEqual((await readJson(searchMacro)).data.map(({ id }) => id), [
      expenseNewer,
    ]);
    const searchAndMacro = await route.GET(
      request(`?search=Food&macroId=${expenseMacroCategory}`),
    );
    assert.deepEqual(
      (await readJson(searchAndMacro)).data.map(({ id }) => id),
      [expenseNewer],
    );
    const searchAndMicro = await route.GET(
      request(`?search=Food&categoryId=${categoryA}`),
    );
    assert.deepEqual(
      (await readJson(searchAndMicro)).data.map(({ id }) => id),
      [expenseNewer],
    );
    const searchMissing = await route.GET(request("?search=does-not-exist"));
    assert.deepEqual((await readJson(searchMissing)).data, []);
    console.log("PASS DB-side partial search over merchant, description and categories");

    const reservedSearchTerms = [":", ".", "%", "_", "*", ",", "(", ")", "\\", '"', "partial text"];
    const expensesBeforeReservedSearch = expenses;
    expenses = [
      ...baselineExpenses,
      ...reservedSearchTerms.map((term, index) => ({
        ...baselineExpenses[0],
        id: `42000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
        merchant: `Reserved ${term} merchant`,
        description: `Reserved ${term} description`,
        created_at: `2026-08-15T12:${String(index).padStart(2, "0")}:00.000Z`,
      })),
    ];
    for (const term of reservedSearchTerms) {
      const response = await route.GET(
        request(`?search=${encodeURIComponent(term)}`),
      );
      assert.equal(response.status, 200, `reserved search ${JSON.stringify(term)}`);
      const body = await readJson(response);
      assert.equal(body.data.length, 1, `reserved search ${JSON.stringify(term)}`);
      assert.match(body.data[0].merchant, new RegExp(`Reserved ${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} merchant`));
    }
    const reservedOrFilter = observedOperations.find(({ type }) => type === "or");
    assert.ok(reservedOrFilter?.value.includes('merchant.ilike."%'));
    expenses = expensesBeforeReservedSearch;
    console.log("PASS partial search preserves PostgREST-reserved characters");

    aggregateError = { code: "PGRST123", message: "aggregates unavailable" };
    observedOperations.length = 0;
    const aggregateFallback = await route.GET(request());
    assert.equal(aggregateFallback.status, 200);
    assert.equal((await readJson(aggregateFallback)).summary.totalAmount, 150.5);
    assert.ok(
      observedOperations.some(
        ({ type, columns }) => type === "select" && columns === "total_amount",
      ),
    );
    assert.ok(
      hasOperation({ type: "range", table: "tb_expenses", from: 0, to: 1 }),
    );

    const expensesBeforeSummaryFallback = expenses;
    const largeSummaryFixtures = Array.from({ length: 2500 }, (_, index) => ({
      ...baselineExpenses[0],
      id: `43000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      merchant: `Summary ${index}`,
      description: `Summary fallback ${index}`,
      total_amount: "1.00",
      created_at: "2026-08-15T12:00:00.000Z",
    }));
    expenses = largeSummaryFixtures;
    fallbackMaxRows = 500;
    observedOperations.length = 0;
    const largeAggregateFallback = await route.GET(request());
    assert.equal(largeAggregateFallback.status, 200);
    assert.equal(
      (await readJson(largeAggregateFallback)).summary.totalAmount,
      2500,
    );
    assert.deepEqual(
      observedOperations
        .filter(({ type, columns }) => type === "select" && columns === "total_amount")
        .length,
      5,
    );
    assert.equal(
      observedOperations.filter(
        ({ type, column, ascending }) =>
          type === "order" && column === "id" && ascending === true,
      ).length,
      6,
    );
    assert.deepEqual(
      observedOperations
        .filter(({ type, from }) => type === "range" && from !== undefined)
        .map(({ from, to }) => [from, to]),
      [
        [0, 24],
        [0, 499],
        [500, 999],
        [1000, 1499],
        [1500, 1999],
        [2000, 2499],
      ],
    );
    fallbackMaxRows = undefined;
    expenses = expensesBeforeSummaryFallback;

    expenses = largeSummaryFixtures;
    aggregateError = { code: "PGRST123", message: "aggregates unavailable" };
    fallbackMaxRows = 500;
    fallbackIncompleteFrom = 500;
    await expectError(
      route,
      "",
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
    fallbackIncompleteFrom = undefined;
    fallbackErrorFrom = 500;
    await expectError(
      route,
      "",
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
    fallbackErrorFrom = undefined;
    fallbackMaxRows = undefined;
    expenses = expensesBeforeSummaryFallback;

    aggregateError = { code: "42501", message: "aggregate denied" };
    observedOperations.length = 0;
    await expectError(
      route,
      "",
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
    assert.equal(
      observedOperations.some(
        ({ type, columns }) => type === "select" && columns === "total_amount",
      ),
      false,
    );
    aggregateError = undefined;
    aggregateValueOverride = "100000000000.00";
    const safeLargeAggregate = await route.GET(request());
    assert.equal(safeLargeAggregate.status, 200);
    assert.equal((await readJson(safeLargeAggregate)).summary.totalAmount, 100000000000);
    aggregateValueOverride = undefined;
    aggregateValueOverride = "90071992547409.92";
    await expectError(
      route,
      "",
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
    aggregateValueOverride = undefined;

    aggregateNull = true;
    await expectError(
      route,
      "",
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
    aggregateNull = false;
    for (const malformedAggregate of [
      {},
      [],
      [{ unexpected: "value" }],
      [{ sum: null }],
      [{ sum: "not-a-number" }],
      null,
    ]) {
      aggregateDataOverride = malformedAggregate;
      await expectError(
        route,
        "",
        500,
        "INTERNAL_ERROR",
        "No fue posible completar la operación.",
      );
    }
    aggregateDataOverride = undefined;

    expenses = [];
    aggregateNull = true;
    const nullAggregate = await route.GET(request());
    assert.equal(nullAggregate.status, 200);
    assert.equal((await readJson(nullAggregate)).summary.totalAmount, 0);
    aggregateNull = false;
    expenses = [...baselineExpenses];
    console.log("PASS aggregate fallback, error propagation and safe monetary serialization");

    const macro = await route.GET(request(`?macroId=${expenseMacroCategory}`));
    const macroBody = await readJson(macro);
    assert.deepEqual(macroBody.data.map(({ id }) => id), [expenseNewer]);
    assert.equal(macroBody.summary.totalAmount, 100.5);
    const compatible = await route.GET(
      request(`?macroId=${expenseMacroCategory}&categoryId=${categoryA}`),
    );
    assert.deepEqual((await readJson(compatible)).data.map(({ id }) => id), [
      expenseNewer,
    ]);
    const incompatible = await route.GET(
      request(`?macroId=${expenseMacroCategory}&categoryId=${incomeCategory}`),
    );
    assert.deepEqual((await readJson(incompatible)).data, []);
    console.log("PASS macro filtering enforces the category hierarchy");

    const amountAscending = await route.GET(
      request("?sort=amount&sortDirection=asc"),
    );
    assert.deepEqual((await readJson(amountAscending)).data.map(({ id }) => id), [
      expenseOlder,
      expenseNewer,
    ]);
    for (const query of [
      "?page=0",
      "?page=1.5",
      "?pageSize=10",
      "?sort=private_value",
      "?sortDirection=sideways",
      "?macroId=invalid",
      "?search=",
    ]) {
      await expectError(
        route,
        query,
        422,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
    }
    console.log("PASS collection pagination, macro, search and sort validation");

    expenses = [];
    const empty = await route.GET(request());
    assert.equal(empty.status, 200);
    assert.deepEqual(await readJson(empty), {
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
      summary: { totalCount: 0, totalAmount: 0 },
    });
    expenses = [...baselineExpenses];
    console.log("PASS empty result returns data array");

    for (const query of [
      "?from=2026-02-30",
      "?from=2026-08-10&to=2026-08-01",
      "?categoryId=invalid",
      "?minAmount=invalid",
      "?minAmount=-1",
      "?minAmount=Infinity",
      "?minAmount=200&maxAmount=100",
    ]) {
      await expectError(
        route,
        query,
        422,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
    }
    console.log("PASS domain validation errors map to sanitized HTTP 422");

    for (const query of [
      "?status=CONFIRMED",
      `?householdId=${householdB}`,
      "?foo=bar",
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
    for (const query of ["?minAmount=", "?maxAmount="]) {
      observedOperations.length = 0;
      await expectError(
        route,
        query,
        422,
        "VALIDATION_ERROR",
        "Solicitud inválida.",
      );
      assert.deepEqual(observedOperations, []);
    }
    console.log(
      "PASS unknown, repeated and empty numeric parameters fail before context/service",
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
          ({ type, table }) => type === "from" && table === "tb_expenses",
        ),
      );
    }
    console.log(
      "PASS member filters enforce household membership without leakage",
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
          ({ type, table }) => type === "from" && table === "tb_expenses",
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

    failedTable = "tb_expenses";
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
            listExpensesCollection: async () => {
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
    console.log("PASS unexpected errors do not expose internal details");

    assert.ok(
      observedOperations.every(
        ({ type }) =>
          type === "from" ||
          type === "select" ||
          type === "filter" ||
          type === "order" ||
          type === "or" ||
          type === "range",
      ),
    );
    assert.ok(!observedOperations.some(({ type }) => type === "rpc"));
    console.log("PASS Route exports GET and POST with list flow unchanged");

    const detailRoute = createTypeScriptLoader(
      new Map([
        [authServiceModule, fakeAuthService],
        [authTypesModule, fakeAuthTypes],
      ]),
    )(detailRouteModule);
    assert.deepEqual(Object.keys(detailRoute).sort(), [
      "DELETE",
      "GET",
      "PATCH",
    ]);
    const detail = await detailRoute.GET(detailRequest(expenseNewer), {
      params: Promise.resolve({ id: expenseNewer }),
    });
    assert.equal(detail.status, 200);
    assert.deepEqual(await readJson(detail), {
      data: {
        id: expenseNewer,
        createdBy: memberA,
        paidByMemberId: memberA,
        merchant: "Market",
        description: "Market expense",
        totalAmount: 100.5,
        expenseDate: "2026-08-10",
        status: "CONFIRMED",
        category: { id: categoryA, name: "Food" },
        items: [
          {
            name: "Groceries",
            quantity: 2,
            unitPrice: 50.25,
            totalPrice: 100.5,
            category: { id: categoryA, name: "Food" },
          },
        ],
        splits: [{ memberId: memberA, percentage: 100, amount: 100.5 }],
      },
    });
    console.log("PASS GET expense detail returns the exact public DTO");

    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdB;
    const authenticatedHouseholdDetail = await detailRoute.GET(
      detailRequest(expenseNewer),
      { params: Promise.resolve({ id: expenseNewer }) },
    );
    assert.equal(authenticatedHouseholdDetail.status, 200);
    authContextState = { kind: "UNAUTHENTICATED", householdId: householdA };
    let authDetailResponse = await detailRoute.GET(detailRequest(expenseNewer), {
      params: Promise.resolve({ id: expenseNewer }),
    });
    assert.equal(authDetailResponse.status, 401);
    assert.deepEqual(await readJson(authDetailResponse), {
      error: { code: "UNAUTHENTICATED", message: "Se requiere una sesión autenticada." },
    });
    authContextState = { kind: "APPLICATION_USER_NOT_FOUND", householdId: householdA };
    authDetailResponse = await detailRoute.GET(detailRequest(expenseNewer), {
      params: Promise.resolve({ id: expenseNewer }),
    });
    assert.equal(authDetailResponse.status, 403);
    assert.deepEqual(await readJson(authDetailResponse), {
      error: { code: "APPLICATION_USER_NOT_FOUND", message: "La identidad autenticada no tiene acceso a la aplicación." },
    });
    authContextState = { kind: "NO_ACTIVE_MEMBERSHIP", householdId: householdA };
    authDetailResponse = await detailRoute.GET(detailRequest(expenseNewer), {
      params: Promise.resolve({ id: expenseNewer }),
    });
    assert.equal(authDetailResponse.status, 403);
    assert.deepEqual(await readJson(authDetailResponse), {
      error: { code: "NO_ACTIVE_MEMBERSHIP", message: "La identidad autenticada no tiene un hogar activo." },
    });
    authContextState = { kind: "HOUSEHOLD_SELECTION_REQUIRED", householdId: householdA };
    authDetailResponse = await detailRoute.GET(detailRequest(expenseNewer), {
      params: Promise.resolve({ id: expenseNewer }),
    });
    assert.equal(authDetailResponse.status, 409);
    assert.deepEqual(await readJson(authDetailResponse), {
      error: { code: "HOUSEHOLD_SELECTION_REQUIRED", message: "Debes seleccionar un hogar antes de continuar." },
    });
    authContextState = { kind: "valid", householdId: householdA };
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    console.log("PASS detail uses authenticated household and maps auth errors");

    const cancelledDetail = await detailRoute.GET(
      detailRequest(expenseCancelled),
      { params: Promise.resolve({ id: expenseCancelled }) },
    );
    assert.equal(cancelledDetail.status, 200);
    assert.deepEqual(await readJson(cancelledDetail), {
      data: {
        id: expenseCancelled,
        createdBy: memberA,
        paidByMemberId: memberA,
        merchant: null,
        description: "Cancelled expense",
        totalAmount: 999,
        expenseDate: "2026-08-11",
        status: "CANCELLED",
        category: null,
        items: [],
        splits: [],
      },
    });
    console.log("PASS GET expense detail supports existing Expense states");

    observedOperations.length = 0;
    const queryHousehold = await detailRoute.GET(
      detailRequest(expenseNewer, `?householdId=${householdB}`),
      { params: Promise.resolve({ id: expenseNewer }) },
    );
    assert.equal(queryHousehold.status, 400);
    assert.deepEqual(await readJson(queryHousehold), {
      error: { code: "VALIDATION_ERROR", message: "Solicitud inválida." },
    });
    assert.deepEqual(observedOperations, []);
    console.log("PASS detail query householdId cannot alter context");

    const crossHouseholdDetail = await detailRoute.GET(
      detailRequest(expenseOtherHousehold),
      { params: Promise.resolve({ id: expenseOtherHousehold }) },
    );
    assert.equal(crossHouseholdDetail.status, 404);
    assert.deepEqual(await readJson(crossHouseholdDetail), {
      error: { code: "NOT_FOUND", message: "Recurso no encontrado." },
    });
    console.log("PASS detail isolates expenses from another household");

    for (const [expenseId, expectedMessage] of [
      ["invalid", "Solicitud inválida."],
      [missingHousehold, "Recurso no encontrado."],
      ["41000000-0000-4000-8000-000000000099", "Recurso no encontrado."],
    ]) {
      const response = await detailRoute.GET(detailRequest(expenseId), {
        params: Promise.resolve({ id: expenseId }),
      });
      assert.equal(response.status, expenseId === "invalid" ? 422 : 404);
      const body = await readJson(response);
      assert.equal(body.error.message, expectedMessage);
    }
    console.log("PASS detail not-found, invalid-id and isolation errors");

    failedTable = "tb_expenses";
    const failedDetail = await detailRoute.GET(detailRequest(expenseNewer), {
      params: Promise.resolve({ id: expenseNewer }),
    });
    assert.equal(failedDetail.status, 500);
    assert.deepEqual(await readJson(failedDetail), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    failedTable = undefined;
    console.log("PASS detail persistence failures are sanitized");

    const unexpectedDetailError = new Error("private detail error", {
      cause: new Error("private detail cause"),
    });
    const unexpectedDetailRoute = createTypeScriptLoader(
      new Map([
        [
          serviceModule,
          {
            getExpense: async () => {
              throw unexpectedDetailError;
            },
          },
        ],
      ]),
    )(detailRouteModule);
    const unexpectedDetail = await unexpectedDetailRoute.GET(
      detailRequest(expenseNewer),
      { params: Promise.resolve({ id: expenseNewer }) },
    );
    assert.equal(unexpectedDetail.status, 500);
    assert.deepEqual(await readJson(unexpectedDetail), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    });
    console.log("PASS detail unexpected errors do not expose internals");

    const detailSource = fs.readFileSync(detailRouteModule, "utf8");
    assert.ok(!detailSource.includes("expense.repository"));
    assert.ok(!detailSource.includes("database/client"));
    assert.ok(!detailSource.includes("supabase"));
    assert.ok(!detailSource.includes(".from("));
    assert.ok(!detailSource.includes(".rpc("));
    assert.ok(!detailSource.includes("insert("));
    assert.ok(!detailSource.includes("update("));
    assert.ok(!detailSource.includes("delete("));
    console.log("PASS detail Route delegates without direct persistence");

    process.env.HOUSEMATE_MVP_MEMBER_ID = memberA;
    const updateBody = {
      merchant: "Updated Market",
      description: "Updated expense",
      paidByMemberId: memberA,
      categoryId: categoryA,
    };
    observedOperations.length = 0;
    const updated = await detailRoute.PATCH(detailRequest(expenseNewer), {
      params: Promise.resolve({ id: expenseNewer }),
    });
    assert.equal(updated.status, 422);
    const updatedWithBody = await detailRoute.PATCH(
      new Request("http://localhost/api/expenses/" + expenseNewer, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(updateBody),
      }),
      { params: Promise.resolve({ id: expenseNewer }) },
    );
    assert.equal(updatedWithBody.status, 200);
    const updatedBody = await readJson(updatedWithBody);
    assert.equal(updatedBody.data.merchant, "Updated Market");
    assert.equal(updatedBody.data.description, "Updated expense");
    assert.equal(updatedBody.data.id, expenseNewer);
    assert.equal(
      observedOperations.filter(
        ({ type, name }) => type === "rpc" && name === "fn_update_expense",
      ).length,
      1,
    );
    const invalidUpdatedCategory = await detailRoute.PATCH(
      new Request("http://localhost/api/expenses/" + expenseNewer, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categoryId: incomeCategory }),
      }),
      { params: Promise.resolve({ id: expenseNewer }) },
    );
    assert.equal(invalidUpdatedCategory.status, 404);
    assert.equal(
      (await readJson(invalidUpdatedCategory)).error.code,
      "NOT_FOUND",
    );
    console.log("PASS PATCH updates Expense and returns the public DTO");

    const patchRequest = (body, query = "", expenseId = expenseNewer) =>
      new Request(`http://localhost/api/expenses/${expenseId}${query}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await detailRoute.PATCH(
          patchRequest(updateBody, `?householdId=${householdB}`),
          {
            params: Promise.resolve({ id: expenseNewer }),
          },
        )
      ).status,
      400,
    );
    for (const field of ["householdId", "createdBy", "source", "status"]) {
      assert.equal(
        (
          await detailRoute.PATCH(
            patchRequest({ ...updateBody, [field]: householdB }),
            { params: Promise.resolve({ id: expenseNewer }) },
          )
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await detailRoute.PATCH(patchRequest(updateBody, "", "invalid"), {
          params: Promise.resolve({ id: "invalid" }),
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await detailRoute.PATCH(
          patchRequest(updateBody, "", missingHousehold),
          {
            params: Promise.resolve({ id: missingHousehold }),
          },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await detailRoute.PATCH(
          patchRequest(updateBody, "", expenseOtherHousehold),
          {
            params: Promise.resolve({ id: expenseOtherHousehold }),
          },
        )
      ).status,
      404,
    );
    const patchSource = fs.readFileSync(detailRouteModule, "utf8");
    assert.ok(!patchSource.includes("database/client"));
    assert.ok(!patchSource.includes("expense.repository"));
    assert.ok(!patchSource.includes(".from("));
    console.log(
      "PASS PATCH validates isolation, protected fields and route boundaries",
    );

    const deleteRequest = (expenseId, query = "") =>
      new Request(`http://localhost/api/expenses/${expenseId}${query}`, {
        method: "DELETE",
      });

    observedOperations.length = 0;
    const pendingDelete = await detailRoute.DELETE(
      deleteRequest(expensePending),
      { params: Promise.resolve({ id: expensePending }) },
    );
    assert.equal(pendingDelete.status, 204);
    assert.equal(await pendingDelete.text(), "");
    assert.equal(
      expenses.some(({ id }) => id === expensePending),
      false,
    );
    assert.deepEqual(
      observedOperations.filter(({ type, name }) => type === "rpc"),
      [
        {
          type: "rpc",
          name: "fn_delete_expense",
          args: {
            p_household_id: householdA,
            p_expense_id: expensePending,
          },
        },
      ],
    );
    console.log("PASS DELETE removes a PENDING Expense physically");

    observedOperations.length = 0;
    const confirmedDelete = await detailRoute.DELETE(
      deleteRequest(expenseNewer),
      { params: Promise.resolve({ id: expenseNewer }) },
    );
    assert.equal(confirmedDelete.status, 204);
    assert.equal(
      expenses.find(({ id }) => id === expenseNewer).status,
      "CANCELLED",
    );
    assert.equal(
      observedOperations.filter(
        ({ type, name }) => type === "rpc" && name === "fn_delete_expense",
      ).length,
      1,
    );

    const cancelledDelete = await detailRoute.DELETE(
      deleteRequest(expenseCancelled),
      { params: Promise.resolve({ id: expenseCancelled }) },
    );
    assert.equal(cancelledDelete.status, 204);
    assert.equal(
      expenses.find(({ id }) => id === expenseCancelled).status,
      "CANCELLED",
    );
    console.log(
      "PASS DELETE cancels CONFIRMED and is idempotent for CANCELLED",
    );

    for (const [expenseId, expectedStatus] of [
      ["invalid", 422],
      [missingHousehold, 404],
      [expenseOtherHousehold, 404],
    ]) {
      const response = await detailRoute.DELETE(deleteRequest(expenseId), {
        params: Promise.resolve({ id: expenseId }),
      });
      assert.equal(response.status, expectedStatus);
      const body = await readJson(response);
      assert.equal(
        body.error.code,
        expectedStatus === 422 ? "VALIDATION_ERROR" : "NOT_FOUND",
      );
    }
    for (const query of [`?householdId=${householdB}`, "?unknown=value"]) {
      observedOperations.length = 0;
      const response = await detailRoute.DELETE(
        deleteRequest(expenseOlder, query),
        { params: Promise.resolve({ id: expenseOlder }) },
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await readJson(response), {
        error: {
          code: "VALIDATION_ERROR",
          message: "Solicitud inv\u00e1lida.",
        },
      });
      assert.deepEqual(observedOperations, []);
    }
    console.log(
      "PASS DELETE enforces UUID, household isolation and query allowlist",
    );

    delete process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
    observedOperations.length = 0;
    const unavailableDelete = await detailRoute.DELETE(
      deleteRequest(expenseOlder),
      { params: Promise.resolve({ id: expenseOlder }) },
    );
    assert.equal(unavailableDelete.status, 500);
    assert.deepEqual(await readJson(unavailableDelete), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operaci\u00f3n.",
      },
    });
    assert.deepEqual(observedOperations, []);
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;

    rpcError = { code: "42501", message: "private persistence detail" };
    const persistenceDelete = await detailRoute.DELETE(
      deleteRequest(expenseOlder),
      { params: Promise.resolve({ id: expenseOlder }) },
    );
    assert.equal(persistenceDelete.status, 500);
    assert.deepEqual(await readJson(persistenceDelete), {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operaci\u00f3n.",
      },
    });
    rpcError = undefined;
    const deleteSource = fs.readFileSync(detailRouteModule, "utf8");
    assert.ok(!deleteSource.includes("expense.repository"));
    assert.ok(!deleteSource.includes("database/client"));
    assert.ok(!deleteSource.includes(".from("));
    assert.ok(!deleteSource.includes(".rpc("));
    console.log("PASS DELETE sanitizes context and persistence failures");

    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdA;
    process.env.HOUSEMATE_MVP_MEMBER_ID = memberA;
    const createBody = {
      merchant: "Market",
      description: "Created expense",
      totalAmount: 100.5,
      expenseDate: "2026-08-12",
      paidByMemberId: memberA,
      categoryId: categoryA,
      items: [
        {
          name: "Groceries",
          quantity: 2,
          unitPrice: 50.25,
          totalPrice: 100.5,
          categoryId: categoryA,
        },
      ],
      splits: [{ memberId: memberA, percentage: 100 }],
    };
    observedOperations.length = 0;
    const created = await route.POST(postRequest(createBody));
    assert.equal(created.status, 201);
    const createdBody = await readJson(created);
    assert.equal(createdBody.data.createdBy, memberA);
    assert.equal(createdBody.data.status, "CONFIRMED");
    assert.equal(createdBody.data.merchant, "Market");
    assert.equal(createdBody.data.category.id, categoryA);
    assert.deepEqual(createdBody.data.items[0], {
      name: "Groceries",
      quantity: 2,
      unitPrice: 50.25,
      totalPrice: 100.5,
      category: { id: categoryA, name: "Food" },
    });
    assert.deepEqual(createdBody.data.splits, [
      { memberId: memberA, percentage: 100, amount: 100.5 },
    ]);
    assert.ok(hasOperation({ type: "rpc", name: "fn_create_expense" }));
    assert.equal(
      observedOperations.filter(
        ({ type, name }) => type === "rpc" && name === "fn_create_expense",
      ).length,
      1,
    );
    assert.ok(
      observedOperations.every(
        ({ type }) =>
          type !== "insert" && type !== "update" && type !== "delete",
      ),
    );
    const createRpc = observedOperations.find(
      ({ type, name }) => type === "rpc" && name === "fn_create_expense",
    );
    assert.equal(createRpc.args.p_household_id, householdA);
    assert.equal(createRpc.args.p_created_by, memberA);
    assert.equal(createRpc.args.p_source, "WEB");
    console.log(
      "PASS POST creates an Expense through the controlled context and RPC",
    );

    const externalContextBody = { ...createBody, householdId: householdB };
    assert.equal(
      (await route.POST(postRequest(externalContextBody))).status,
      400,
    );
    assert.equal(
      (await route.POST(postRequest(createBody, `?householdId=${householdB}`)))
        .status,
      400,
    );
    console.log("PASS POST rejects external household identity");

    const invalidJson = await route.POST(
      new Request("http://localhost/api/expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid",
      }),
    );
    assert.equal(invalidJson.status, 422);
    assert.equal((await readJson(invalidJson)).error.code, "VALIDATION_ERROR");
    assert.equal(
      (await route.POST(postRequest({ ...createBody, unknown: true }))).status,
      400,
    );
    assert.equal(
      (await route.POST(postRequest({ ...createBody, totalAmount: -1 })))
        .status,
      422,
    );
    assert.equal(
      (
        await route.POST(
          postRequest({ ...createBody, categoryId: missingMember }),
        )
      ).status,
      404,
    );
    for (const categoryId of [
      incomeCategory,
      expenseMacroCategory,
      inactiveExpenseCategory,
      legacyCategory,
      missingCategory,
      invalidHierarchyExpenseCategory,
    ]) {
      const response = await route.POST(
        postRequest({ ...createBody, categoryId }),
      );
      assert.equal(response.status, 404);
      assert.equal((await readJson(response)).error.code, "NOT_FOUND");
    }

    const invalidItemCategory = await route.POST(
      postRequest({
        ...createBody,
        items: [{ ...createBody.items[0], categoryId: incomeCategory }],
      }),
    );
    assert.equal(invalidItemCategory.status, 404);
    assert.equal((await readJson(invalidItemCategory)).error.code, "NOT_FOUND");

    const uncategorizedExpense = await route.POST(
      postRequest({ ...createBody, categoryId: null }),
    );
    assert.equal(uncategorizedExpense.status, 201);
    console.log(
      "PASS POST validates JSON, fields, amounts and movement categories",
    );

    delete process.env.HOUSEMATE_MVP_MEMBER_ID;
    assert.equal((await route.POST(postRequest(createBody))).status, 500);
    if (previousMemberId === undefined) {
      delete process.env.HOUSEMATE_MVP_MEMBER_ID;
    } else {
      process.env.HOUSEMATE_MVP_MEMBER_ID = previousMemberId;
    }
    console.log("PASS POST sanitizes unavailable actor context");

    process.env.HOUSEMATE_MVP_MEMBER_ID = memberA;

    rpcError = { code: "42501", message: "private persistence detail" };
    const persistenceResponse = await route.POST(postRequest(createBody));
    assert.equal(persistenceResponse.status, 500);
    assert.equal(
      (await readJson(persistenceResponse)).error.code,
      "INTERNAL_ERROR",
    );
    rpcError = undefined;
    console.log("PASS POST sanitizes persistence errors");

    forceHydrationFailure = true;
    const notHydrated = await route.POST(postRequest(createBody));
    assert.equal(notHydrated.status, 202);
    const notHydratedBody = await readJson(notHydrated);
    assert.equal(notHydratedBody.error.code, "CREATED_NOT_HYDRATED");
    assert.match(notHydratedBody.error.expenseId, /^[0-9a-f-]{36}$/i);
    assert.ok(!JSON.stringify(notHydratedBody).includes("private"));
    forceHydrationFailure = false;
    console.log("PASS POST exposes created-but-not-hydrated state safely");
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
