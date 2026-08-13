const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const expenseServiceModule = path.join(
  root,
  "modules",
  "expenses",
  "expense.service.ts",
);
const agentServiceModule = path.join(
  root,
  "modules",
  "agent",
  "agent.service.ts",
);
const toolModule = path.join(
  root,
  "modules",
  "agent",
  "tools",
  "create-expense.tool.ts",
);
const conversationModule = path.join(
  root,
  "modules",
  "agent",
  "conversation.service.ts",
);
const openaiAdapterModule = path.join(
  root,
  "infrastructure",
  "openai",
  "openai.adapter.ts",
);

const householdA = "42000000-0000-4000-8000-000000000001";
const householdB = "42000000-0000-4000-8000-000000000002";
const memberA = "42000000-0000-4000-8000-000000000011";
const memberB = "42000000-0000-4000-8000-000000000012";

const contextA = {
  householdId: householdA,
  actorMemberId: memberA,
  conversationKey: "agent-test-conversation",
  source: "WEB",
};
const expenseInput = {
  paidByMemberId: memberA,
  totalAmount: 100,
  expenseDate: "2026-08-12",
  description: "Agent proposal",
  splits: [{ householdMemberId: memberA, percentage: 100 }],
};

let proposals = [];
let operations = [];
let createdExpenses = [];
let nextProposal = 1;
let hydrationFailure = false;

