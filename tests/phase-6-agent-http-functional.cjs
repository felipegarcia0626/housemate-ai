const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const routeModule = path.join(root, "app", "api", "agent", "route.ts");
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
const conversationModule = path.join(
  root,
  "modules",
  "agent",
  "conversation.service.ts",
);
const context = {
  householdId: "57000000-0000-4000-8000-000000000001",
  actorMemberId: "57000000-0000-4000-8000-000000000011",
  conversationKey: "web:57000000-0000-4000-8000-000000000001:57000000-0000-4000-8000-000000000011",
  source: "WEB",
};
const calls = [];
let conversationResult = {
  type: "READ_RESULT",
  operation: "GET_EXPENSES",
  data: [],
};
let conversationError = null;
let authError = null;
let authenticated = {
  authUserId: "67000000-0000-4000-8000-000000000001",
  userId: "67000000-0000-4000-8000-000000000002",
  householdId: context.householdId,
  memberId: context.actorMemberId,
  source: "web",
};

function loader(overrides = new Map()) {
  const cache = new Map();
  function load(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const loadedModule = { exports: {} };
    cache.set(resolved, loadedModule);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: resolved,
    }).outputText;
    const localRequire = (specifier) => {
      if (specifier.startsWith("@/"))
        return load(path.join(root, specifier.slice(2) + ".ts"));
      if (specifier.startsWith("."))
        return load(path.resolve(path.dirname(resolved), specifier + ".ts"));
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

const overrides = new Map([
  [
    path.resolve(authTypesModule),
    {
      AuthenticatedContextError: class AuthenticatedContextError extends Error {
        constructor(code) {
          super(code);
          this.code = code;
        }
      },
    },
  ],
  [
    path.resolve(authServiceModule),
    {
      resolveAuthenticatedContext: async () => {
        if (authError) throw authError;
        return authenticated;
      },
    },
  ],
  [
    path.resolve(conversationModule),
    {
      processAgentMessage: async (receivedContext, input) => {
        calls.push({ context: receivedContext, input });
        if (conversationError) throw conversationError;
        return conversationResult;
      },
    },
  ],
]);

function jsonRequest(body) {
  return new Request("http://localhost/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function json(response) {
  assert.equal(response.headers.get("content-type"), "application/json");
  return response.json();
}

async function main() {
  const source = fs.readFileSync(routeModule, "utf8");
  for (const forbidden of [
    "getSupabaseAdminClient",
    "database/client",
    "repository",
    "receipt-ocr",
    "openai",
    "pending-proposal",
    ".from(",
    ".rpc(",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      "Route contains " + forbidden,
    );
  }

  const route = loader(overrides)(routeModule);
  assert.deepEqual(Object.keys(route), ["POST"]);

  calls.length = 0;
  const valid = await route.POST(
    jsonRequest(JSON.stringify({ message: "¿Cuánto gastamos?" })),
  );
  assert.equal(valid.status, 200);
  assert.deepEqual(await json(valid), { data: conversationResult });
  assert.deepEqual(calls[0], {
    context: {
      householdId: context.householdId,
      actorMemberId: context.actorMemberId,
      conversationKey: context.conversationKey,
      source: "WEB",
    },
    input: { message: "¿Cuánto gastamos?" },
  });
  console.log(
    "PASS valid request delegates to Conversation Service with controlled context",
  );

  for (const request of [
    jsonRequest("{"),
    jsonRequest(""),
    jsonRequest(JSON.stringify({})),
    jsonRequest(JSON.stringify({ message: "" })),
    jsonRequest(JSON.stringify({ message: 123 })),
  ]) {
    const invalid = await route.POST(request);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await json(invalid), {
      error: { code: "VALIDATION_ERROR", message: "Solicitud inválida." },
    });
  }
  console.log("PASS invalid JSON and message inputs return sanitized 400");

  calls.length = 0;
  conversationResult = {
    type: "PROPOSAL_CREATED",
    proposalId: "proposal-1",
    status: "AWAITING_CONFIRMATION",
  };
  const proposal = await route.POST(
    jsonRequest(
      JSON.stringify({
        message: "Registra 50000 de supermercado",
        householdId: "attacker-household",
        actorMemberId: "attacker-member",
        source: "ATTACKER",
        conversationKey: "attacker-conversation",
      }),
    ),
  );
  assert.equal(proposal.status, 200);
  assert.deepEqual((await json(proposal)).data, conversationResult);
  assert.deepEqual(calls[0].context, context);
  assert.deepEqual(calls[0].input, {
    message: "Registra 50000 de supermercado",
  });
  console.log("PASS client context fields are ignored");

  const repeated = await route.POST(
    jsonRequest(JSON.stringify({ message: "Otra consulta" })),
  );
  assert.equal(repeated.status, 200);
  assert.equal(calls.at(-1).context.conversationKey, context.conversationKey);
  console.log("PASS same authenticated member and household reuse the Web conversation key");

  authenticated = {
    ...authenticated,
    memberId: "57000000-0000-4000-8000-000000000012",
  };
  await route.POST(jsonRequest(JSON.stringify({ message: "Otro miembro" })));
  assert.notEqual(calls.at(-1).context.conversationKey, context.conversationKey);
  assert.equal(
    calls.at(-1).context.conversationKey,
    `web:${context.householdId}:57000000-0000-4000-8000-000000000012`,
  );
  authenticated = { ...authenticated, householdId: "57000000-0000-4000-8000-000000000099" };
  await route.POST(jsonRequest(JSON.stringify({ message: "Otro hogar" })));
  assert.equal(
    calls.at(-1).context.conversationKey,
    "web:57000000-0000-4000-8000-000000000099:57000000-0000-4000-8000-000000000012",
  );
  console.log("PASS Web conversation keys isolate members and households");

  authenticated = {
    ...authenticated,
    householdId: context.householdId,
    memberId: context.actorMemberId,
  };
  for (const [code, status] of [
    ["UNAUTHENTICATED", 401],
    ["AUTH_PROVIDER_ERROR", 500],
    ["APPLICATION_USER_NOT_FOUND", 403],
    ["NO_ACTIVE_MEMBERSHIP", 403],
    ["HOUSEHOLD_SELECTION_REQUIRED", 409],
    ["PERSISTENCE_ERROR", 500],
  ]) {
    calls.length = 0;
    authError = new (overrides.get(path.resolve(authTypesModule)).AuthenticatedContextError)(code);
    const response = await route.POST(
      jsonRequest(JSON.stringify({ message: "No debe procesarse" })),
    );
    assert.equal(response.status, status);
    assert.equal(calls.length, 0);
  }
  authError = null;
  console.log("PASS authenticated context errors are mapped and stop Agent processing");

  conversationResult = {
    type: "CONFIRMED",
    proposalId: "proposal-1",
    status: "CONFIRMED",
    expenseId: "expense-1",
  };
  const confirmation = await route.POST(
    jsonRequest(JSON.stringify({ message: "Sí, confirmar" })),
  );
  assert.equal(confirmation.status, 200);
  assert.equal((await json(confirmation)).data.type, "CONFIRMED");
  assert.deepEqual(calls.at(-1).input, { message: "Sí, confirmar" });
  console.log(
    "PASS textual confirmation is delegated without direct proposal access",
  );

  conversationError = new Error("internal OpenAI or SQL detail");
  const failed = await route.POST(
    jsonRequest(JSON.stringify({ message: "test" })),
  );
  assert.equal(failed.status, 500);
  assert.deepEqual(await json(failed), {
    error: {
      code: "INTERNAL_ERROR",
      message: "No fue posible completar la operación.",
    },
  });
  console.log("PASS Agent errors are sanitized");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
