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
const incomeServiceModule = path.join(
  root,
  "modules",
  "incomes",
  "income.service.ts",
);
const balanceServiceModule = path.join(
  root,
  "modules",
  "expenses",
  "balance.service.ts",
);
const categoryServiceModule = path.join(
  root,
  "modules",
  "categories",
  "category.service.ts",
);
const sharingRuleServiceModule = path.join(
  root,
  "modules",
  "sharing-rules",
  "sharing-rule.service.ts",
);
const householdMemberServiceModule = path.join(
  root,
  "modules",
  "household-members",
  "household-member.service.ts",
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
const incomeToolModule = path.join(
  root,
  "modules",
  "agent",
  "tools",
  "create-income.tool.ts",
);
const getExpensesToolModule = path.join(
  root,
  "modules",
  "agent",
  "tools",
  "get-expenses.tool.ts",
);
const getIncomesToolModule = path.join(
  root,
  "modules",
  "agent",
  "tools",
  "get-incomes.tool.ts",
);
const getBalanceToolModule = path.join(
  root,
  "modules",
  "agent",
  "tools",
  "get-balance.tool.ts",
);
const getCategoriesToolModule = path.join(
  root,
  "modules",
  "agent",
  "tools",
  "get-categories.tool.ts",
);
const getSharingRulesToolModule = path.join(
  root,
  "modules",
  "agent",
  "tools",
  "get-sharing-rules.tool.ts",
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
const memberC = "42000000-0000-4000-8000-000000000014";

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
let categoryDrafts = [];
let operations = [];
let createdExpenses = [];
let createdIncomes = [];
let nextProposal = 1;
let hydrationFailure = false;
let ambiguousMemberNames = false;
let normalizedMemberNames = false;

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

  update(payload) {
    this.updatePayload = payload;
    operations.push({ type: "update", table: this.table, payload });
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
    if (
      this.table !== "tb_pending_proposals" &&
      this.table !== "tb_agent_category_drafts"
    ) {
      return { data: null, error: { code: "UNEXPECTED_TABLE" } };
    }

    if (this.table === "tb_agent_category_drafts") {
      if (this.updatePayload !== undefined) {
        const row = categoryDrafts.find((candidate) =>
          matches(candidate, this.filters),
        );
        if (!row) return { data: [], error: null };
        Object.assign(row, this.updatePayload, {
          updated_at: new Date().toISOString(),
        });
        return { data: [row], error: null };
      }
      if (this.insertPayload !== undefined) {
        const conflict = categoryDrafts.some((row) =>
          ["household_id", "actor_member_id", "conversation_key"].every(
            (column) => row[column] === this.insertPayload[column],
          ),
        );
        if (conflict) return { data: null, error: { code: "23505" } };
        const now = new Date().toISOString();
        const row = {
          ...this.insertPayload,
          created_at: this.insertPayload.created_at ?? now,
          updated_at: this.insertPayload.updated_at ?? now,
        };
        categoryDrafts.push(row);
        return { data: [row], error: null };
      }
      const rows = categoryDrafts.filter((row) => matches(row, this.filters));
      if (this.deleteRequested) {
        categoryDrafts = categoryDrafts.filter((row) => !rows.includes(row));
      }
      return { data: rows, error: null };
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
    async listExpenses(context, filters) {
      operations.push({ type: "expense-list", context, filters });
      return [{ id: "expense-read-1", totalAmount: 12 }];
    },
  };
  const fakeIncomeService = {
    async createIncome(context, input) {
      createdIncomes.push({ context, input });
      return { id: `income-${createdIncomes.length}`, ...input };
    },
    async listIncomes(context, filters) {
      operations.push({ type: "income-list", context, filters });
      return {
        incomes: [{ id: "income-read-1", amount: 25 }],
        summary: { totalIncome: 25 },
      };
    },
  };
  const fakeBalanceService = {
    async getBalance(context) {
      operations.push({ type: "balance-read", context });
      return {
        members: [{ memberId: memberA, paid: 10, share: 5, balance: 5 }],
      };
    },
  };
  const fakeCategoryService = {
    async listCategories() {
      operations.push({ type: "category-read" });
      return [
        { id: "category-1", name: "Food" },
        { id: "category-vivienda", name: "Vivienda" },
        { id: "category-transporte", name: "Transporte" },
        { id: "category-mascotas", name: "Mascotas" },
        { id: "category-ocio", name: "Ocio" },
      ];
    },
  };
  const fakeSharingRuleService = {
    async listSharingRules(context) {
      operations.push({ type: "sharing-rule-read", context });
      return [{ id: "rule-1", name: "Equal", type: "PERCENTAGE", splits: [] }];
    },
  };
  const fakeHouseholdMemberService = {
    async listHouseholdMembers(context) {
      operations.push({ type: "household-member-read", context });
      if (context.householdId === householdA) {
        const members = [
          { id: memberA, displayName: "Felipe" },
          { id: memberB, displayName: "Alejandra" },
        ];
        if (ambiguousMemberNames) {
          members.push({
            id: "42000000-0000-4000-8000-000000000013",
            displayName: "Alejandra",
          });
        }
        if (normalizedMemberNames) {
          members.push({ id: memberC, displayName: "Ángela Gómez" });
        }
        return members;
      }
      return [
        { id: "42000000-0000-4000-8000-000000000013", displayName: "Carlos" },
      ];
    },
  };
  let mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "mercado",
    description: null,
    totalAmount: "85000",
    expenseDate: "2026-08-11",
    paidBySelf: true,
    categoryName: "Food",
  };
  const load = createLoader(
    new Map([
      [expenseServiceModule, fakeExpenseService],
      [incomeServiceModule, fakeIncomeService],
      [balanceServiceModule, fakeBalanceService],
      [categoryServiceModule, fakeCategoryService],
      [sharingRuleServiceModule, fakeSharingRuleService],
      [householdMemberServiceModule, fakeHouseholdMemberService],
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
  const createIncome = load(incomeToolModule);
  const getExpenses = load(getExpensesToolModule);
  const getIncomes = load(getIncomesToolModule);
  const getBalance = load(getBalanceToolModule);
  const getCategories = load(getCategoriesToolModule);
  const getSharingRules = load(getSharingRulesToolModule);

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
      ({ type, table }) =>
        type === "from" &&
        !["tb_pending_proposals", "tb_agent_category_drafts"].includes(table),
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

  const defaultExpenseDate = new Date().toISOString().slice(0, 10);
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Carulla",
    description: null,
    totalAmount: "10000",
    expenseDate: null,
    paidBySelf: null,
    householdId: householdB,
    actorMemberId: memberB,
    memberId: memberB,
    paidByMemberId: memberB,
    source: "RECEIPT",
    categoryName: "Food",
  };
  const defaultProposal = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-expense-defaults" },
    { message: "Registra un gasto de 10000 pesos en Carulla" },
  );
  assert.equal(defaultProposal.type, "PROPOSAL_CREATED");
  const defaultStored = proposals.find(
    (row) => row.id === defaultProposal.proposalId,
  );
  assert.equal(defaultStored.payload.expense.expenseDate, defaultExpenseDate);
  assert.equal(defaultStored.payload.expense.paidByMemberId, memberA);
  assert.equal(defaultStored.payload.actorMemberId, memberA);
  assert.equal(defaultStored.payload.source, "WEB");
  assert.equal(createdExpenses.length, 3);
  /*
  const defaultConfirmed = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-expense-defaults" },
    { message: "sÃ­" },
  );
  );
  */
  const defaultConfirmed = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-expense-defaults" },
    { message: "si" },
  );
  assert.equal(defaultConfirmed.type, "CONFIRMED");
  const repeatedDefaultConfirmation = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-expense-defaults" },
    { message: "si" },
  );
  assert.equal(repeatedDefaultConfirmation.type, "CLARIFICATION_REQUIRED");
  assert.equal(createdExpenses.length, 4);
  assert.equal(createdExpenses[3].input.expenseDate, defaultExpenseDate);
  assert.equal(createdExpenses[3].input.paidByMemberId, memberA);
  console.log(
    "PASS expense defaults use execution date and controlled actor without persisting before confirmation",
  );

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Éxito",
    description: "Mercado",
    totalAmount: "50000",
    expenseDate: "2026-08-12",
    paidBySelf: false,
    paidByMemberName: "  ALEJANDRA  ",
    categoryName: "Food",
  };
  const otherPayerContext = {
    ...contextA,
    conversationKey: "agent-expense-other-payer",
  };
  const beforeOtherPayerExpenses = createdExpenses.length;
  const otherPayerProposal = await conversation.processAgentMessage(
    otherPayerContext,
    { message: "Alejandra pagó 50000 de mercado" },
  );
  assert.equal(otherPayerProposal.type, "PROPOSAL_CREATED");
  const otherPayerStored = proposals.find(
    (row) => row.id === otherPayerProposal.proposalId,
  );
  assert.equal(otherPayerStored.payload.actorMemberId, memberA);
  assert.equal(otherPayerStored.payload.expense.paidByMemberId, memberB);
  assert.equal(createdExpenses.length, beforeOtherPayerExpenses);
  const otherPayerConfirmed = await conversation.processAgentMessage(
    otherPayerContext,
    { message: "si" },
  );
  assert.equal(otherPayerConfirmed.type, "CONFIRMED");
  assert.equal(createdExpenses.length, beforeOtherPayerExpenses + 1);
  assert.equal(createdExpenses.at(-1).input.createdBy, memberA);
  assert.equal(createdExpenses.at(-1).input.paidByMemberId, memberB);
  const otherPayerRepeated = await conversation.processAgentMessage(
    otherPayerContext,
    { message: "si" },
  );
  assert.equal(otherPayerRepeated.type, "CLARIFICATION_REQUIRED");
  assert.equal(createdExpenses.length, beforeOtherPayerExpenses + 1);
  console.log(
    "PASS explicit household member payer resolves without changing createdBy",
  );

  normalizedMemberNames = true;
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Éxito",
    description: "Mercado",
    totalAmount: "50000",
    expenseDate: "2026-08-12",
    paidBySelf: false,
    paidByMemberName: "angela   gomez",
    categoryName: "Food",
  };
  const normalizedPayerContext = {
    ...contextA,
    conversationKey: "agent-expense-normalized-payer",
  };
  const normalizedPayerProposal = await conversation.processAgentMessage(
    normalizedPayerContext,
    { message: "angela   gomez pagó 50000 de mercado" },
  );
  assert.equal(normalizedPayerProposal.type, "PROPOSAL_CREATED");
  const normalizedPayerStored = proposals.find(
    (row) => row.id === normalizedPayerProposal.proposalId,
  );
  assert.equal(normalizedPayerStored.payload.expense.paidByMemberId, memberC);
  const normalizedPayerRejected = await conversation.processAgentMessage(
    normalizedPayerContext,
    { message: "no" },
  );
  assert.equal(normalizedPayerRejected.type, "REJECTED");
  normalizedMemberNames = false;
  console.log("PASS payer resolution normalizes accents and internal spaces");

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Carulla",
    description: null,
    totalAmount: "100",
    expenseDate: "2026-08-12",
    paidBySelf: false,
    paidByMemberName: "Carlos",
    categoryName: "Food",
  };
  const unknownPayerContext = {
    ...contextA,
    conversationKey: "agent-expense-unknown-payer",
  };
  const beforeUnknownPayerProposals = proposals.length;
  const unknownPayer = await conversation.processAgentMessage(
    unknownPayerContext,
    { message: "Carlos pagó 100 de mercado" },
  );
  assert.equal(unknownPayer.type, "CLARIFICATION_REQUIRED");
  assert.equal(proposals.length, beforeUnknownPayerProposals);
  assert.equal(createdExpenses.at(-1).input.paidByMemberId, memberB);
  console.log("PASS unknown household payer does not fall back to actor");

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Carulla",
    description: null,
    totalAmount: "100",
    expenseDate: "2026-08-12",
    paidBySelf: false,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const missingPayer = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-expense-missing-payer" },
    { message: "Alguien pagó 100 de mercado" },
  );
  assert.equal(missingPayer.type, "CLARIFICATION_REQUIRED");
  assert.equal(proposals.length, beforeUnknownPayerProposals);
  console.log("PASS missing explicit payer requests clarification");

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Carulla",
    description: null,
    totalAmount: "100",
    expenseDate: "2026-08-12",
    paidBySelf: false,
    paidByMemberName: "Alejandra",
    categoryName: null,
  };
  const payerCategoryContext = {
    ...contextA,
    conversationKey: "agent-expense-payer-category",
  };
  const payerCategoryClarification = await conversation.processAgentMessage(
    payerCategoryContext,
    { message: "Alejandra pagó 100 de mercado" },
  );
  assert.equal(payerCategoryClarification.type, "CLARIFICATION_REQUIRED");
  const payerDraft = categoryDrafts.find(
    (row) => row.conversation_key === payerCategoryContext.conversationKey,
  );
  assert.equal(payerDraft.payload.expense.paidByMemberId, memberB);
  const payerCategoryProposal = await conversation.processAgentMessage(
    payerCategoryContext,
    { message: "Food" },
  );
  assert.equal(payerCategoryProposal.type, "PROPOSAL_CREATED");
  const payerCategoryStored = proposals.find(
    (row) => row.id === payerCategoryProposal.proposalId,
  );
  assert.equal(payerCategoryStored.payload.expense.paidByMemberId, memberB);
  await conversation.processAgentMessage(payerCategoryContext, {
    message: "si",
  });
  assert.equal(createdExpenses.at(-1).input.paidByMemberId, memberB);
  console.log("PASS payer resolution survives category draft continuation");

  ambiguousMemberNames = true;
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Carulla",
    description: null,
    totalAmount: "100",
    expenseDate: "2026-08-12",
    paidBySelf: false,
    paidByMemberName: "Alejandra",
    categoryName: "Food",
  };
  const beforeAmbiguousPayerProposals = proposals.length;
  const ambiguousPayer = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-expense-ambiguous-payer" },
    { message: "Alejandra pagó 100 de mercado" },
  );
  assert.equal(ambiguousPayer.type, "CLARIFICATION_REQUIRED");
  assert.equal(proposals.length, beforeAmbiguousPayerProposals);
  assert.equal(createdExpenses.at(-1).input.paidByMemberId, memberB);
  ambiguousMemberNames = false;
  console.log("PASS ambiguous household payer requests clarification");

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Carulla",
    description: null,
    totalAmount: "10000",
    expenseDate: "2026-08-12",
    paidBySelf: true,
    categoryName: null,
  };
  const categoryContext = {
    ...contextA,
    conversationKey: "agent-category-clarification",
  };
  const beforeCategoryProposalCount = proposals.length;
  const categoryClarificationResult = await conversation.processAgentMessage(
    categoryContext,
    { message: "Registra un gasto de 10000 pesos en Carulla" },
  );
  assert.equal(categoryClarificationResult.type, "CLARIFICATION_REQUIRED");
  assert.equal(categoryDrafts.length, 1);
  assert.equal(proposals.length, beforeCategoryProposalCount);
  const categoryProposal = await conversation.processAgentMessage(
    categoryContext,
    { message: "Food" },
  );
  assert.equal(categoryProposal.type, "PROPOSAL_CREATED");
  const categoryStored = proposals.find(
    (row) => row.id === categoryProposal.proposalId,
  );
  assert.equal(categoryStored.payload.expense.categoryId, "category-1");
  assert.equal(categoryDrafts.length, 0);
  const categoryConfirmed = await conversation.processAgentMessage(
    categoryContext,
    { message: "si" },
  );
  assert.equal(categoryConfirmed.type, "CONFIRMED");
  assert.equal(createdExpenses.at(-1).input.categoryId, "category-1");
  console.log(
    "PASS category clarification resolves a real category before proposal",
  );

  const canonicalCategories = [
    ["Vivienda", "category-vivienda"],
    ["Transporte", "category-transporte"],
    ["Mascotas", "category-mascotas"],
    ["Ocio", "category-ocio"],
  ];
  for (const [categoryName, categoryId] of canonicalCategories) {
    mockInterpretation = {
      kind: "CREATE_EXPENSE",
      merchant: "Prueba de catálogo",
      description: null,
      totalAmount: "100",
      expenseDate: "2026-08-12",
      paidBySelf: true,
      categoryName,
    };
    const canonicalCategoryContext = {
      ...contextA,
      conversationKey: `agent-canonical-category-${categoryName}`,
    };
    const canonicalProposal = await conversation.processAgentMessage(
      canonicalCategoryContext,
      { message: `Registra un gasto de 100 en ${categoryName}` },
    );
    assert.equal(canonicalProposal.type, "PROPOSAL_CREATED");
    const canonicalStored = proposals.find(
      (row) => row.id === canonicalProposal.proposalId,
    );
    assert.equal(canonicalStored.payload.expense.categoryId, categoryId);
    const canonicalRejected = await conversation.processAgentMessage(
      canonicalCategoryContext,
      { message: "no" },
    );
    assert.equal(canonicalRejected.type, "REJECTED");
  }
  console.log(
    "PASS canonical essential expense categories resolve without semantic mapping",
  );

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Carulla",
    description: null,
    totalAmount: "100",
    expenseDate: "2026-08-12",
    paidBySelf: true,
    categoryName: null,
  };
  const invalidCategoryContext = {
    ...contextA,
    conversationKey: "agent-invalid-category",
  };
  await conversation.processAgentMessage(invalidCategoryContext, {
    message: "Registra un gasto de 100 en Carulla",
  });
  const invalidCategory = await conversation.processAgentMessage(
    invalidCategoryContext,
    { message: "Transport" },
  );
  assert.equal(invalidCategory.type, "CLARIFICATION_REQUIRED");
  assert.equal(proposals.filter((row) => row.household_id === householdA).length > 0, true);
  const invalidCategoryProposal = await conversation.processAgentMessage(
    invalidCategoryContext,
    { message: "Food" },
  );
  assert.equal(invalidCategoryProposal.type, "PROPOSAL_CREATED");
  await conversation.processAgentMessage(invalidCategoryContext, {
    message: "no",
  });
  const cancelledDraftResult = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-draft-cancel" },
    { message: "Registra un gasto de 50 en Carulla" },
  );
  assert.equal(cancelledDraftResult.type, "CLARIFICATION_REQUIRED");
  const cancelledDraft = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-draft-cancel" },
    { message: "cancelar" },
  );
  assert.equal(cancelledDraft.type, "REJECTED");
  assert.equal(cancelledDraft.message, "Operación cancelada.");
  console.log("PASS invalid category keeps the draft and reoffers real options");

  const isolatedCategoryContext = {
    ...contextA,
    conversationKey: "agent-category-isolation",
  };
  await conversation.processAgentMessage(isolatedCategoryContext, {
    message: "Registra un gasto de 200 en Carulla",
  });
  const otherHouseholdCategory = await conversation.processAgentMessage(
    { ...isolatedCategoryContext, householdId: householdB, actorMemberId: memberB },
    { message: "Food" },
  );
  assert.equal(otherHouseholdCategory.type, "CLARIFICATION_REQUIRED");
  assert.equal(categoryDrafts.some((row) => row.household_id === householdA), true);
  const isolatedCompleted = await conversation.processAgentMessage(
    isolatedCategoryContext,
    { message: "Food" },
  );
  assert.equal(isolatedCompleted.type, "PROPOSAL_CREATED");
  await conversation.processAgentMessage(isolatedCategoryContext, {
    message: "no",
  });
  console.log("PASS category drafts are isolated by household and actor");

  mockInterpretation = {
    kind: "CREATE_INCOME",
    amount: "125",
    incomeDate: "2026-08-12",
    description: "Salary",
    categoryName: null,
  };
  const incomeCategoryContext = {
    ...contextA,
    conversationKey: "agent-income-category",
  };
  const incomeCategoryClarification = await conversation.processAgentMessage(
    incomeCategoryContext,
    { message: "Recibí un salario de 125" },
  );
  assert.equal(incomeCategoryClarification.type, "CLARIFICATION_REQUIRED");
  const incomeCategoryProposal = await conversation.processAgentMessage(
    incomeCategoryContext,
    { message: "Food" },
  );
  assert.equal(incomeCategoryProposal.type, "PROPOSAL_CREATED");
  const incomeCategoryStored = proposals.find(
    (row) => row.id === incomeCategoryProposal.proposalId,
  );
  assert.equal(incomeCategoryStored.payload.income.categoryId, "category-1");
  console.log("PASS income category clarification creates a categorized proposal");
  /*
  await expectAgentError(
    conversation.processAgentMessage(
      { ...contextA, conversationKey: "agent-expense-defaults" },
      { message: "sÃ­" },
    ),
    "PROPOSAL_NOT_AVAILABLE",
  );
  assert.equal(createdExpenses.length, 4);
  console.log(
    "PASS expense defaults use execution date and controlled actor without persisting before confirmation",
  );

  */
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "algo",
    description: null,
    totalAmount: null,
    expenseDate: "2026-08-12",
    paidBySelf: true,
    categoryName: "Food",
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
    categoryName: "Food",
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
  const beforeRejectionExpenses = createdExpenses.length;
  const rejectionProposal = await conversation.processAgentMessage(
    rejectionContext,
    { message: "Pagué 100" },
  );
  const conversationalRejection = await conversation.processAgentMessage(
    rejectionContext,
    { message: "no", proposalId: rejectionProposal.proposalId },
  );
  assert.equal(conversationalRejection.type, "REJECTED");
  assert.equal(createdExpenses.length, beforeRejectionExpenses);
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

  const incomeContext = {
    ...contextA,
    conversationKey: "agent-income-create",
  };
  const incomeProposal = await createIncome.createIncomeTool(incomeContext, {
    memberId: memberB,
    amount: 75,
    incomeDate: "2026-08-12",
    description: "Salary",
    categoryId: null,
  });
  assert.equal(incomeProposal.status, "AWAITING_CONFIRMATION");
  assert.equal(createdIncomes.length, 0);
  const incomeConfirmed = await conversation.processAgentMessage(
    incomeContext,
    {
      message: "si",
      proposalId: incomeProposal.proposalId,
    },
  );
  assert.equal(incomeConfirmed.type, "CONFIRMED");
  assert.equal(createdIncomes.length, 1);
  assert.equal(createdIncomes[0].context.householdId, householdA);
  assert.equal(createdIncomes[0].context.memberId, memberA);
  assert.equal(createdIncomes[0].input.memberId, memberB);
  await expectAgentError(
    conversation.processAgentMessage(incomeContext, {
      message: "si",
      proposalId: incomeProposal.proposalId,
    }),
    "PROPOSAL_NOT_AVAILABLE",
  );
  console.log("PASS create_income requires confirmation and cannot duplicate");

  const expenseRead = await getExpenses.getExpensesTool(contextA, {
    from: "2026-08-01",
    memberId: memberA,
  });
  assert.deepEqual(expenseRead, [{ id: "expense-read-1", totalAmount: 12 }]);
  const expenseReadOperation = operations.find(
    ({ type }) => type === "expense-list",
  );
  assert.equal(expenseReadOperation.context.householdId, householdA);
  assert.equal(expenseReadOperation.filters.memberId, memberA);
  console.log("PASS get_expenses delegates controlled context and filters");

  const incomeRead = await getIncomes.getIncomesTool(contextA, {
    categoryId: "category-1",
  });
  assert.equal(incomeRead.summary.totalIncome, 25);
  assert.equal(
    operations.find(({ type }) => type === "income-list").context.householdId,
    householdA,
  );
  console.log("PASS get_incomes delegates controlled context and filters");

  const balanceRead = await getBalance.getBalanceTool(contextA);
  assert.equal(balanceRead.members[0].memberId, memberA);
  assert.equal(
    operations.find(({ type }) => type === "balance-read").context.householdId,
    householdA,
  );
  console.log("PASS get_balance delegates without recalculating");

  const categoryRead = await getCategories.getCategoriesTool(contextA);
  assert.deepEqual(categoryRead, [
    { id: "category-1", name: "Food" },
    { id: "category-vivienda", name: "Vivienda" },
    { id: "category-transporte", name: "Transporte" },
    { id: "category-mascotas", name: "Mascotas" },
    { id: "category-ocio", name: "Ocio" },
  ]);
  console.log(
    "PASS get_categories delegates without context or persistence access",
  );

  const sharingRead = await getSharingRules.getSharingRulesTool(contextA);
  assert.equal(sharingRead[0].id, "rule-1");
  assert.equal(
    operations.find(({ type }) => type === "sharing-rule-read").context
      .householdId,
    householdA,
  );
  console.log("PASS get_sharing_rules delegates controlled context");

  mockInterpretation = {
    kind: "GET_EXPENSES",
    filters: { memberId: memberA },
  };
  const conversationalExpenses = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-read-expenses" },
    { message: "Muéstrame mis gastos" },
  );
  assert.equal(conversationalExpenses.type, "READ_RESULT");
  assert.equal(conversationalExpenses.operation, "GET_EXPENSES");
  assert.equal(
    operations.filter(({ type }) => type === "expense-list").at(-1).context
      .householdId,
    householdA,
  );
  console.log("PASS textual Expense query selects get_expenses");

  mockInterpretation = {
    kind: "GET_INCOMES",
    filters: { categoryId: "category-1" },
  };
  const conversationalIncomes = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-read-incomes" },
    { message: "Muéstrame mis ingresos" },
  );
  assert.equal(conversationalIncomes.type, "READ_RESULT");
  assert.equal(conversationalIncomes.operation, "GET_INCOMES");
  console.log("PASS textual Income query selects get_incomes");

  mockInterpretation = { kind: "GET_BALANCE" };
  const conversationalBalance = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-read-balance" },
    { message: "¿Cuál es mi balance?" },
  );
  assert.equal(conversationalBalance.type, "READ_RESULT");
  assert.equal(conversationalBalance.operation, "GET_BALANCE");
  console.log("PASS textual Balance query selects get_balance");

  mockInterpretation = { kind: "GET_CATEGORIES" };
  const conversationalCategories = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-read-categories" },
    { message: "Lista las categorías" },
  );
  assert.equal(conversationalCategories.type, "READ_RESULT");
  assert.equal(conversationalCategories.operation, "GET_CATEGORIES");
  console.log("PASS textual Category query selects get_categories");

  mockInterpretation = { kind: "GET_SHARING_RULES" };
  const conversationalRules = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-read-rules" },
    { message: "Lista las reglas de reparto" },
  );
  assert.equal(conversationalRules.type, "READ_RESULT");
  assert.equal(conversationalRules.operation, "GET_SHARING_RULES");
  console.log("PASS textual Sharing Rules query selects get_sharing_rules");

  mockInterpretation = {
    kind: "CREATE_INCOME",
    amount: "125",
    incomeDate: "2026-08-12",
    description: "Bonus",
    merchant: null,
    totalAmount: null,
    expenseDate: null,
    paidBySelf: null,
    categoryName: "Food",
  };
  const conversationalIncomeProposal = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-income-text" },
    { message: "Recibí un bonus de 125" },
  );
  assert.equal(conversationalIncomeProposal.type, "PROPOSAL_CREATED");
  assert.equal(createdIncomes.length, 1);
  console.log("PASS textual Income creation proposes without writing");

  const conversationalIncomeRejected = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-income-text" },
    { message: "no", proposalId: conversationalIncomeProposal.proposalId },
  );
  assert.equal(conversationalIncomeRejected.type, "REJECTED");
  assert.equal(createdIncomes.length, 1);
  console.log("PASS textual Income rejection does not write");

  const openaiSource = fs.readFileSync(openaiAdapterModule, "utf8");
  const createExpenseTypeStart = openaiSource.indexOf('kind: "CREATE_EXPENSE"');
  const createIncomeTypeStart = openaiSource.indexOf('kind: "CREATE_INCOME"');
  const createExpenseTypeSource = openaiSource.slice(
    createExpenseTypeStart,
    createIncomeTypeStart,
  );
  assert.ok(createExpenseTypeSource.includes("paidByMemberName"));
  assert.ok(!createExpenseTypeSource.includes("paidByMemberId"));
  assert.ok(!createExpenseTypeSource.includes("householdId"));
  assert.ok(!createExpenseTypeSource.includes("memberId"));
  assert.ok(
    openaiSource.includes(
      "Never return household, actor,\ncreatedBy, source, member ids",
    ),
  );
  console.log("PASS payer model contract exposes only a member name");

  for (const source of [
    fs.readFileSync(conversationModule, "utf8"),
    fs.readFileSync(openaiAdapterModule, "utf8"),
    fs.readFileSync(incomeToolModule, "utf8"),
    fs.readFileSync(getExpensesToolModule, "utf8"),
    fs.readFileSync(getIncomesToolModule, "utf8"),
    fs.readFileSync(getBalanceToolModule, "utf8"),
    fs.readFileSync(getCategoriesToolModule, "utf8"),
    fs.readFileSync(getSharingRulesToolModule, "utf8"),
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