function matches(row, filters) {
  return filters.every(({ column, value }) => row[column] === value);
}

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

  insert(payload) {
    this.insertPayload = payload;
    operations.push({ type: "insert", table: this.table, payload });
    return this;
  }

  delete() {
    this.deleteRequested = true;
    operations.push({ type: "delete", table: this.table });
    return this;
  }

  eq(column, value) {
    this.filters.push({ column, value });
    operations.push({ type: "filter", table: this.table, column, value });
    return this;
  }

  execute() {
    if (this.table !== "tb_pending_proposals") {
      return { data: null, error: { code: "UNEXPECTED_TABLE" } };
    }

    if (this.insertPayload !== undefined) {
      const conflict = proposals.some(
        (row) =>
          row.household_id === this.insertPayload.household_id &&
          row.conversation_key === this.insertPayload.conversation_key &&
          row.status === "AWAITING_CONFIRMATION",
      );
      if (conflict) return { data: null, error: { code: "23505" } };
      const now = "2026-08-12T12:00:00.000Z";
      const row = {
        ...this.insertPayload,
        created_at: this.insertPayload.created_at ?? now,
        updated_at: this.insertPayload.updated_at ?? now,
      };
      proposals.push(row);
      return { data: [row], error: null };
    }

    const rows = proposals.filter((row) => matches(row, this.filters));
    if (this.deleteRequested) {
      proposals = proposals.filter((row) => !rows.includes(row));
    }
    return { data: rows, error: null };
  }

  maybeSingle() {
    const result = this.execute();
    return Promise.resolve({
      data: result.data?.[0] ?? null,
      error: result.error,
    });
  }

  single() {
    const result = this.execute();
    return Promise.resolve({
      data: result.data?.[0] ?? null,
      error: result.error,
    });
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

const fakeClient = {
  from(table) {
    operations.push({ type: "from", table });
    return new FakeQuery(table);
  },
  rpc(name) {
    operations.push({ type: "rpc", name });
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

function expectAgentError(promise, code) {
  return promise
    .then(() => assert.fail(`Expected ${code}`))
    .catch((error) => {
      assert.equal(error.code, code);
    });
}

async function main() {
  let expenseDomainErrorClass;
  const fakeExpenseService = {
    async createExpense(context, input) {
      createdExpenses.push({ context, input });
      if (hydrationFailure) {
        throw new expenseDomainErrorClass(
          "CREATED_NOT_HYDRATED",
          "created but not hydrated",
        );
      }
      return { id: `expense-${createdExpenses.length}` };
    },
  };
  let mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "mercado",
    description: null,
    totalAmount: "85000",
    expenseDate: "2026-08-11",
    paidBySelf: true,
  };
  const load = createLoader(
    new Map([
      [expenseServiceModule, fakeExpenseService],
      [
        openaiAdapterModule,
        {
          interpretExpenseMessage: async () => mockInterpretation,
        },
      ],
    ]),
  );
  expenseDomainErrorClass = load(
    path.join(root, "modules", "expenses", "expense.types.ts"),
  ).ExpenseDomainError;
  const agentService = load(agentServiceModule);
  const tool = load(toolModule);
  const conversation = load(conversationModule);

  const toolSource = fs.readFileSync(toolModule, "utf8");
  for (const forbidden of [
    "getSupabaseAdminClient",
    "database/client",
    "pending-proposal.repository",
    ".from(",
    ".rpc(",
    ".insert(",
    ".update(",
    ".delete(",
  ]) {
    assert.ok(!toolSource.includes(forbidden), `Tool contains ${forbidden}`);
  }
  const agentSource = fs.readFileSync(agentServiceModule, "utf8");
  assert.ok(agentSource.includes("@/modules/expenses/expense.service"));
  assert.ok(agentSource.includes("createExpense("));
  console.log("PASS create_expense Tool has no direct persistence access");

  const proposal = await tool.createExpenseTool(contextA, expenseInput);
  assert.equal(proposal.status, "AWAITING_CONFIRMATION");
  assert.equal(proposals.length, 1);
  console.log("PASS valid intent creates a PendingProposal");

  const pending = await agentService.getExpenseProposal(
    contextA,
    proposal.proposalId,
  );
  assert.equal(pending.payload.actorMemberId, memberA);
  assert.equal(pending.householdId, householdA);
  console.log("PASS pending proposal is retrieved with controlled ownership");

  const confirmed = await tool.confirmCreateExpenseTool(
    contextA,
    proposal.proposalId,
  );
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(createdExpenses.length, 1);
  assert.equal(createdExpenses[0].context.householdId, householdA);
  assert.equal(createdExpenses[0].input.createdBy, memberA);
  assert.equal(proposals.length, 0);
  console.log(
    "PASS confirmation consumes proposal and creates exactly one Expense",
  );

  await expectAgentError(
    tool.confirmCreateExpenseTool(contextA, proposal.proposalId),
    "PROPOSAL_NOT_AVAILABLE",
  );
  assert.equal(createdExpenses.length, 1);
  console.log("PASS repeated confirmation cannot create a second Expense");

  const hydrationProposal = await tool.createExpenseTool(
    contextA,
    expenseInput,
  );
  hydrationFailure = true;
  await expectAgentError(
    tool.confirmCreateExpenseTool(contextA, hydrationProposal.proposalId),
    "CREATED_NOT_HYDRATED",
  );
  hydrationFailure = false;
  await expectAgentError(
    tool.confirmCreateExpenseTool(contextA, hydrationProposal.proposalId),
    "PROPOSAL_NOT_AVAILABLE",
  );
  assert.equal(createdExpenses.length, 2);
  console.log("PASS created-but-not-hydrated confirmation cannot be retried");

  const rejectedProposal = await tool.createExpenseTool(contextA, {
    ...expenseInput,
    description: "Rejected proposal",
  });
  const rejected = await tool.rejectCreateExpenseTool(
    contextA,
    rejectedProposal.proposalId,
  );
  assert.equal(rejected.status, "REJECTED");
  assert.equal(createdExpenses.length, 2);
  assert.equal(proposals.length, 0);
  console.log("PASS rejection consumes proposal without creating Expense");

  const isolatedProposal = await tool.createExpenseTool(contextA, expenseInput);
  await expectAgentError(
    agentService.getExpenseProposal(
      { ...contextA, householdId: householdB },
      isolatedProposal.proposalId,
    ),
    "NOT_FOUND",
  );
  await expectAgentError(
    tool.confirmCreateExpenseTool(
      { ...contextA, actorMemberId: memberB },
      isolatedProposal.proposalId,
    ),
    "HOUSEHOLD_MISMATCH",
  );
  await expectAgentError(
    tool.confirmCreateExpenseTool(
      { ...contextA, householdId: householdB },
      isolatedProposal.proposalId,
    ),
    "PROPOSAL_NOT_AVAILABLE",
  );
  assert.equal(createdExpenses.length, 2);
  console.log(
    "PASS household and actor isolation prevent unauthorized confirmation",
  );

  await expectAgentError(
    tool.createExpenseTool(contextA, expenseInput),
    "PENDING_PROPOSAL_EXISTS",
  );
  assert.equal(proposals.length, 1);
  console.log("PASS concurrent proposal for one conversation is rejected");

  assert.equal(
    operations.filter(
      ({ type, table }) => type === "from" && table !== "tb_pending_proposals",
    ).length,
    0,
  );
  assert.equal(operations.filter(({ type }) => type === "rpc").length, 0);
  console.log("PASS Agent persistence is isolated to PendingProposal");

  console.log(
    "PASS Agent Foundation regression boundary is Expense Service delegation",
  );

  const naturalContext = {
    ...contextA,
    conversationKey: "agent-natural-language",
  };
  const naturalProposal = await conversation.processAgentMessage(
    naturalContext,
    { message: "Pagué 85000 de mercado ayer" },
  );
  assert.equal(naturalProposal.type, "PROPOSAL_CREATED");
  assert.equal(createdExpenses.length, 2);
  const naturalStored = proposals.find(
    (row) => row.id === naturalProposal.proposalId,
  );
  assert.equal(naturalStored.payload.expense.paidByMemberId, memberA);
  assert.equal(naturalStored.payload.source, "WEB");
  assert.equal(naturalStored.payload.expense.totalAmount, 85000);
  console.log(
    "PASS natural language creates a structured PendingProposal only",
  );

  const naturalConfirmed = await conversation.processAgentMessage(
    naturalContext,
    { message: "sí", proposalId: naturalProposal.proposalId },
  );
  assert.equal(naturalConfirmed.type, "CONFIRMED");
  assert.equal(createdExpenses.length, 3);
  await expectAgentError(
    conversation.processAgentMessage(naturalContext, {
      message: "sí",
      proposalId: naturalProposal.proposalId,
    }),
    "PROPOSAL_NOT_AVAILABLE",
  );
  console.log("PASS explicit confirmation uses the existing proposal once");

  mockInterpretation = {
    ...mockInterpretation,
    totalAmount: null,
  };
  const clarification = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-clarification" },
    { message: "Pagué algo" },
  );
  assert.equal(clarification.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(clarification.missingFields, ["totalAmount"]);
  console.log(
    "PASS incomplete intent asks for clarification without persistence",
  );

  mockInterpretation = {
    kind: "UNSUPPORTED",
  };
  const unsupported = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-unsupported" },
    { message: "¿Cómo estará el clima?" },
  );
  assert.equal(unsupported.type, "UNSUPPORTED");
  console.log("PASS uninterpretable message does not create a proposal");

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "mercado",
    description: null,
    totalAmount: "100",
    expenseDate: "2026-08-12",
    paidBySelf: true,
    householdId: householdB,
    actorMemberId: memberB,
    source: "RECEIPT",
  };
  const protectedContext = {
    ...contextA,
    conversationKey: "agent-context-protection",
  };
  const protectedProposal = await conversation.processAgentMessage(
    protectedContext,
    { message: "Pagué 100" },
  );
  assert.equal(protectedProposal.type, "PROPOSAL_CREATED");
  const protectedStored = proposals.find(
    (row) => row.id === protectedProposal.proposalId,
  );
  assert.equal(protectedStored.household_id, householdA);
  assert.equal(protectedStored.payload.actorMemberId, memberA);
  assert.equal(protectedStored.payload.source, "WEB");
  console.log("PASS model output cannot override controlled context");

  const rejectionContext = {
    ...contextA,
    conversationKey: "agent-natural-rejection",
  };
  const rejectionProposal = await conversation.processAgentMessage(
    rejectionContext,
    { message: "Pagué 100" },
  );
  const conversationalRejection = await conversation.processAgentMessage(
    rejectionContext,
    { message: "no", proposalId: rejectionProposal.proposalId },
  );
  assert.equal(conversationalRejection.type, "REJECTED");
  assert.equal(createdExpenses.length, 3);
  console.log("PASS explicit rejection consumes the proposal without writing");

  const providerError = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-provider-error" },
    { message: "Pagué 100" },
    async () => {
      throw new Error("internal-provider-error-details");
    },
  );
  assert.equal(providerError.type, "ERROR");
  assert.equal(providerError.code, "INTERPRETATION_ERROR");
  assert.ok(!providerError.message.includes("provider-error-details"));
  console.log("PASS provider errors are sanitized");

  for (const source of [
    fs.readFileSync(conversationModule, "utf8"),
    fs.readFileSync(openaiAdapterModule, "utf8"),
  ]) {
    for (const forbidden of [
      "getSupabaseAdminClient",
      ".from(",
      ".rpc(",
      ".insert(",
      ".update(",
      ".delete(",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `Agent adapter contains ${forbidden}`,
      );
    }
  }
  console.log("PASS Agent/OpenAI adapter has no direct persistence access");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
