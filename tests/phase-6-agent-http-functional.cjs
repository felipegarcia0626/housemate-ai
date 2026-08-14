const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const routeModule = path.join(root, "app", "api", "agent", "route.ts");
const contextModule = path.join(root, "app", "api", "_lib", "http-context.ts");
const conversationModule = path.join(
  root,
  "modules",
  "agent",
  "conversation.service.ts",
);
const context = {
  householdId: "57000000-0000-4000-8000-000000000001",
  actorMemberId: "57000000-0000-4000-8000-000000000011",
  conversationKey: "web-agent-test",
  source: "WEB",
};
const calls = [];
let conversationResult = {
  type: "READ_RESULT",
  operation: "GET_EXPENSES",
  data: [],
};
let conversationError = null;

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
    path.resolve(contextModule),
    {
      getConfiguredHttpActorContext: async () => ({
        householdId: context.householdId,
        memberId: context.actorMemberId,
      }),
      getConfiguredHttpConversationKey: () => context.conversationKey,
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
    context,
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
