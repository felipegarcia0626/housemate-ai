const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(
  root,
  "infrastructure",
  "database",
  "client.ts",
);
const serviceModule = path.join(
  root,
  "modules",
  "categories",
  "category.service.ts",
);
const routeModule = path.join(
  root,
  "app",
  "api",
  "categories",
  "hierarchical",
  "route.ts",
);
const repositoryModule = path.join(
  root,
  "modules",
  "categories",
  "category.repository.ts",
);

const expenseMacro = "43000000-0000-4000-8000-000000000001";
const expenseOtherMacro = "43000000-0000-4000-8000-000000000002";
const expenseMicro = "43000000-0000-4000-8000-000000000011";
const expenseDuplicateName = "43000000-0000-4000-8000-000000000012";
const inactiveExpense = "43000000-0000-4000-8000-000000000013";
const invalidExpense = "43000000-0000-4000-8000-000000000014";
const inactiveMacro = "43000000-0000-4000-8000-000000000015";
const inactiveMacroChild = "43000000-0000-4000-8000-000000000016";
const incomeMacro = "43000000-0000-4000-8000-000000000021";
const incomeMicro = "43000000-0000-4000-8000-000000000022";
const inactiveIncomeMacro = "43000000-0000-4000-8000-000000000023";
const inactiveIncomeMacroChild = "43000000-0000-4000-8000-000000000024";
const legacyCategory = "43000000-0000-4000-8000-000000000031";

const categories = [
  {
    id: expenseOtherMacro,
    name: "Compras",
    movement_type: "EXPENSE",
    level: "MACRO",
    parent_id: null,
    is_active: true,
  },
  {
    id: expenseDuplicateName,
    name: "Supermercado",
    movement_type: "EXPENSE",
    level: "MICRO",
    parent_id: expenseOtherMacro,
    is_active: true,
  },
  {
    id: expenseMacro,
    name: "Alimentación",
    movement_type: "EXPENSE",
    level: "MACRO",
    parent_id: null,
    is_active: true,
  },
  {
    id: expenseMicro,
    name: "Supermercado",
    movement_type: "EXPENSE",
    level: "MICRO",
    parent_id: expenseMacro,
    is_active: true,
  },
  {
    id: inactiveExpense,
    name: "Inactiva",
    movement_type: "EXPENSE",
    level: "MICRO",
    parent_id: expenseMacro,
    is_active: false,
  },
  {
    id: invalidExpense,
    name: "Jerarquía inválida",
    movement_type: "EXPENSE",
    level: "MICRO",
    parent_id: "43000000-0000-4000-8000-000000000099",
    is_active: true,
  },
  {
    id: inactiveMacro,
    name: "Inactiva",
    movement_type: "EXPENSE",
    level: "MACRO",
    parent_id: null,
    is_active: false,
  },
  {
    id: inactiveMacroChild,
    name: "Hija de macro inactiva",
    movement_type: "EXPENSE",
    level: "MICRO",
    parent_id: inactiveMacro,
    is_active: true,
  },
  {
    id: incomeMacro,
    name: "Ingresos",
    movement_type: "INCOME",
    level: "MACRO",
    parent_id: null,
    is_active: true,
  },
  {
    id: incomeMicro,
    name: "Salario",
    movement_type: "INCOME",
    level: "MICRO",
    parent_id: incomeMacro,
    is_active: true,
  },
  {
    id: inactiveIncomeMacro,
    name: "Ingreso inactivo",
    movement_type: "INCOME",
    level: "MACRO",
    parent_id: null,
    is_active: false,
  },
  {
    id: inactiveIncomeMacroChild,
    name: "Hija de ingreso inactivo",
    movement_type: "INCOME",
    level: "MICRO",
    parent_id: inactiveIncomeMacro,
    is_active: true,
  },
  { id: legacyCategory, name: "Legacy" },
];

