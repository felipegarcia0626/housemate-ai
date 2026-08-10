const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const serviceModule = path.join(
  root,
  "modules",
  "categories",
  "category.service.ts",
);
const routeModule = path.join(root, "app", "api", "categories", "route.ts");

const categories = [
  {
    id: "39000000-0000-4000-8000-000000000001",
    name: "Food",
    description: "must not be exposed",
    created_at: "2026-08-10T00:00:00Z",
  },
  {
    id: "39000000-0000-4000-8000-000000000002",
    name: "Home",
    description: "must not be exposed",
    created_at: "2026-08-10T00:00:00Z",
  },
];

let failCategoryRead = false;
const observedOperations = [];

class FakeCategoryQuery {
  constructor(table) {
    this.table = table;
  }

  select(columns) {
    this.columns = columns;
    observedOperations.push({ type: "select", table: this.table, columns });
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

  eq() {
    observedOperations.push({ type: "filter", table: this.table });
    throw new Error("Unexpected filter");
  }

  then(resolve, reject) {
    const result = failCategoryRead
      ? {
          data: null,
          error: {
            message: "sensitive Supabase/PostgreSQL detail",
            code: "42501",
          },
        }
      : { data: categories, error: null };

    return Promise.resolve(result).then(resolve, reject);
  }
}

const fakeClient = {
  from(table) {
    observedOperations.push({ type: "from", table });
    return new FakeCategoryQuery(table);
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

    if (overrides.has(resolved)) {
      return overrides.get(resolved);
    }
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

async function readJson(response) {
  assert.equal(response.headers.get("content-type"), "application/json");
  return response.json();
}

async function main() {
  const loadTypeScriptModule = createTypeScriptLoader();
  const route = loadTypeScriptModule(routeModule);

  assert.deepEqual(Object.keys(route).sort(), ["GET"]);

  observedOperations.length = 0;
  const successResponse = await route.GET();
  assert.equal(successResponse.status, 200);
  assert.deepEqual(await readJson(successResponse), {
    data: [
      { id: categories[0].id, name: "Food" },
      { id: categories[1].id, name: "Home" },
    ],
  });
  assert.deepEqual(observedOperations, [
    { type: "from", table: "tb_categories" },
    { type: "select", table: "tb_categories", columns: "id,name" },
  ]);
  console.log("PASS GET /api/categories returns the exact public contract");
  console.log(
    "PASS Category API performs one read without filters, RPC or writes",
  );

  categories.splice(0, categories.length);
  observedOperations.length = 0;
  const emptyResponse = await route.GET();
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual(await readJson(emptyResponse), { data: [] });
  assert.equal(
    observedOperations.filter(({ type }) => type === "from").length,
    1,
  );
  console.log("PASS GET /api/categories returns an empty data array");

  failCategoryRead = true;
  const persistenceResponse = await route.GET();
  assert.equal(persistenceResponse.status, 500);
  const persistenceBody = await readJson(persistenceResponse);
  assert.deepEqual(persistenceBody, {
    error: {
      code: "INTERNAL_ERROR",
      message: "No fue posible completar la operación.",
    },
  });
  assert.ok(!JSON.stringify(persistenceBody).includes("sensitive"));
  assert.ok(!JSON.stringify(persistenceBody).includes("42501"));
  console.log("PASS persistence failures are mapped to sanitized HTTP errors");

  const unexpectedError = new Error("unexpected secret infrastructure error", {
    cause: new Error("private cause"),
  });
  unexpectedError.stack = "private stack";
  const unexpectedLoader = createTypeScriptLoader(
    new Map([
      [
        serviceModule,
        {
          listCategories: async () => {
            throw unexpectedError;
          },
        },
      ],
    ]),
  );
  const unexpectedRoute = unexpectedLoader(routeModule);
  const unexpectedResponse = await unexpectedRoute.GET();
  assert.equal(unexpectedResponse.status, 500);
  const unexpectedBody = await readJson(unexpectedResponse);
  assert.deepEqual(unexpectedBody, {
    error: {
      code: "INTERNAL_ERROR",
      message: "No fue posible completar la operación.",
    },
  });
  const serializedUnexpectedBody = JSON.stringify(unexpectedBody);
  assert.ok(!serializedUnexpectedBody.includes(unexpectedError.message));
  assert.ok(!serializedUnexpectedBody.includes("private cause"));
  assert.ok(!serializedUnexpectedBody.includes("private stack"));
  console.log("PASS unexpected failures do not expose internal details");
  console.log("PASS Category Route exports only GET");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
