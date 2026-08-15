const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const routeModule = path.join(
  root,
  "app",
  "api",
  "webhooks",
  "whatsapp",
  "route.ts",
);
const conversationModule = path.join(
  root,
  "modules",
  "agent",
  "conversation.service.ts",
);
const agentServiceModule = path.join(
  root,
  "modules",
  "agent",
  "agent.service.ts",
);

const householdId = "42000000-0000-4000-8000-000000000001";
const memberId = "42000000-0000-4000-8000-000000000011";
const sender = "573001234567";
const unknownSender = "573009999999";
const proposalId = "52000000-0000-4000-8000-000000000001";
const appSecret = "whatsapp-app-secret";

const processedEvents = new Set();
const operations = [];
const agentCalls = [];
const sentMessages = [];
let agentMode = "proposal";
let nextSendFails = false;

class FakeQuery {
  constructor(table) {
    this.table = table;
    this.filters = [];
  }

  select(columns) {
    this.columns = columns;
    operations.push({ type: "select", table: this.table, columns });
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value });
    operations.push({ type: "filter", table: this.table, column, value });
    return this;
  }

  insert(payload) {
    this.insertPayload = payload;
    operations.push({ type: "insert", table: this.table, payload });
    return this;
  }

  maybeSingle() {
    return Promise.resolve(this.resolveSingle());
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  resolveSingle() {
    if (this.table === "tb_users") {
      const identifier = this.filters.find(
        ({ column }) => column === "external_identifier",
      )?.value;
      return {
        data: identifier === sender ? { id: "user-1" } : null,
        error: null,
      };
    }
    if (this.table === "tb_household_members") {
      const household = this.filters.find(
        ({ column }) => column === "household_id",
      )?.value;
      const user = this.filters.find(
        ({ column }) => column === "user_id",
      )?.value;
      return {
        data:
          household === householdId && user === "user-1"
            ? { id: memberId }
            : null,
        error: null,
      };
    }
    throw new Error(`Unexpected maybeSingle table: ${this.table}`);
  }

  execute() {
    if (this.table !== "tb_processed_whatsapp_events") {
      throw new Error(`Unexpected table: ${this.table}`);
    }
    const eventId = this.insertPayload.external_event_id;
    if (processedEvents.has(eventId)) {
      return { data: null, error: { code: "23505" } };
    }
    processedEvents.add(eventId);
    return { data: null, error: null };
  }
}

const fakeClient = {
  from(table) {
    operations.push({ type: "from", table });
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

function createLoader(overrides = new Map()) {
  const cache = new Map();

  function load(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (resolved === clientModule) {
      return { getSupabaseAdminClient: () => fakeClient };
    }
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const loaded = { exports: {} };
    cache.set(resolved, loaded);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: resolved,
    }).outputText;
    const localRequire = (specifier) => {
      const target = resolveTypeScriptModule(specifier, resolved);
      return target ? load(target) : require(specifier);
    };
    new Function("require", "module", "exports", output)(
      localRequire,
      loaded,
      loaded.exports,
    );
    return loaded.exports;
  }

  return load;
}

function incomingPayload(id, text, from = sender) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "phone-1" },
              messages: [
                {
                  id,
                  from,
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function rawBody(payload) {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function signatureFor(body) {
  return `sha256=${createHmac("sha256", appSecret)
    .update(body, "utf8")
    .digest("hex")}`;
}

function signedRequest(body, signature = signatureFor(body)) {
  return new Request("https://example.test/api/webhooks/whatsapp", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signature,
    },
  });
}

function unsignedRequest(body) {
  return new Request("https://example.test/api/webhooks/whatsapp", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  });
}