let failCategoryRead = false;
let categoryInsertConflictOnce = false;
const observedQueries = [];

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.orders = [];
  }

  select(columns) {
    this.columns = columns;
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "eq", column, value });
    return this;
  }

  in(column, values) {
    this.filters.push({ operator: "in", column, values });
    return this;
  }

  insert(payload) {
    this.insertPayload = payload;
    return this;
  }

  order(column, options) {
    this.orders.push({ column, ascending: options.ascending });
    return this;
  }

  resolveRows() {
    return categories.filter((row) =>
      this.filters.every(({ operator, column, value, values }) => {
        if (operator === "eq") return row[column] === value;
        if (operator === "in") return values.includes(row[column]);
        return false;
      }),
    );
  }

  maybeSingle() {
    const rows = this.resolveRows();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  single() {
    if (this.insertPayload !== undefined) {
      if (categoryInsertConflictOnce) {
        categoryInsertConflictOnce = false;
        categories.push({
          ...this.insertPayload,
          updated_at: "2026-09-24T00:00:00Z",
        });
        return Promise.resolve({ data: null, error: { code: "23505" } });
      }
      const duplicate = categories.some(
        (row) =>
          row.id === this.insertPayload.id ||
          (row.movement_type === this.insertPayload.movement_type &&
            row.parent_id === this.insertPayload.parent_id &&
            row.name === this.insertPayload.name),
      );
      if (duplicate) {
        return Promise.resolve({ data: null, error: { code: "23505" } });
      }
      const row = {
        ...this.insertPayload,
        updated_at: this.insertPayload.updated_at ?? "2026-09-24T00:00:00Z",
      };
      categories.push(row);
      return Promise.resolve({ data: row, error: null });
    }
    const rows = this.resolveRows();
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then(resolve, reject) {
    observedQueries.push({
      columns: this.columns,
      filters: [...this.filters],
      orders: [...this.orders],
    });
    if (failCategoryRead) {
      return Promise.resolve({ data: null, error: { code: "42501" } }).then(
        resolve,
        reject,
      );
    }

    const rows = this.resolveRows();
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  }
}

const fakeClient = {
  from(table) {
    assert.equal(table, "tb_categories");
    return new FakeQuery(table);
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

function createTypeScriptLoader() {
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

async function main() {
  const loadTypeScriptModule = createTypeScriptLoader();
  const {
    createOrReuseMicroCategory,
    listHierarchicalCategories,
  } = loadTypeScriptModule(serviceModule);
  const { getAvailableCategoryIds } = loadTypeScriptModule(repositoryModule);

  const expenses = await listHierarchicalCategories("EXPENSE");
  assert.deepEqual(
    expenses.map(({ id, path: categoryPath }) => ({ id, path: categoryPath })),
    [
      { id: expenseMicro, path: "Alimentación → Supermercado" },
      { id: expenseDuplicateName, path: "Compras → Supermercado" },
    ],
  );
  assert.ok(
    expenses.every(
      ({ movementType, level, isActive }) =>
        movementType === "EXPENSE" && level === "MICRO" && isActive === true,
    ),
  );
  assert.ok(
    expenses.every(
      ({ macroId, macroName, parentId }) =>
        macroId === parentId && macroName.length > 0,
    ),
  );
  assert.ok(
    !expenses.some(({ id }) =>
      [
        expenseMacro,
        expenseOtherMacro,
        inactiveExpense,
        inactiveMacroChild,
        invalidExpense,
        incomeMicro,
        legacyCategory,
      ].includes(id),
    ),
  );
  assert.ok(
    observedQueries.some(({ filters }) =>
      filters.some(
        ({ operator, column, value }) =>
          operator === "eq" &&
          column === "movement_type" &&
          value === "EXPENSE",
      ),
    ),
  );
  const availableExpenseIds = await getAvailableCategoryIds(
    [expenseMicro, inactiveMacroChild, inactiveExpense],
    "EXPENSE",
  );
  assert.deepEqual([...availableExpenseIds].sort(), [expenseMicro].sort());
  console.log("PASS hierarchical EXPENSE query filters and resolves paths");

  const incomes = await listHierarchicalCategories("INCOME");
  assert.deepEqual(incomes, [
    {
      id: incomeMicro,
      name: "Salario",
      movementType: "INCOME",
      level: "MICRO",
      parentId: incomeMacro,
      isActive: true,
      macroId: incomeMacro,
      macroName: "Ingresos",
      path: "Ingresos → Salario",
    },
  ]);
  assert.ok(
    !incomes.some(({ id }) => id === expenseMicro || id === legacyCategory),
  );
  const availableIncomeIds = await getAvailableCategoryIds(
    [incomeMicro, inactiveIncomeMacroChild],
    "INCOME",
  );
  assert.deepEqual([...availableIncomeIds].sort(), [incomeMicro].sort());
  console.log("PASS hierarchical INCOME query isolates movement type");

  const createdExpense = await createOrReuseMicroCategory({
    name: " Veterinária ",
    movementType: "EXPENSE",
    parentMacroId: expenseMacro,
  });
  assert.equal(createdExpense.name, "Veterinária");
  assert.equal(createdExpense.movementType, "EXPENSE");
  assert.equal(createdExpense.level, "MICRO");
  assert.equal(createdExpense.parentId, expenseMacro);
  assert.equal(createdExpense.macroId, expenseMacro);
  assert.equal(createdExpense.isActive, true);
  const reusedExpense = await createOrReuseMicroCategory({
    name: "VETERINARIA",
    movementType: "EXPENSE",
    parentMacroId: expenseMacro,
  });
  assert.equal(reusedExpense.id, createdExpense.id);
  assert.equal(reusedExpense.name, "Veterinária");
  assert.equal(
    categories.filter(
      (row) => row.parent_id === expenseMacro && row.name === "Veterinária",
    ).length,
    1,
  );
  const createdIncome = await createOrReuseMicroCategory({
    name: "Bono",
    movementType: "INCOME",
    parentMacroId: incomeMacro,
  });
  assert.equal(createdIncome.name, "Bono");
  assert.equal(createdIncome.movementType, "INCOME");
  assert.equal(createdIncome.level, "MICRO");
  assert.equal(createdIncome.parentId, incomeMacro);
  assert.equal(createdIncome.macroId, incomeMacro);
  console.log(
    "PASS category creation preserves EXPENSE/INCOME hierarchy and reuses semantic duplicates",
  );

  await assert.rejects(
    () =>
      createOrReuseMicroCategory({
        name: "   ",
        movementType: "EXPENSE",
        parentMacroId: expenseMacro,
      }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    () =>
      createOrReuseMicroCategory({
        name: "Nested",
        movementType: "EXPENSE",
        parentMacroId: expenseMicro,
      }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    () =>
      createOrReuseMicroCategory({
        name: "Inactive parent child",
        movementType: "EXPENSE",
        parentMacroId: inactiveMacro,
      }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    () =>
      createOrReuseMicroCategory({
        name: "Wrong movement",
        movementType: "EXPENSE",
        parentMacroId: incomeMacro,
      }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    () =>
      createOrReuseMicroCategory({
        name: "Inactiva",
        movementType: "EXPENSE",
        parentMacroId: expenseMacro,
      }),
    (error) => error?.code === "CATEGORY_INACTIVE",
  );
  console.log(
    "PASS category creation rejects invalid parents, empty names and inactive conflicts",
  );

  categoryInsertConflictOnce = true;
  const concurrentExpense = await createOrReuseMicroCategory({
    name: "Terapia",
    movementType: "EXPENSE",
    parentMacroId: expenseMacro,
  });
  assert.equal(concurrentExpense.name, "Terapia");
  assert.equal(
    categories.filter(
      (row) =>
        row.parent_id === expenseMacro &&
        row.movement_type === "EXPENSE" &&
        row.name === "Terapia",
    ).length,
    1,
  );
  console.log("PASS category creation recovers from an insert race");

  const route = loadTypeScriptModule(routeModule);
  observedQueries.length = 0;
  const routeResponse = await route.GET(
    new Request(
      "http://localhost/api/categories/hierarchical?movementType=EXPENSE",
    ),
  );
  assert.equal(routeResponse.status, 200);
  const currentExpenses = await listHierarchicalCategories("EXPENSE");
  assert.deepEqual(await routeResponse.json(), { data: currentExpenses });
  assert.ok(
    observedQueries.every(({ filters }) =>
      filters.every(
        ({ operator, column, value }) =>
          !(operator === "eq" && column === "movement_type") ||
          value === "EXPENSE",
      ),
    ),
  );
  console.log("PASS hierarchical category API returns EXPENSE micros");

  observedQueries.length = 0;
  const incomeRouteResponse = await route.GET(
    new Request(
      "http://localhost/api/categories/hierarchical?movementType=INCOME",
    ),
  );
  assert.equal(incomeRouteResponse.status, 200);
  const currentIncomes = await listHierarchicalCategories("INCOME");
  assert.deepEqual(await incomeRouteResponse.json(), { data: currentIncomes });
  assert.ok(
    observedQueries.every(({ filters }) =>
      filters.every(
        ({ operator, column, value }) =>
          !(operator === "eq" && column === "movement_type") ||
          value === "INCOME",
      ),
    ),
  );
  console.log("PASS hierarchical category API returns INCOME micros");

  const invalidRouteResponse = await route.GET(
    new Request("http://localhost/api/categories/hierarchical"),
  );
  assert.equal(invalidRouteResponse.status, 400);
  const wrongTypeResponse = await route.GET(
    new Request(
      "http://localhost/api/categories/hierarchical?movementType=RECEIPT",
    ),
  );
  assert.equal(wrongTypeResponse.status, 422);
  console.log("PASS hierarchical category API validates movementType");

  failCategoryRead = true;
  await assert.rejects(
    () => listHierarchicalCategories("EXPENSE"),
    (error) =>
      error?.code === "PERSISTENCE_ERROR" &&
      error.message === "Categories could not be loaded.",
  );
  console.log("PASS hierarchical category query sanitizes persistence errors");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
