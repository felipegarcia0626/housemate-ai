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

const expenseMacro = "43000000-0000-4000-8000-000000000001";
const expenseOtherMacro = "43000000-0000-4000-8000-000000000002";
const expenseMicro = "43000000-0000-4000-8000-000000000011";
const expenseDuplicateName = "43000000-0000-4000-8000-000000000012";
const inactiveExpense = "43000000-0000-4000-8000-000000000013";
const invalidExpense = "43000000-0000-4000-8000-000000000014";
const incomeMacro = "43000000-0000-4000-8000-000000000021";
const incomeMicro = "43000000-0000-4000-8000-000000000022";
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
  { id: legacyCategory, name: "Legacy" },
];

let failCategoryRead = false;
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

  order(column, options) {
    this.orders.push({ column, ascending: options.ascending });
    return this;
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

    const rows = categories.filter((row) =>
      this.filters.every(({ operator, column, value, values }) => {
        if (operator === "eq") return row[column] === value;
        if (operator === "in") return values.includes(row[column]);
        return false;
      }),
    );
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
  const { listHierarchicalCategories } = loadTypeScriptModule(serviceModule);

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
  console.log("PASS hierarchical INCOME query isolates movement type");

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