async function main() {
  process.env.HOUSEMATE_MVP_HOUSEHOLD_ID = householdId;
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token";
  process.env.WHATSAPP_APP_SECRET = appSecret;
  process.env.WHATSAPP_ACCESS_TOKEN = "access-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-1";

  global.fetch = async (url, init) => {
    sentMessages.push({ url, init });
    if (nextSendFails) {
      nextSendFails = false;
      return { ok: false };
    }
    return { ok: true };
  };

  const fakeConversation = {
    async processAgentMessage(context, input) {
      agentCalls.push({ context, input });
      if (agentMode === "error") throw new Error("internal agent details");
      if (agentMode === "confirmed") {
        return {
          type: "CONFIRMED",
          proposalId: input.proposalId,
          status: "CONFIRMED",
          incomeId: "income-1",
          income: {},
        };
      }
      return {
        type: "PROPOSAL_CREATED",
        proposalId,
        status: "AWAITING_CONFIRMATION",
      };
    },
  };
  const fakeAgentService = {
    async findActiveProposalId(context) {
      assert.equal(context.householdId, householdId);
      assert.equal(context.actorMemberId, memberId);
      return proposalId;
    },
  };
  const load = createLoader(
    new Map([
      [conversationModule, fakeConversation],
      [agentServiceModule, fakeAgentService],
    ]),
  );
  const route = load(routeModule);

  const verified = await route.GET(
    new Request(
      "https://example.test/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123",
    ),
  );
  assert.equal(verified.status, 200);
  assert.equal(await verified.text(), "challenge-123");
  console.log("PASS WhatsApp webhook verification succeeds");

  const invalidVerification = await route.GET(
    new Request(
      "https://example.test/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123",
    ),
  );
  assert.equal(invalidVerification.status, 403);
  assert.ok(!(await invalidVerification.text()).includes("verify-token"));
  console.log("PASS invalid webhook verification is sanitized");

  const unsignedBody = rawBody(incomingPayload("event-unsigned", "Pagué 100"));
  const unsigned = await route.POST(unsignedRequest(unsignedBody));
  assert.equal(unsigned.status, 403);
  assert.equal(agentCalls.length, 0);
  assert.equal(sentMessages.length, 0);
  console.log("PASS unsigned webhook event is rejected before Agent");

  const invalidSignatureBody = rawBody(
    incomingPayload("event-invalid-signature", "Pagué 100"),
  );
  const validSignature = signatureFor(invalidSignatureBody);
  const invalidSignatureValue =
    validSignature.slice(0, -1) + (validSignature.endsWith("0") ? "1" : "0");
  const invalidSignature = await route.POST(
    signedRequest(invalidSignatureBody, invalidSignatureValue),
  );
  assert.equal(invalidSignature.status, 403);
  assert.equal(agentCalls.length, 0);
  assert.equal(sentMessages.length, 0);
  console.log("PASS invalid webhook signature is rejected before Agent");

  const malformedSignatureBody = rawBody(
    incomingPayload("event-malformed-signature", "Pagué 100"),
  );
  const malformedSignature = await route.POST(
    signedRequest(malformedSignatureBody, "invalid-signature"),
  );
  assert.equal(malformedSignature.status, 403);
  assert.equal(agentCalls.length, 0);
  assert.equal(sentMessages.length, 0);
  console.log("PASS malformed webhook signature is rejected");

  const originalBody = rawBody(incomingPayload("event-tampered", "Pagué 100"));
  const tamperedBody = originalBody.replace("Pagué 100", "Pagué 900");
  const tampered = await route.POST(
    signedRequest(tamperedBody, signatureFor(originalBody)),
  );
  assert.equal(tampered.status, 403);
  assert.equal(agentCalls.length, 0);
  assert.equal(sentMessages.length, 0);
  console.log("PASS modified webhook body is rejected");

  const firstBody = rawBody(incomingPayload("event-1", "Pagué 100"));
  const first = await route.POST(signedRequest(firstBody));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, status: "PROCESSED" });
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].context.householdId, householdId);
  assert.equal(agentCalls[0].context.actorMemberId, memberId);
  assert.equal(agentCalls[0].context.source, "WHATSAPP");
  assert.equal(
    agentCalls[0].context.conversationKey,
    `whatsapp:phone-1:${sender}`,
  );
  assert.equal(agentCalls[0].input.message, "Pagué 100");
  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].init.body.includes("Propuesta creada"));
  assert.equal(operations.filter(({ type }) => type === "insert").length, 1);
  console.log(
    "PASS text message resolves controlled context and delegates to Agent",
  );

  const duplicate = await route.POST(signedRequest(firstBody));
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { ok: true, status: "DUPLICATE" });
  assert.equal(agentCalls.length, 1);
  assert.equal(sentMessages.length, 1);
  console.log("PASS duplicate event does not invoke Agent or send again");

  agentMode = "confirmed";
  const confirmationBody = rawBody(incomingPayload("event-2", "Sí"));
  const confirmation = await route.POST(signedRequest(confirmationBody));
  assert.equal(confirmation.status, 200);
  assert.equal(agentCalls.at(-1).input.proposalId, proposalId);
  console.log(
    "PASS confirmation resolves PendingProposal.id from controlled conversation",
  );

  const unsupported = await route.POST(
    signedRequest(rawBody({ object: "whatsapp_business_account", entry: [] })),
  );
  assert.deepEqual(await unsupported.json(), { ok: true, ignored: true });
  assert.equal(agentCalls.length, 2);
  console.log("PASS unsupported event is ignored safely");

  const invalidJson = await route.POST(signedRequest("not-json"));
  assert.equal(invalidJson.status, 400);
  console.log("PASS invalid JSON is rejected");

  const unknown = await route.POST(
    signedRequest(
      rawBody(incomingPayload("event-unknown", "Hola", unknownSender)),
    ),
  );
  assert.equal(unknown.status, 500);
  assert.equal(agentCalls.length, 2);
  console.log("PASS unknown sender cannot select a household or actor");

  agentMode = "error";
  const agentError = await route.POST(
    signedRequest(rawBody(incomingPayload("event-agent-error", "Hola"))),
  );
  assert.equal(agentError.status, 500);
  assert.ok(!(await agentError.text()).includes("internal agent details"));
  console.log("PASS Agent errors are sanitized");

  agentMode = "proposal";
  nextSendFails = true;
  const providerError = await route.POST(
    signedRequest(rawBody(incomingPayload("event-provider-error", "Hola"))),
  );
  assert.equal(providerError.status, 500);
  assert.ok(!(await providerError.text()).includes("access-token"));
  console.log("PASS WhatsApp provider errors are sanitized");

  for (const source of [
    fs.readFileSync(routeModule, "utf8"),
    fs.readFileSync(
      path.join(root, "infrastructure", "whatsapp", "whatsapp.adapter.ts"),
      "utf8",
    ),
    fs.readFileSync(
      path.join(root, "modules", "whatsapp", "whatsapp.service.ts"),
      "utf8",
    ),
  ]) {
    for (const forbidden of [
      "getSupabaseAdminClient",
      "database/client",
      "client.from(",
      "supabase.from(",
      ".rpc(",
      ".insert(",
      "client.update(",
      "supabase.update(",
      ".delete(",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `WhatsApp channel contains ${forbidden}`,
      );
    }
  }
  console.log(
    "PASS Route, Adapter and Channel have no direct persistence access",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
