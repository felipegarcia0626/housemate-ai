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
const pendingProposalRepositoryModule = path.join(
  root,
  "modules",
  "agent",
  "pending-proposal.repository.ts",
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
let confirmationFailure = false;
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
        if (!row) return { data: null, error: { code: "PGRST116" } };
        const previousUpdatedAt = Date.parse(row.updated_at);
        const nextUpdatedAt = Math.max(
          Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0,
          Date.now(),
        );
        Object.assign(row, this.updatePayload, {
          updated_at: new Date(nextUpdatedAt).toISOString(),
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

    if (this.updatePayload !== undefined) {
      const row = proposals.find((candidate) =>
        matches(candidate, this.filters),
      );
      if (!row) return { data: [], error: null };
      Object.assign(row, this.updatePayload, {
        updated_at: new Date(Date.now()).toISOString(),
      });
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
  rpc(name, args) {
    operations.push({ type: "rpc", name, args });
    if (
      name !== "fn_confirm_pending_expense" &&
      name !== "fn_confirm_pending_income"
    ) {
      throw new Error(`Unexpected RPC: ${name}`);
    }
    if (confirmationFailure) {
      return Promise.resolve({ data: null, error: { code: "40001" } });
    }
    const proposal = proposals.find(
      (row) =>
        row.id === args.p_proposal_id &&
        row.household_id === args.p_household_id &&
        row.conversation_key === args.p_conversation_key,
    );
    if (!proposal) {
      return Promise.resolve({
        data: { status: "NOT_FOUND", expense_id: null },
        error: null,
      });
    }
    if (
      proposal.payload.actorMemberId !== args.p_actor_member_id ||
      proposal.payload.source !== args.p_context_source
    ) {
      return Promise.resolve({
        data: { status: "NOT_FOUND", expense_id: null },
        error: null,
      });
    }
    if (name === "fn_confirm_pending_income") {
      if (proposal.operation_type !== "CREATE_INCOME") {
        return Promise.resolve({
          data: { status: "INVALID_OPERATION", income_id: null },
          error: null,
        });
      }
      if (proposal.status === "COMPLETED") {
        return Promise.resolve({
          data: { status: "ALREADY_COMPLETED", income_id: proposal.income_id },
          error: null,
        });
      }
      if (proposal.status === "REJECTED") {
        return Promise.resolve({
          data: { status: "REJECTED", income_id: null },
          error: null,
        });
      }
      const incomeId = `income-${createdIncomes.length + 1}`;
      createdIncomes.push({
        context: {
          householdId: args.p_household_id,
          memberId: args.p_created_by,
        },
        input: {
          memberId: args.p_member_id,
          amount: args.p_amount,
          incomeDate: args.p_income_date,
          description: args.p_description,
          categoryId: args.p_category_id,
        },
      });
      Object.assign(proposal, {
        status: "COMPLETED",
        expense_id: null,
        income_id: incomeId,
        resolved_at: "2026-08-12T12:00:00.000Z",
      });
      return Promise.resolve({
        data: { status: "CREATED", income_id: incomeId },
        error: null,
      });
    }
    if (proposal.operation_type !== "CREATE_EXPENSE") {
      return Promise.resolve({
        data: { status: "INVALID_OPERATION", expense_id: null },
        error: null,
      });
    }
    if (proposal.status === "COMPLETED") {
      return Promise.resolve({
        data: { status: "ALREADY_COMPLETED", expense_id: proposal.expense_id },
        error: null,
      });
    }
    if (proposal.status === "REJECTED") {
      return Promise.resolve({
        data: { status: "REJECTED", expense_id: null },
        error: null,
      });
    }
    const expenseId = `expense-${createdExpenses.length + 1}`;
    createdExpenses.push({
      context: { householdId: args.p_household_id },
      input: {
        ...proposal.payload.expense,
        createdBy: args.p_created_by,
        paidByMemberId: args.p_paid_by,
        categoryId: args.p_category_id,
        receiptId: args.p_receipt_id,
        merchant: args.p_merchant,
        totalAmount: args.p_total_amount,
        expenseDate: args.p_expense_date,
        description: args.p_description,
        source: args.p_source,
      },
    });
    Object.assign(proposal, {
      status: "COMPLETED",
      expense_id: expenseId,
      income_id: null,
      resolved_at: "2026-08-12T12:00:00.000Z",
    });
    return Promise.resolve({
      data: { status: "CREATED", expense_id: expenseId },
      error: null,
    });
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
    async prepareExpenseCreation(context, input) {
      return {
        householdId: context.householdId,
        createdBy: input.createdBy,
        paidByMemberId: input.paidByMemberId,
        categoryId: input.categoryId ?? null,
        receiptId: input.receiptId ?? null,
        merchant: input.merchant ?? null,
        totalAmount: input.totalAmount,
        expenseDate: input.expenseDate,
        description: input.description ?? null,
        source: input.source,
        items: input.items ?? [],
        distributions: input.splits.map((split) => ({
          householdMemberId: split.householdMemberId,
          amount: (input.totalAmount * split.percentage) / 100,
          percentage: split.percentage,
        })),
      };
    },
    async getExpenseById(context, expenseId) {
      if (hydrationFailure) {
        throw new expenseDomainErrorClass(
          "CREATED_NOT_HYDRATED",
          "created but not hydrated",
        );
      }
      return { id: expenseId };
    },
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
    async prepareIncomeCreation(context, input) {
      return {
        ...input,
        householdId: context.householdId,
        createdBy: context.memberId,
        categoryId: input.categoryId ?? null,
      };
    },
    async getIncomeById(context, incomeId) {
      return { id: incomeId };
    },
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
        { id: "category-salud", name: "Salud" },
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
  const pendingProposalRepository = load(pendingProposalRepositoryModule);
  const tool = load(toolModule);
  const conversation = load(conversationModule);
  const createIncome = load(incomeToolModule);
  const getExpenses = load(getExpensesToolModule);
  const getIncomes = load(getIncomesToolModule);
  const getBalance = load(getBalanceToolModule);
  const getCategories = load(getCategoriesToolModule);
  const getSharingRules = load(getSharingRulesToolModule);

  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const previousFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-only-openai-key";
  const ambiguousModelOutput = {
    kind: "AMBIGUOUS_MOVEMENT",
    merchant: "Éxito",
    description: null,
    totalAmount: "50000",
    expenseDate: null,
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: null,
    amount: null,
    date: null,
    incomeDate: null,
    incomeDescription: null,
    correctionField: null,
    correctionValue: null,
    filters: null,
  };
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        output_text: JSON.stringify(ambiguousModelOutput),
      };
    },
  });
  try {
    const realOpenAIAdapter = createLoader()(openaiAdapterModule);
    const ambiguousCases = [
      { amount: "50000", totalAmount: null, expectedAmount: "50000" },
      { amount: null, totalAmount: "50000", expectedAmount: "50000" },
      {
        amount: "50000",
        totalAmount: "60000",
        expectedAmount: "50000",
      },
      { amount: null, totalAmount: null, expectedError: true },
    ];
    for (const testCase of ambiguousCases) {
      ambiguousModelOutput.amount = testCase.amount;
      ambiguousModelOutput.totalAmount = testCase.totalAmount;
      if (testCase.expectedError) {
        await assert.rejects(
          () =>
            realOpenAIAdapter.interpretExpenseMessage(
              "Registra un movimiento",
            ),
          (error) => error?.code === "INTERPRETATION_ERROR",
        );
        const beforeInvalidDraftCount = categoryDrafts.length;
        const invalidResult = await conversation.processAgentMessage(
          {
            ...contextA,
            conversationKey: "agent-invalid-ambiguous",
          },
          { message: "Registra un movimiento" },
          realOpenAIAdapter.interpretExpenseMessage,
        );
        assert.equal(invalidResult.type, "ERROR");
        assert.equal(categoryDrafts.length, beforeInvalidDraftCount);
        continue;
      }
      const ambiguousInterpretation =
        await realOpenAIAdapter.interpretExpenseMessage(
          "Registra 50000 en Éxito",
        );
      assert.equal(ambiguousInterpretation.kind, "AMBIGUOUS_MOVEMENT");
      assert.equal(ambiguousInterpretation.amount, testCase.expectedAmount);
      assert.equal(ambiguousInterpretation.merchant, "Éxito");
    }
    console.log("PASS ambiguous OpenAI amount matrix");

    const incomeModelOutput = {
      kind: "CREATE_INCOME",
      amount: "3000000",
      incomeDate: "2026-08-16",
      description: null,
      incomeDescription: "Salario",
      categoryName: "Salario",
      merchant: null,
      totalAmount: null,
      expenseDate: null,
      paidBySelf: null,
      paidByMemberName: null,
      date: null,
      correctionField: null,
      correctionValue: null,
      filters: null,
    };
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { output_text: JSON.stringify(incomeModelOutput) };
      },
    });
    const incomeDescriptionCases = [
      {
        description: null,
        incomeDescription: "Salario",
        expectedDescription: "Salario",
      },
      {
        description: "Salario",
        incomeDescription: null,
        expectedDescription: "Salario",
      },
      {
        description: "Descripción A",
        incomeDescription: "Descripción B",
        expectedDescription: "Descripción B",
      },
      {
        description: "Salario",
        incomeDescription: "",
        expectedDescription: "Salario",
      },
      {
        description: null,
        incomeDescription: null,
        expectedDescription: null,
      },
    ];
    for (const testCase of incomeDescriptionCases) {
      incomeModelOutput.description = testCase.description;
      incomeModelOutput.incomeDescription = testCase.incomeDescription;
      const incomeInterpretation =
        await realOpenAIAdapter.interpretExpenseMessage(
          "Recibí un salario de 3000000",
        );
      assert.equal(incomeInterpretation.kind, "CREATE_INCOME");
      assert.equal(incomeInterpretation.amount, "3000000");
      assert.equal(
        incomeInterpretation.description,
        testCase.expectedDescription,
      );
    }
    console.log(
      "PASS CREATE_INCOME description fields normalize to the internal contract",
    );

    const semanticRecognitionCases = [
      ["Gasté 70000 en comida", "CREATE_EXPENSE"],
      ["Pagué 70000 en comida", "CREATE_EXPENSE"],
      ["Fueron 70000 en comida", "CREATE_EXPENSE"],
      ["Hoy gasté 70000 en comida", "CREATE_EXPENSE"],
      ["Recibí 3000000 de salario", "CREATE_INCOME"],
      ["Hoy recibí 3000000 de salario", "CREATE_INCOME"],
      ["Me consignaron 3000000 por salario", "CREATE_INCOME"],
      ["Recibí un salario de 3000000", "CREATE_INCOME"],
      ["Me consignaron 3000000", "CREATE_INCOME"],
      ["Recibí honorarios", "CREATE_INCOME"],
      ["Entró un ingreso de 500000", "CREATE_INCOME"],
      ["Me pagaron 800000", "CREATE_INCOME"],
      ["Recibí mi sueldo", "CREATE_INCOME"],
      ["Me consignaron la nómina", "CREATE_INCOME"],
      ["Gasté 50000", "CREATE_EXPENSE"],
      ["Pagué 50000", "CREATE_EXPENSE"],
      ["Compré comida por 50000", "CREATE_EXPENSE"],
      ["Registra 50000", "AMBIGUOUS_MOVEMENT"],
      ["Anota 50000", "AMBIGUOUS_MOVEMENT"],
      ["Agrega 50000", "AMBIGUOUS_MOVEMENT"],
    ];
    global.fetch = async (_url, request) => {
      const body = JSON.parse(request.body);
      const userMessage = body.input.find(({ role }) => role === "user")
        ?.content?.[0]?.text;
      const testCase = semanticRecognitionCases.find(
        ([message]) => message === userMessage,
      );
      assert.ok(testCase, `Unexpected semantic recognition message: ${userMessage}`);
      const [, kind] = testCase;
      const output = {
        ...incomeModelOutput,
        kind,
        amount:
          kind === "CREATE_INCOME" && /\d/.test(userMessage)
            ? "3000000"
            : null,
        totalAmount:
          kind === "CREATE_EXPENSE" || kind === "AMBIGUOUS_MOVEMENT"
            ? "50000"
            : null,
        incomeDate: null,
        incomeDescription: null,
        correctionField: null,
        correctionValue: null,
        description: null,
        merchant: kind === "CREATE_EXPENSE" ? "Comercio" : null,
        expenseDate: null,
        paidBySelf: kind === "CREATE_EXPENSE" ? true : null,
        paidByMemberName: null,
        categoryName: null,
        date: null,
        filters: null,
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return { output_text: JSON.stringify(output) };
        },
      };
    };
    for (const [message, expectedKind] of semanticRecognitionCases) {
      const interpretation =
        await realOpenAIAdapter.interpretExpenseMessage(message);
      assert.equal(interpretation.kind, expectedKind);
      if (expectedKind === "CREATE_INCOME" && !/\d/.test(message)) {
        assert.equal(interpretation.amount, null);
      }
    }
    console.log(
      "PASS semantic Income, Expense and ambiguous movement recognition matrix",
    );

    const correctionCases = [
      ["No, fueron 70000", "amount", "70000"],
      ["En realidad fueron 70000", "amount", "70000"],
      ["Corrige el monto a 70000", "amount", "70000"],
      ["No, fue ayer", "date", "ayer"],
      ["No, era mercado", "description", "mercado"],
      ["No, era comida", "category", "comida"],
      ["La categoría correcta es transporte", "category", "transporte"],
      ["No, pagó Alejandra", "payer", "Alejandra"],
    ];
    const nonCorrectionMessages = [
      "No",
      "No gracias",
      "rechazo",
      "rechazar",
      "cancelar",
      "cancela eso",
      "cancelo",
      "70000",
      "Ayer",
      "Comida",
      "No, fueron 70000 y fue ayer",
      "No, era mercado y pagó Alejandra",
    ];
    const correctionByMessage = new Map(
      correctionCases.map(([message, field, value]) => [
        message,
        { field, value },
      ]),
    );
    global.fetch = async (_url, request) => {
      const body = JSON.parse(request.body);
      const userMessage = body.input.find(({ role }) => role === "user")
        ?.content?.[0]?.text;
      const correction = correctionByMessage.get(userMessage);
      const output = {
        ...incomeModelOutput,
        kind: correction ? "CORRECTION" : "UNSUPPORTED",
        correctionField: correction?.field ?? null,
        correctionValue: correction?.value ?? null,
        amount: null,
        totalAmount: null,
        incomeDate: null,
        incomeDescription: null,
        description: null,
        merchant: null,
        expenseDate: null,
        paidBySelf: null,
        paidByMemberName: null,
        categoryName: null,
        date: null,
        filters: null,
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return { output_text: JSON.stringify(output) };
        },
      };
    };
    for (const [message, field, value] of correctionCases) {
      const interpretation =
        await realOpenAIAdapter.interpretExpenseMessage(message);
      assert.deepEqual(interpretation, {
        kind: "CORRECTION",
        field,
        value,
      });
    }
    for (const message of nonCorrectionMessages) {
      const interpretation =
        await realOpenAIAdapter.interpretExpenseMessage(message);
      assert.notEqual(interpretation.kind, "CORRECTION");
    }
    console.log("PASS correction contract and rejection distinction");

    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          output_text: JSON.stringify({
            ...incomeModelOutput,
            kind: "CORRECTION",
            correctionField: "amount",
            correctionValue: "   ",
          }),
        };
      },
    });
    await assert.rejects(
      () => realOpenAIAdapter.interpretExpenseMessage("No, fueron"),
      (error) => error?.code === "INTERPRETATION_ERROR",
    );
    console.log("PASS empty correction values are rejected");

    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          output_text: JSON.stringify({
            ...incomeModelOutput,
            kind: "CREATE_EXPENSE",
            correctionField: "amount",
            correctionValue: "70000",
          }),
        };
      },
    });
    await assert.rejects(
      () => realOpenAIAdapter.interpretExpenseMessage("Pagué 70000"),
      (error) => error?.code === "INTERPRETATION_ERROR",
    );
    console.log("PASS non-correction outputs cannot carry correction fields");
  } finally {
    global.fetch = previousFetch;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
  }

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
  assert.ok(agentSource.includes("prepareExpenseCreation"));
  assert.ok(agentSource.includes("confirmPendingExpense"));
  console.log("PASS create_expense Tool has no direct persistence access");

  const proposal = await tool.createExpenseTool(contextA, expenseInput);
  assert.equal(proposal.status, "AWAITING_CONFIRMATION");
  assert.equal(
    proposals.filter(
      (row) =>
        row.status === "AWAITING_CONFIRMATION" &&
        row.household_id === contextA.householdId &&
        row.conversation_key === contextA.conversationKey,
    ).length,
    1,
  );
  console.log("PASS valid intent creates a PendingProposal");

  const pending = await agentService.getExpenseProposal(
    contextA,
    proposal.proposalId,
  );
  assert.equal(pending.payload.actorMemberId, memberA);
  assert.equal(pending.householdId, householdA);
  console.log("PASS pending proposal is retrieved with controlled ownership");

  const conditionalContext = {
    ...contextA,
    conversationKey: "agent-conditional-proposal",
  };
  const conditionalCreated = await tool.createExpenseTool(
    conditionalContext,
    {
      ...expenseInput,
      description: "Original conditional proposal",
    },
  );
  const conditionalBefore = await pendingProposalRepository.findPendingProposal(
    conditionalCreated.proposalId,
    conditionalContext.householdId,
    conditionalContext.conversationKey,
  );
  assert.ok(conditionalBefore);
  const financialWritesBeforeConditionalUpdate = createdExpenses.length;
  const updatedPayload = {
    ...conditionalBefore.payload,
    expense: {
      ...conditionalBefore.payload.expense,
      totalAmount: 200,
      description: "Updated conditional proposal",
    },
  };
  const updatedConditional =
    await pendingProposalRepository.updatePendingProposalConditionally({
      id: conditionalBefore.id,
      householdId: conditionalContext.householdId,
      conversationKey: conditionalContext.conversationKey,
      operationType: "CREATE_EXPENSE",
      payload: updatedPayload,
      expectedUpdatedAt: conditionalBefore.updatedAt,
    });
  assert.ok(updatedConditional);
  assert.equal(updatedConditional.id, conditionalBefore.id);
  assert.notEqual(updatedConditional.updatedAt, conditionalBefore.updatedAt);
  assert.equal(updatedConditional.operationType, "CREATE_EXPENSE");
  assert.equal(updatedConditional.status, "AWAITING_CONFIRMATION");
  assert.equal(updatedConditional.payload.expense.totalAmount, 200);
  assert.equal(
    updatedConditional.payload.expense.description,
    "Updated conditional proposal",
  );
  assert.equal(
    updatedConditional.payload.actorMemberId,
    conditionalBefore.payload.actorMemberId,
  );
  assert.equal(
    updatedConditional.payload.source,
    conditionalBefore.payload.source,
  );
  assert.equal(
    updatedConditional.payload.expense.paidByMemberId,
    conditionalBefore.payload.expense.paidByMemberId,
  );
  assert.equal(
    updatedConditional.payload.expense.expenseDate,
    conditionalBefore.payload.expense.expenseDate,
  );
  assert.deepEqual(
    updatedConditional.payload.expense.splits,
    conditionalBefore.payload.expense.splits,
  );
  console.log("PASS conditional PendingProposal update preserves identity and fields");

  const updateAttempt = {
    id: updatedConditional.id,
    householdId: conditionalContext.householdId,
    conversationKey: conditionalContext.conversationKey,
    operationType: "CREATE_EXPENSE",
    payload: updatedConditional.payload,
    expectedUpdatedAt: updatedConditional.updatedAt,
  };
  for (const invalidAttempt of [
    { ...updateAttempt, householdId: householdB },
    { ...updateAttempt, conversationKey: "other-conversation" },
    { ...updateAttempt, operationType: "CREATE_INCOME" },
    { ...updateAttempt, id: "42000000-0000-4000-8000-000000009999" },
  ]) {
    const result =
      await pendingProposalRepository.updatePendingProposalConditionally(
        invalidAttempt,
      );
    assert.equal(result, null);
  }
  const conditionalRow = proposals.find(
    (row) => row.id === updatedConditional.id,
  );
  assert.ok(conditionalRow);
  const statusBeforeInvalidAttempt = conditionalRow.status;
  conditionalRow.status = "REJECTED";
  const inactiveResult =
    await pendingProposalRepository.updatePendingProposalConditionally(
      updateAttempt,
    );
  assert.equal(inactiveResult, null);
  conditionalRow.status = statusBeforeInvalidAttempt;
  console.log("PASS PendingProposal update enforces ownership, operation and status");

  const staleResult =
    await pendingProposalRepository.updatePendingProposalConditionally({
      ...updateAttempt,
      payload: {
        ...updateAttempt.payload,
        expense: {
          ...updateAttempt.payload.expense,
          totalAmount: 999,
        },
      },
      expectedUpdatedAt: conditionalBefore.updatedAt,
    });
  assert.equal(staleResult, null);
  const conditionalAfterStaleAttempt =
    await pendingProposalRepository.findPendingProposal(
      conditionalBefore.id,
      conditionalContext.householdId,
      conditionalContext.conversationKey,
    );
  assert.ok(conditionalAfterStaleAttempt);
  assert.equal(conditionalAfterStaleAttempt.payload.expense.totalAmount, 200);
  assert.equal(createdExpenses.length, financialWritesBeforeConditionalUpdate);
  console.log("PASS stale PendingProposal update is rejected without financial writes");
  proposals = proposals.filter((row) => row.id !== conditionalBefore.id);

  const conditionalIncomeContext = {
    ...contextA,
    conversationKey: "agent-conditional-income-proposal",
  };
  const conditionalIncomeCreated = await agentService.createIncomeProposal(
    conditionalIncomeContext,
    {
      memberId: memberA,
      amount: 300,
      incomeDate: "2026-08-12",
      description: "Original conditional income",
      categoryId: null,
    },
  );
  const conditionalIncomeBefore =
    await pendingProposalRepository.findPendingIncomeProposal(
      conditionalIncomeCreated.proposalId,
      conditionalIncomeContext.householdId,
      conditionalIncomeContext.conversationKey,
    );
  assert.ok(conditionalIncomeBefore);
  const updatedIncomePayload = {
    ...conditionalIncomeBefore.payload,
    income: {
      ...conditionalIncomeBefore.payload.income,
      description: "Updated conditional income",
    },
  };
  const updatedConditionalIncome =
    await pendingProposalRepository.updatePendingProposalConditionally({
      id: conditionalIncomeBefore.id,
      householdId: conditionalIncomeContext.householdId,
      conversationKey: conditionalIncomeContext.conversationKey,
      operationType: "CREATE_INCOME",
      payload: updatedIncomePayload,
      expectedUpdatedAt: conditionalIncomeBefore.updatedAt,
    });
  assert.ok(updatedConditionalIncome);
  assert.equal(updatedConditionalIncome.id, conditionalIncomeBefore.id);
  assert.notEqual(
    updatedConditionalIncome.updatedAt,
    conditionalIncomeBefore.updatedAt,
  );
  assert.equal(updatedConditionalIncome.operationType, "CREATE_INCOME");
  assert.equal(updatedConditionalIncome.status, "AWAITING_CONFIRMATION");
  assert.equal(
    updatedConditionalIncome.payload.income.description,
    "Updated conditional income",
  );
  assert.equal(
    updatedConditionalIncome.payload.income.memberId,
    conditionalIncomeBefore.payload.income.memberId,
  );
  assert.equal(
    updatedConditionalIncome.payload.income.amount,
    conditionalIncomeBefore.payload.income.amount,
  );
  assert.equal(
    updatedConditionalIncome.payload.income.incomeDate,
    conditionalIncomeBefore.payload.income.incomeDate,
  );
  assert.equal(
    updatedConditionalIncome.payload.income.categoryId,
    conditionalIncomeBefore.payload.income.categoryId,
  );
  proposals = proposals.filter((row) => row.id !== conditionalIncomeBefore.id);
  console.log("PASS conditional PendingProposal update supports CREATE_INCOME");

  const confirmed = await tool.confirmCreateExpenseTool(
    contextA,
    proposal.proposalId,
  );
  assert.equal(confirmed.status, "CONFIRMED");
  assert.equal(createdExpenses.length, 1);
  assert.equal(createdExpenses[0].context.householdId, householdA);
  assert.equal(createdExpenses[0].input.createdBy, memberA);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, "COMPLETED");
  assert.equal(proposals[0].expense_id, confirmed.expenseId);
  assert.equal(typeof proposals[0].resolved_at, "string");
  assert.equal(proposals[0].income_id, null);
  console.log(
    "PASS confirmation creates Expense and marks proposal COMPLETED",
  );

  const repeatedConfirmation = await tool.confirmCreateExpenseTool(
    contextA,
    proposal.proposalId,
  );
  assert.equal(repeatedConfirmation.status, "CONFIRMED");
  assert.equal(repeatedConfirmation.expenseId, confirmed.expenseId);
  assert.equal(createdExpenses.length, 1);
  console.log("PASS repeated confirmation reuses the same Expense");

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
  const hydratedRetry = await tool.confirmCreateExpenseTool(
    contextA,
    hydrationProposal.proposalId,
  );
  assert.equal(hydratedRetry.status, "CONFIRMED");
  assert.equal(hydratedRetry.expenseId, "expense-2");
  assert.equal(createdExpenses.length, 2);
  console.log("PASS created-but-not-hydrated confirmation is idempotently retried");

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
  assert.equal(
    proposals.some((row) => row.id === rejectedProposal.proposalId),
    false,
  );
  console.log("PASS rejection consumes proposal without creating Expense");

  const rejectedTerminalProposal = {
    id: "62000000-0000-4000-8000-000000000099",
    household_id: householdA,
    conversation_key: contextA.conversationKey,
    operation_type: "CREATE_EXPENSE",
    status: "REJECTED",
    payload: {
      actorMemberId: memberA,
      source: "WEB",
      expense: expenseInput,
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
    resolved_at: "2026-08-12T12:01:00.000Z",
    expense_id: null,
    income_id: null,
  };
  proposals.push(rejectedTerminalProposal);
  const rejectedTerminalResult = await tool.confirmCreateExpenseTool(
    contextA,
    rejectedTerminalProposal.id,
  );
  assert.equal(rejectedTerminalResult.status, "REJECTED");
  assert.equal(createdExpenses.length, 2);
  console.log("PASS rejected terminal proposal does not create an Expense");

  const invalidOperationProposal = {
    ...rejectedTerminalProposal,
    id: "62000000-0000-4000-8000-000000000098",
    conversation_key: "agent-terminal-invalid-operation",
    operation_type: "CREATE_INCOME",
    status: "AWAITING_CONFIRMATION",
    resolved_at: null,
  };
  proposals.push(invalidOperationProposal);
  await expectAgentError(
    tool.confirmCreateExpenseTool(
      { ...contextA, conversationKey: invalidOperationProposal.conversation_key },
      invalidOperationProposal.id,
    ),
    "PROPOSAL_NOT_AVAILABLE",
  );
  assert.equal(createdExpenses.length, 2);
  console.log("PASS invalid operation does not create an Expense");

  await expectAgentError(
    tool.confirmCreateExpenseTool(
      contextA,
      "62000000-0000-4000-8000-000000000097",
    ),
    "PROPOSAL_NOT_AVAILABLE",
  );
  assert.equal(createdExpenses.length, 2);
  console.log("PASS missing proposal does not create an Expense");

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
  assert.equal(
    proposals.filter(
      (row) =>
        row.status === "AWAITING_CONFIRMATION" &&
        row.household_id === contextA.householdId &&
        row.conversation_key === contextA.conversationKey,
    ).length,
    1,
  );
  console.log("PASS concurrent proposal for one conversation is rejected");

  assert.equal(
    operations.filter(
      ({ type, table }) =>
        type === "from" &&
        !["tb_pending_proposals", "tb_agent_category_drafts"].includes(table),
    ).length,
    0,
  );
  assert.ok(
    operations.some(
      ({ type, name }) => type === "rpc" && name === "fn_confirm_pending_expense",
    ),
  );
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
  const repeatedNaturalConfirmation = await conversation.processAgentMessage(
    naturalContext,
    {
      message: "sí",
      proposalId: naturalProposal.proposalId,
    },
  );
  assert.equal(repeatedNaturalConfirmation.type, "CONFIRMED");
  assert.equal(repeatedNaturalConfirmation.expenseId, naturalConfirmed.expenseId);
  assert.equal(createdExpenses.length, 3);
  console.log("PASS explicit confirmation reuses the existing Expense");

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

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Correction-like Category Market",
    description: null,
    totalAmount: "101",
    expenseDate: "2026-08-16",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: null,
  };
  const correctionLikeCategoryContext = {
    ...contextA,
    conversationKey: "agent-correction-like-category-draft",
  };
  await conversation.processAgentMessage(correctionLikeCategoryContext, {
    message: "Registra un gasto de 101 en Correction-like Category Market",
  });
  const correctionLikeCategory = await conversation.processAgentMessage(
    correctionLikeCategoryContext,
    { message: "Fueron 70000" },
    async () => {
      throw new Error("OpenAI must not receive category draft selections");
    },
  );
  assert.equal(correctionLikeCategory.type, "CLARIFICATION_REQUIRED");
  assert.match(correctionLikeCategory.message, /categoría/);
  assert.equal(
    categoryDrafts.find(
      (row) => row.conversation_key === correctionLikeCategoryContext.conversationKey,
    ).status,
    "AWAITING_CATEGORY",
  );
  await conversation.processAgentMessage(correctionLikeCategoryContext, {
    message: "cancelar",
  });
  console.log("PASS correction-like input continues AWAITING_CATEGORY draft");

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

  const beforeAmbiguousMovementExpenses = createdExpenses.length;
  const beforeAmbiguousMovementIncomes = createdIncomes.length;
  mockInterpretation = {
    kind: "AMBIGUOUS_MOVEMENT",
    amount: "50000",
    date: null,
    merchant: "Éxito",
    description: "mercado de la semana",
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: null,
  };
  const ambiguousMovementContext = {
    ...contextA,
    conversationKey: "agent-ambiguous-movement",
  };
  const ambiguousMovement = await conversation.processAgentMessage(
    ambiguousMovementContext,
    {
      message: "Registra 50000 en Éxito. Descripción: mercado de la semana.",
    },
  );
  assert.equal(ambiguousMovement.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(ambiguousMovement.missingFields, ["operation"]);
  assert.equal(
    ambiguousMovement.message,
    "¿Quieres registrar un gasto o un ingreso?",
  );
  const operationDraft = categoryDrafts.find(
    (row) => row.conversation_key === ambiguousMovementContext.conversationKey,
  );
  assert.ok(operationDraft);
  assert.equal(operationDraft.status, "AWAITING_OPERATION");
  assert.equal(operationDraft.operation_type, null);
  assert.deepEqual(Object.keys(operationDraft.payload).sort(), [
    "amount",
    "categoryName",
    "date",
    "description",
    "merchant",
    "paidByMemberName",
    "paidBySelf",
  ]);
  assert.equal(operationDraft.payload.amount, "50000");
  assert.equal(operationDraft.payload.merchant, "Éxito");
  assert.ok(!JSON.stringify(operationDraft.payload).includes("Registra"));
  assert.equal(createdExpenses.length, beforeAmbiguousMovementExpenses);
  assert.equal(createdIncomes.length, beforeAmbiguousMovementIncomes);
  console.log(
    "PASS ambiguous registration persists operation choice without financial persistence",
  );

  const beforeCategoryResolutionCalls = operations.length;
  const expenseOperationChoice = await conversation.processAgentMessage(
    ambiguousMovementContext,
    { message: "gasto" },
    async () => {
      throw new Error("OpenAI must not receive operation choices");
    },
  );
  assert.equal(expenseOperationChoice.type, "CLARIFICATION_REQUIRED");
  assert.equal(operationDraft.status, "AWAITING_CATEGORY");
  assert.equal(operationDraft.operation_type, "CREATE_EXPENSE");
  assert.equal("actorMemberId" in operationDraft.payload, false);
  assert.equal("source" in operationDraft.payload, false);
  assert.equal("splits" in operationDraft.payload.expense, false);
  assert.equal(createdExpenses.length, beforeAmbiguousMovementExpenses);
  assert.equal(createdIncomes.length, beforeAmbiguousMovementIncomes);
  assert.ok(operations.length > beforeCategoryResolutionCalls);
  console.log("PASS gasto resolves the persisted operation without OpenAI");

  const expenseCategoryProposal = await conversation.processAgentMessage(
    ambiguousMovementContext,
    { message: "Food" },
  );
  assert.equal(expenseCategoryProposal.type, "PROPOSAL_CREATED");
  assert.equal(
    proposals.at(-1).payload.expense.totalAmount,
    50000,
  );
  assert.equal(proposals.at(-1).payload.expense.merchant, "Éxito");
  assert.equal(createdExpenses.length, beforeAmbiguousMovementExpenses);
  const expenseCategoryConfirmation = await conversation.processAgentMessage(
    ambiguousMovementContext,
    { message: "si" },
  );
  assert.equal(expenseCategoryConfirmation.type, "CONFIRMED");
  assert.equal(createdExpenses.length, beforeAmbiguousMovementExpenses + 1);
  assert.deepEqual(createdExpenses.at(-1).input.splits, [
    { householdMemberId: memberA, percentage: 100 },
  ]);
  console.log("PASS ambiguous expense reaches proposal and confirms once");

  mockInterpretation = {
    kind: "AMBIGUOUS_MOVEMENT",
    amount: "50000",
    date: null,
    merchant: "Éxito",
    description: null,
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: null,
  };
  const incomeOperationContext = {
    ...contextA,
    conversationKey: "agent-ambiguous-income",
  };
  const beforeAmbiguousIncomeCount = createdIncomes.length;
  const incomeAmbiguous = await conversation.processAgentMessage(
    incomeOperationContext,
    { message: "Registra 50000 en Éxito" },
  );
  assert.equal(incomeAmbiguous.type, "CLARIFICATION_REQUIRED");
  const incomeOperationDraft = categoryDrafts.find(
    (row) => row.conversation_key === incomeOperationContext.conversationKey,
  );
  assert.equal(incomeOperationDraft.status, "AWAITING_OPERATION");
  const incomeChoice = await conversation.processAgentMessage(
    incomeOperationContext,
    { message: "ingreso" },
    async () => {
      throw new Error("OpenAI must not receive operation choices");
    },
  );
  assert.equal(incomeChoice.type, "CLARIFICATION_REQUIRED");
  assert.equal(incomeOperationDraft.payload.amount, "50000");
  assert.deepEqual(incomeChoice.missingFields, ["incomeDate", "description"]);
  assert.equal(incomeOperationDraft.status, "AWAITING_DETAILS");
  assert.equal(incomeOperationDraft.operation_type, "CREATE_INCOME");
  const prematureIncomeConfirmation = await conversation.processAgentMessage(
    incomeOperationContext,
    { message: "sí" },
    async () => {
      throw new Error("OpenAI must not receive premature confirmations");
    },
  );
  assert.equal(prematureIncomeConfirmation.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(prematureIncomeConfirmation.missingFields, [
    "incomeDate",
    "description",
  ]);
  assert.match(prematureIncomeConfirmation.message, /fecha del ingreso/);
  assert.match(prematureIncomeConfirmation.message, /descripción del ingreso/);
  console.log("PASS premature confirmation reports the actual missing fields");
  const incomeDraftAmountBeforeNewRequest = incomeOperationDraft.payload.amount;
  const incomeNewRequestReply = await conversation.processAgentMessage(
    incomeOperationContext,
    { message: "Registra 30000 en Carulla" },
    async () => {
      throw new Error("OpenAI must not receive a new request while details are pending");
    },
  );
  assert.equal(incomeNewRequestReply.type, "CLARIFICATION_REQUIRED");
  assert.equal(incomeOperationDraft.status, "AWAITING_DETAILS");
  assert.equal(incomeOperationDraft.payload.amount, incomeDraftAmountBeforeNewRequest);
  for (const newRequest of ["Gasté 30000 en Carulla", "Recibí 200000"]) {
    const protectedReply = await conversation.processAgentMessage(
      incomeOperationContext,
      { message: newRequest },
      async () => {
        throw new Error("OpenAI must not receive a new request while details are pending");
      },
    );
    assert.equal(protectedReply.type, "CLARIFICATION_REQUIRED");
    assert.equal(incomeOperationDraft.status, "AWAITING_DETAILS");
    assert.equal(
      incomeOperationDraft.payload.amount,
      incomeDraftAmountBeforeNewRequest,
    );
  }
  console.log("PASS active details drafts are not overwritten by new requests");
  const incomeDetails = await conversation.processAgentMessage(
    incomeOperationContext,
    {
      message: "fecha: 2026-08-16; descripción: ingreso por trabajo",
    },
    async () => {
      throw new Error("OpenAI must not receive persisted details");
    },
  );
  assert.equal(incomeDetails.type, "CLARIFICATION_REQUIRED");
  assert.equal(incomeOperationDraft.status, "AWAITING_CATEGORY");
  assert.equal("memberId" in incomeOperationDraft.payload.income, false);
  const incomeDraftProposal = await conversation.processAgentMessage(
    incomeOperationContext,
    { message: "Food" },
  );
  assert.equal(incomeDraftProposal.type, "PROPOSAL_CREATED");
  assert.equal(createdIncomes.length, beforeAmbiguousIncomeCount);
  assert.equal("memberId" in incomeOperationDraft.payload.income, false);
  const incomeDraftConfirmation = await conversation.processAgentMessage(
    incomeOperationContext,
    { message: "si" },
  );
  assert.equal(incomeDraftConfirmation.type, "CONFIRMED");
  assert.equal(createdIncomes.length, beforeAmbiguousIncomeCount + 1);
  assert.equal(createdIncomes.at(-1).input.memberId, memberA);
  console.log(
    "PASS ambiguous income persists details, category and confirmation flow",
  );

  mockInterpretation = {
    kind: "AMBIGUOUS_MOVEMENT",
    amount: "120",
    date: "2026-08-16",
    merchant: "Carulla",
    description: null,
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: null,
  };
  const plainDescriptionContext = {
    ...contextA,
    conversationKey: "agent-plain-description-detail",
  };
  await conversation.processAgentMessage(plainDescriptionContext, {
    message: "Registra 120 en Carulla",
  });
  const plainDescriptionChoice = await conversation.processAgentMessage(
    plainDescriptionContext,
    { message: "ingreso" },
  );
  assert.deepEqual(plainDescriptionChoice.missingFields, ["description"]);
  const plainDescriptionResult = await conversation.processAgentMessage(
    plainDescriptionContext,
    { message: "mercado" },
    async () => {
      throw new Error("OpenAI must not receive plain details");
    },
  );
  assert.equal(plainDescriptionResult.type, "CLARIFICATION_REQUIRED");
  assert.equal(
    categoryDrafts.find(
      (row) => row.conversation_key === plainDescriptionContext.conversationKey,
    ).status,
    "AWAITING_CATEGORY",
  );
  await conversation.processAgentMessage(plainDescriptionContext, {
    message: "cancelar",
  });

  mockInterpretation = {
    kind: "AMBIGUOUS_MOVEMENT",
    amount: "121",
    date: null,
    merchant: "Carulla",
    description: "nómina",
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: null,
  };
  const plainDateContext = {
    ...contextA,
    conversationKey: "agent-plain-date-detail",
  };
  await conversation.processAgentMessage(plainDateContext, {
    message: "Registra 121 en Carulla",
  });
  const plainDateChoice = await conversation.processAgentMessage(
    plainDateContext,
    { message: "ingreso" },
  );
  assert.deepEqual(plainDateChoice.missingFields, ["incomeDate"]);
  const plainDateResult = await conversation.processAgentMessage(
    plainDateContext,
    { message: "hoy" },
    async () => {
      throw new Error("OpenAI must not receive plain dates");
    },
  );
  assert.equal(plainDateResult.type, "CLARIFICATION_REQUIRED");
  const plainDateDraft = categoryDrafts.find(
    (row) => row.conversation_key === plainDateContext.conversationKey,
  );
  assert.equal(plainDateDraft.status, "AWAITING_CATEGORY");
  assert.equal(
    plainDateDraft.payload.income.incomeDate,
    new Date().toISOString().slice(0, 10),
  );
  await conversation.processAgentMessage(plainDateContext, {
    message: "cancelar",
  });
  console.log("PASS plain description and natural date details continue drafts");

  mockInterpretation = {
    kind: "AMBIGUOUS_MOVEMENT",
    amount: "100",
    date: null,
    merchant: "Prueba",
    description: null,
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: null,
  };
  const ambiguousReplyContext = {
    ...contextA,
    conversationKey: "agent-ambiguous-reply",
  };
  await conversation.processAgentMessage(ambiguousReplyContext, {
    message: "Registra 100 en Prueba",
  });
  const ambiguousReply = await conversation.processAgentMessage(
    ambiguousReplyContext,
    { message: "los dos" },
    async () => {
      throw new Error("OpenAI must not receive ambiguous operation replies");
    },
  );
  assert.equal(ambiguousReply.type, "CLARIFICATION_REQUIRED");
  assert.equal(
    categoryDrafts.find(
      (row) => row.conversation_key === ambiguousReplyContext.conversationKey,
    ).status,
    "AWAITING_OPERATION",
  );
  const dependsReply = await conversation.processAgentMessage(
    ambiguousReplyContext,
    { message: "depende" },
    async () => {
      throw new Error("OpenAI must not receive operation replies");
    },
  );
  assert.equal(dependsReply.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(dependsReply.missingFields, ["operation"]);
  const cancelledOperation = await conversation.processAgentMessage(
    ambiguousReplyContext,
    { message: "cancelar" },
  );
  assert.equal(cancelledOperation.type, "REJECTED");
  assert.equal(
    categoryDrafts.some(
      (row) => row.conversation_key === ambiguousReplyContext.conversationKey,
    ),
    false,
  );
  console.log("PASS ambiguous operation stays pending and can be cancelled");

  mockInterpretation = {
    kind: "AMBIGUOUS_MOVEMENT",
    amount: "102",
    date: "2026-08-16",
    merchant: "Correction-like Operation Market",
    description: null,
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: null,
  };
  const correctionLikeOperationContext = {
    ...contextA,
    conversationKey: "agent-correction-like-operation-draft",
  };
  await conversation.processAgentMessage(correctionLikeOperationContext, {
    message: "Registra 102 en Correction-like Operation Market",
  });
  const correctionLikeOperation = await conversation.processAgentMessage(
    correctionLikeOperationContext,
    { message: "Fueron 70000" },
    async () => {
      throw new Error("OpenAI must not receive operation draft selections");
    },
  );
  assert.equal(correctionLikeOperation.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(correctionLikeOperation.missingFields, ["operation"]);
  assert.equal(
    categoryDrafts.find(
      (row) => row.conversation_key === correctionLikeOperationContext.conversationKey,
    ).status,
    "AWAITING_OPERATION",
  );
  await conversation.processAgentMessage(correctionLikeOperationContext, {
    message: "cancelar",
  });
  console.log("PASS correction-like input continues AWAITING_OPERATION draft");

  const expiryContext = {
    ...contextA,
    conversationKey: "agent-operation-expiry",
  };
  await conversation.processAgentMessage(expiryContext, {
    message: "Registra 100 en Expirado",
  });
  const expiredDraft = categoryDrafts.find(
    (row) => row.conversation_key === expiryContext.conversationKey,
  );
  expiredDraft.updated_at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const expiredReply = await conversation.processAgentMessage(
    expiryContext,
    { message: "gasto" },
    async () => ({ kind: "UNSUPPORTED" }),
  );
  assert.equal(expiredReply.type, "UNSUPPORTED");
  assert.equal(
    categoryDrafts.some(
      (row) => row.conversation_key === expiryContext.conversationKey,
    ),
    false,
  );
  console.log("PASS expired operation drafts do not continue");

  const migrationSource = fs.readFileSync(
    path.join(root, "database", "migrations", "0015_extend_agent_draft_states.sql"),
    "utf8",
  );
  assert.match(
    migrationSource,
    /status IN \('AWAITING_DETAILS', 'AWAITING_CATEGORY'\)[\s\S]*operation_type IS NOT NULL/,
  );
  assert.equal(migrationSource.includes("pending_operation_type"), false);
  const stateMatrix = [
    ["AWAITING_OPERATION", null, true],
    ["AWAITING_OPERATION", "CREATE_EXPENSE", false],
    ["AWAITING_OPERATION", "CREATE_INCOME", false],
    ["AWAITING_DETAILS", null, false],
    ["AWAITING_DETAILS", "CREATE_EXPENSE", true],
    ["AWAITING_DETAILS", "CREATE_INCOME", true],
    ["AWAITING_CATEGORY", null, false],
    ["AWAITING_CATEGORY", "CREATE_EXPENSE", true],
    ["AWAITING_CATEGORY", "CREATE_INCOME", true],
  ];
  for (const [status, operationType, valid] of stateMatrix) {
    assert.equal(
      (status === "AWAITING_OPERATION" && operationType === null) ||
        (status !== "AWAITING_OPERATION" &&
          operationType !== null &&
          (operationType === "CREATE_EXPENSE" || operationType === "CREATE_INCOME")),
      valid,
    );
  }
  console.log("PASS migration state matrix is explicit and does not alter pending proposal enums");

  const invalidDraftPayload = {
    amount: "100",
    date: "2026-08-16",
    merchant: "Invalid draft",
    description: null,
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: null,
  };
  const invalidDraftRows = [
    ["AWAITING_OPERATION", "CREATE_EXPENSE"],
    ["AWAITING_OPERATION", "CREATE_INCOME"],
    ["AWAITING_DETAILS", null],
    ["AWAITING_CATEGORY", null],
  ];
  const beforeInvalidDraftExpenses = createdExpenses.length;
  const beforeInvalidDraftIncomes = createdIncomes.length;
  const beforeInvalidDraftProposals = proposals.length;
  for (const [status, operationType] of invalidDraftRows) {
    const invalidContext = {
      ...contextA,
      conversationKey: `agent-invalid-row-${status}-${operationType ?? "null"}`,
    };
    const invalidId = `invalid-${status}-${operationType ?? "null"}`;
    categoryDrafts.push({
      id: invalidId,
      household_id: invalidContext.householdId,
      actor_member_id: invalidContext.actorMemberId,
      conversation_key: invalidContext.conversationKey,
      operation_type: operationType,
      payload: invalidDraftPayload,
      status,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await expectAgentError(
      conversation.processAgentMessage(invalidContext, { message: "test" }),
      "PERSISTENCE_ERROR",
    );
    assert.equal(
      categoryDrafts.some((row) => row.id === invalidId),
      true,
    );
    categoryDrafts = categoryDrafts.filter((row) => row.id !== invalidId);
  }
  assert.equal(createdExpenses.length, beforeInvalidDraftExpenses);
  assert.equal(createdIncomes.length, beforeInvalidDraftIncomes);
  assert.equal(proposals.length, beforeInvalidDraftProposals);
  console.log("PASS invalid persisted draft states fail safely without financial writes");

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Concurrency",
    description: null,
    totalAmount: "100",
    expenseDate: "2026-08-16",
    paidBySelf: true,
    categoryName: null,
  };
  const concurrentDraftContext = {
    ...contextA,
    conversationKey: "agent-draft-concurrency",
  };
  await conversation.processAgentMessage(concurrentDraftContext, {
    message: "Registra 100 en Concurrency",
  });
  const beforeConcurrentProposalCount = proposals.length;
  const concurrentResults = await Promise.allSettled([
    conversation.processAgentMessage(concurrentDraftContext, {
      message: "Categoría inexistente",
    }),
    conversation.processAgentMessage(concurrentDraftContext, {
      message: "Otra categoría inexistente",
    }),
  ]);
  assert.equal(
    concurrentResults.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    concurrentResults.filter((result) => result.status === "rejected").length,
    1,
  );
  const concurrentError = concurrentResults.find(
    (result) => result.status === "rejected",
  ).reason;
  assert.equal(concurrentError.code, "PERSISTENCE_ERROR");
  assert.equal(proposals.length, beforeConcurrentProposalCount);
  assert.equal(
    categoryDrafts.some(
      (row) => row.conversation_key === concurrentDraftContext.conversationKey,
    ),
    true,
  );
  await conversation.processAgentMessage(concurrentDraftContext, {
    message: "cancelar",
  });
  console.log("PASS optimistic draft updates prevent lost concurrent transitions");

  const isolatedOperationContext = {
    ...contextA,
    conversationKey: "agent-operation-isolation",
  };
  await conversation.processAgentMessage(isolatedOperationContext, {
    message: "Registra 100 en Aislado",
  });
  const isolatedOperationReply = await conversation.processAgentMessage(
    { ...isolatedOperationContext, householdId: householdB, actorMemberId: memberB },
    { message: "gasto" },
    async () => ({ kind: "UNSUPPORTED" }),
  );
  assert.equal(isolatedOperationReply.type, "UNSUPPORTED");
  assert.equal(
    categoryDrafts.some(
      (row) => row.conversation_key === isolatedOperationContext.conversationKey,
    ),
    true,
  );
  await conversation.processAgentMessage(isolatedOperationContext, {
    message: "cancelar",
  });
  console.log("PASS operation drafts are isolated by household and actor");

  const pendingNewRequestContext = {
    ...contextA,
    conversationKey: "agent-operation-new-request",
  };
  mockInterpretation = {
    kind: "AMBIGUOUS_MOVEMENT",
    amount: "100",
    date: null,
    merchant: "Pendiente",
    description: null,
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: null,
  };
  await conversation.processAgentMessage(pendingNewRequestContext, {
    message: "Registra 100 en Pendiente",
  });
  const newRequestReply = await conversation.processAgentMessage(
    pendingNewRequestContext,
    { message: "Registra 30000 en Carulla" },
    async () => {
      throw new Error("OpenAI must not receive a new request while draft is active");
    },
  );
  assert.equal(newRequestReply.type, "CLARIFICATION_REQUIRED");
  assert.match(newRequestReply.message, /operación anterior/);
  await conversation.processAgentMessage(pendingNewRequestContext, {
    message: "cancelar",
  });
  console.log("PASS active operation drafts are not overwritten by new requests");

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

  const staleStateContext = {
    ...contextA,
    conversationKey: "agent-stale-draft-proposal",
  };
  const staleDraft = {
    id: "stale-draft-1",
    household_id: staleStateContext.householdId,
    actor_member_id: staleStateContext.actorMemberId,
    conversation_key: staleStateContext.conversationKey,
    operation_type: "CREATE_EXPENSE",
    status: "AWAITING_DETAILS",
    payload: {
      amount: "321",
      date: null,
      merchant: "Stale Market",
      description: null,
      paidBySelf: true,
      paidByMemberName: null,
      categoryName: null,
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  };
  const staleProposal = {
    id: "62000000-0000-4000-8000-000000000001",
    household_id: staleStateContext.householdId,
    conversation_key: staleStateContext.conversationKey,
    operation_type: "CREATE_EXPENSE",
    status: "AWAITING_CONFIRMATION",
    payload: {
      actorMemberId: staleStateContext.actorMemberId,
      source: staleStateContext.source,
      expense: {
        paidByMemberId: staleStateContext.actorMemberId,
        totalAmount: 321,
        expenseDate: "2026-08-12",
        description: "Stale proposal",
        items: [],
        splits: [
          {
            householdMemberId: staleStateContext.actorMemberId,
            percentage: 100,
          },
        ],
      },
    },
    created_at: "2026-08-12T12:00:00.000Z",
    updated_at: "2026-08-12T12:00:00.000Z",
  };
  categoryDrafts.push(staleDraft);
  proposals.push(staleProposal);
  const createdExpensesBeforeStaleRejection = createdExpenses.length;
  const staleRejected = await conversation.processAgentMessage(
    staleStateContext,
    { message: "no" },
  );
  assert.equal(staleRejected.type, "REJECTED");
  assert.equal(
    categoryDrafts.some(
      (row) => row.conversation_key === staleStateContext.conversationKey,
    ),
    false,
  );
  assert.equal(
    proposals.some(
      (row) => row.conversation_key === staleStateContext.conversationKey,
    ),
    false,
  );
  assert.equal(createdExpenses.length, createdExpensesBeforeStaleRejection);
  console.log(
    "PASS rejecting a proposal clears a stale draft in the same conversation",
  );

  categoryDrafts.push(staleDraft);
  proposals.push(staleProposal);
  const createdExpensesBeforeStaleConfirmation = createdExpenses.length;
  const staleConfirmed = await conversation.processAgentMessage(
    staleStateContext,
    { message: "si" },
  );
  assert.equal(staleConfirmed.type, "CONFIRMED");
  assert.equal(
    createdExpenses.length,
    createdExpensesBeforeStaleConfirmation + 1,
  );
  assert.equal(
    categoryDrafts.some(
      (row) => row.conversation_key === staleStateContext.conversationKey,
    ),
    false,
  );
  console.log(
    "PASS confirming a proposal clears a stale draft in the same conversation",
  );

  function seedLifecycleState(context, index) {
    const timestamp = new Date().toISOString();
    const suffix = String(index).padStart(12, "0");
    const draft = {
      id: `62000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      household_id: context.householdId,
      actor_member_id: context.actorMemberId,
      conversation_key: context.conversationKey,
      operation_type: "CREATE_EXPENSE",
      status: "AWAITING_DETAILS",
      payload: {
        amount: "321",
        date: null,
        merchant: "Lifecycle Market",
        description: null,
        paidBySelf: true,
        paidByMemberName: null,
        categoryName: null,
      },
      created_at: timestamp,
      updated_at: timestamp,
    };
    const proposal = {
      id: `62000000-0000-4000-8000-${suffix}`,
      household_id: context.householdId,
      conversation_key: context.conversationKey,
      operation_type: "CREATE_EXPENSE",
      status: "AWAITING_CONFIRMATION",
      payload: {
        actorMemberId: context.actorMemberId,
        source: context.source,
        expense: {
          paidByMemberId: context.actorMemberId,
          totalAmount: 321,
          expenseDate: "2026-08-12",
          description: "Lifecycle proposal",
          items: [],
          splits: [
            {
              householdMemberId: context.actorMemberId,
              percentage: 100,
            },
          ],
        },
      },
      created_at: timestamp,
      updated_at: timestamp,
    };
    categoryDrafts.push(draft);
    proposals.push(proposal);
    return { draft, proposal };
  }

  const confirmationFailureContext = {
    ...contextA,
    conversationKey: "agent-stale-confirm-failure",
  };
  const confirmationFailureFixture = seedLifecycleState(
    confirmationFailureContext,
    2,
  );
  const createdExpensesBeforeConfirmationFailure = createdExpenses.length;
  confirmationFailure = true;
  try {
    await expectAgentError(
      conversation.processAgentMessage(confirmationFailureContext, {
        message: "si",
      }),
      "PERSISTENCE_ERROR",
    );
  } finally {
    confirmationFailure = false;
  }
  assert.equal(
    createdExpenses.length,
    createdExpensesBeforeConfirmationFailure,
  );
  assert.equal(
    categoryDrafts.some((row) => row.id === confirmationFailureFixture.draft.id),
    true,
  );
  assert.equal(
    proposals.find((row) => row.id === confirmationFailureFixture.proposal.id)
      ?.status,
    "AWAITING_CONFIRMATION",
  );
  console.log("PASS confirmation failure preserves draft and proposal");

  const rejectionFailureContext = {
    ...contextA,
    conversationKey: "agent-stale-rejection-failure",
  };
  const rejectionFailureFixture = seedLifecycleState(
    rejectionFailureContext,
    3,
  );
  const createdExpensesBeforeRejectionFailure = createdExpenses.length;
  const originalRejectAgentProposal = agentService.rejectAgentProposal;
  agentService.rejectAgentProposal = async () => {
    const error = new Error("simulated rejection failure");
    error.code = "PERSISTENCE_ERROR";
    throw error;
  };
  try {
    await expectAgentError(
      conversation.processAgentMessage(rejectionFailureContext, {
        message: "no",
      }),
      "PERSISTENCE_ERROR",
    );
  } finally {
    agentService.rejectAgentProposal = originalRejectAgentProposal;
  }
  assert.equal(
    createdExpenses.length,
    createdExpensesBeforeRejectionFailure,
  );
  assert.equal(
    categoryDrafts.some((row) => row.id === rejectionFailureFixture.draft.id),
    true,
  );
  assert.equal(
    proposals.find((row) => row.id === rejectionFailureFixture.proposal.id)
      ?.status,
    "AWAITING_CONFIRMATION",
  );
  console.log("PASS rejection failure preserves draft and proposal");

  const reviveContext = {
    ...contextA,
    conversationKey: "agent-stale-no-revive",
  };
  const reviveFixture = seedLifecycleState(reviveContext, 4);
  const createdExpensesBeforeReviveCheck = createdExpenses.length;
  const reviveRejection = await conversation.processAgentMessage(reviveContext, {
    message: "no",
  });
  assert.equal(reviveRejection.type, "REJECTED");
  assert.equal(
    categoryDrafts.some((row) => row.id === reviveFixture.draft.id),
    false,
  );
  assert.equal(
    proposals.some((row) => row.id === reviveFixture.proposal.id),
    false,
  );

  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "New Market",
    description: null,
    totalAmount: "444",
    expenseDate: "2026-08-16",
    paidBySelf: true,
    categoryName: "Food",
  };
  const newOperation = await conversation.processAgentMessage(reviveContext, {
    message: "Pagué 444 en New Market",
  });
  assert.equal(newOperation.type, "PROPOSAL_CREATED");
  assert.equal(createdExpenses.length, createdExpensesBeforeReviveCheck);
  assert.equal(
    categoryDrafts.some((row) => row.id === reviveFixture.draft.id),
    false,
  );
  const replacementProposal = proposals.find(
    (row) => row.conversation_key === reviveContext.conversationKey,
  );
  assert.ok(replacementProposal);
  assert.notEqual(replacementProposal.id, reviveFixture.proposal.id);
  assert.equal(replacementProposal.payload.expense.totalAmount, 444);
  assert.equal(replacementProposal.payload.expense.merchant, "New Market");
  await conversation.processAgentMessage(reviveContext, { message: "no" });
  console.log("PASS rejected proposal cannot revive its old draft");

  const duplicateLifecycleContext = {
    ...contextA,
    conversationKey: "agent-stale-duplicate-confirmation",
  };
  const duplicateLifecycleFixture = seedLifecycleState(
    duplicateLifecycleContext,
    5,
  );
  const createdExpensesBeforeDuplicateLifecycle = createdExpenses.length;
  const duplicateFirstConfirmation = await conversation.processAgentMessage(
    duplicateLifecycleContext,
    { message: "si" },
  );
  assert.equal(duplicateFirstConfirmation.type, "CONFIRMED");
  assert.equal(
    createdExpenses.length,
    createdExpensesBeforeDuplicateLifecycle + 1,
  );
  assert.equal(
    categoryDrafts.some(
      (row) => row.id === duplicateLifecycleFixture.draft.id,
    ),
    false,
  );
  assert.equal(
    proposals.find((row) => row.id === duplicateLifecycleFixture.proposal.id)
      ?.status,
    "COMPLETED",
  );
  const duplicateSecondConfirmation = await conversation.processAgentMessage(
    duplicateLifecycleContext,
    { message: "si", proposalId: duplicateLifecycleFixture.proposal.id },
  );
  assert.equal(duplicateSecondConfirmation.type, "CONFIRMED");
  assert.equal(
    createdExpenses.length,
    createdExpensesBeforeDuplicateLifecycle + 1,
  );
  assert.equal(
    categoryDrafts.some(
      (row) => row.id === duplicateLifecycleFixture.draft.id,
    ),
    false,
  );
  console.log(
    "PASS duplicate confirmation with stale draft cannot create a second Expense",
  );

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
  const beforeDirectIncomeCount = createdIncomes.length;
  const incomeProposal = await createIncome.createIncomeTool(incomeContext, {
    memberId: memberB,
    amount: 75,
    incomeDate: "2026-08-12",
    description: "Salary",
    categoryId: null,
  });
  assert.equal(incomeProposal.status, "AWAITING_CONFIRMATION");
  assert.equal(createdIncomes.length, beforeDirectIncomeCount);
  const incomeConfirmed = await conversation.processAgentMessage(
    incomeContext,
    {
      message: "si",
      proposalId: incomeProposal.proposalId,
    },
  );
  assert.equal(incomeConfirmed.type, "CONFIRMED");
  assert.equal(createdIncomes.length, beforeDirectIncomeCount + 1);
  assert.equal(createdIncomes.at(-1).context.householdId, householdA);
  assert.equal(createdIncomes.at(-1).context.memberId, memberA);
  assert.equal(createdIncomes.at(-1).input.memberId, memberB);
  const incomeProposalRow = proposals.find(
    (row) => row.id === incomeProposal.proposalId,
  );
  assert.equal(incomeProposalRow.status, "COMPLETED");
  assert.equal(incomeProposalRow.income_id, incomeConfirmed.incomeId);
  assert.equal(typeof incomeProposalRow.resolved_at, "string");
  const repeatedIncomeConfirmation = await conversation.processAgentMessage(
    incomeContext,
    {
      message: "si",
      proposalId: incomeProposal.proposalId,
    },
  );
  assert.equal(repeatedIncomeConfirmation.type, "CONFIRMED");
  assert.equal(repeatedIncomeConfirmation.incomeId, incomeConfirmed.incomeId);
  assert.equal(createdIncomes.length, beforeDirectIncomeCount + 1);
  assert.equal(
    await agentService.findActiveProposalId(incomeContext),
    null,
  );
  console.log("PASS create_income confirmation is terminal and idempotent");

  await expectAgentError(
    createIncome.confirmCreateIncomeTool(
      incomeContext,
      "62000000-0000-4000-8000-000000000097",
    ),
    "PROPOSAL_NOT_AVAILABLE",
  );
  const invalidIncomeOperationContext = {
    ...contextA,
    conversationKey: "agent-income-invalid-operation",
  };
  const invalidIncomeOperationProposal = await tool.createExpenseTool(
    invalidIncomeOperationContext,
    expenseInput,
  );
  await expectAgentError(
    createIncome.confirmCreateIncomeTool(
      invalidIncomeOperationContext,
      invalidIncomeOperationProposal.proposalId,
    ),
    "PROPOSAL_NOT_AVAILABLE",
  );
  assert.equal(createdIncomes.length, beforeDirectIncomeCount + 1);
  console.log("PASS income NOT_FOUND and INVALID_OPERATION do not write");

  const failedIncomeContext = {
    ...contextA,
    conversationKey: "agent-income-confirmation-failure",
  };
  const failedIncomeProposal = await createIncome.createIncomeTool(
    failedIncomeContext,
    {
      memberId: memberB,
      amount: 90,
      incomeDate: "2026-08-12",
      description: "Failed confirmation",
      categoryId: null,
    },
  );
  const beforeFailedIncomeCount = createdIncomes.length;
  confirmationFailure = true;
  try {
    await expectAgentError(
      conversation.processAgentMessage(failedIncomeContext, {
        message: "si",
        proposalId: failedIncomeProposal.proposalId,
      }),
      "PERSISTENCE_ERROR",
    );
  } finally {
    confirmationFailure = false;
  }
  const failedIncomeRow = proposals.find(
    (row) => row.id === failedIncomeProposal.proposalId,
  );
  assert.equal(failedIncomeRow.status, "AWAITING_CONFIRMATION");
  assert.equal(failedIncomeRow.income_id ?? null, null);
  assert.equal(createdIncomes.length, beforeFailedIncomeCount);
  console.log("PASS income confirmation failure preserves pending proposal");

  const rejectedIncomeProposal = {
    id: "62000000-0000-4000-8000-000000000096",
    household_id: householdA,
    conversation_key: "agent-income-rejected-terminal",
    operation_type: "CREATE_INCOME",
    payload: {
      actorMemberId: memberA,
      source: "WEB",
      income: {
        memberId: memberA,
        amount: 40,
        incomeDate: "2026-08-12",
        description: "Rejected income",
        categoryId: null,
      },
    },
    status: "REJECTED",
    resolved_at: "2026-08-12T12:00:00.000Z",
    expense_id: null,
    income_id: null,
  };
  proposals.push(rejectedIncomeProposal);
  const beforeRejectedIncomeCount = createdIncomes.length;
  const rejectedIncomeConfirmation =
    await createIncome.confirmCreateIncomeTool(
      { ...contextA, conversationKey: rejectedIncomeProposal.conversation_key },
      rejectedIncomeProposal.id,
    );
  assert.equal(rejectedIncomeConfirmation.status, "REJECTED");
  assert.equal(createdIncomes.length, beforeRejectedIncomeCount);
  console.log("PASS rejected terminal income proposal does not create Income");

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
    { id: "category-salud", name: "Salud" },
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
  const beforeConversationalIncomeCount = createdIncomes.length;
  assert.equal(createdIncomes.length, beforeConversationalIncomeCount);
  console.log("PASS textual Income creation proposes without writing");

  const conversationalIncomeRejected = await conversation.processAgentMessage(
    { ...contextA, conversationKey: "agent-income-text" },
    { message: "no", proposalId: conversationalIncomeProposal.proposalId },
  );
  assert.equal(conversationalIncomeRejected.type, "REJECTED");
  assert.equal(createdIncomes.length, beforeConversationalIncomeCount);
  console.log("PASS textual Income rejection does not write");

  mockInterpretation = {
    kind: "CREATE_INCOME",
    amount: "3000000",
    incomeDate: "2026-08-16",
    description: "Salario",
    categoryName: "Food",
  };
  const directIncomeContext = {
    ...contextA,
    conversationKey: "agent-direct-income-complete",
  };
  const beforeDirectIncomeProposalCount = proposals.length;
  const beforeDirectIncomeCreatedCount = createdIncomes.length;
  const directIncomeProposal = await conversation.processAgentMessage(
    directIncomeContext,
    { message: "Recibí un salario de 3000000" },
  );
  assert.equal(directIncomeProposal.type, "PROPOSAL_CREATED");
  assert.equal(proposals.length, beforeDirectIncomeProposalCount + 1);
  assert.equal(createdIncomes.length, beforeDirectIncomeCreatedCount);
  const directIncomeStored = proposals.find(
    (row) => row.id === directIncomeProposal.proposalId,
  );
  assert.equal(directIncomeStored.payload.income.amount, 3000000);
  assert.equal(directIncomeStored.payload.income.incomeDate, "2026-08-16");
  assert.equal(directIncomeStored.payload.income.description, "Salario");
  assert.equal(directIncomeStored.payload.income.categoryId, "category-1");
  const directIncomeConfirmation = await conversation.processAgentMessage(
    directIncomeContext,
    { message: "sí" },
  );
  assert.equal(directIncomeConfirmation.type, "CONFIRMED");
  assert.equal(createdIncomes.length, beforeDirectIncomeCreatedCount + 1);
  assert.equal(createdIncomes.at(-1).input.amount, 3000000);
  console.log(
    "PASS direct CREATE_INCOME reaches PendingProposal and writes only after confirmation",
  );

  mockInterpretation = {
    kind: "CREATE_INCOME",
    amount: "2750000",
    incomeDate: "2026-08-20",
    description: "Salario de agosto",
    categoryName: null,
  };
  const incomeWithoutCategoryContext = {
    ...contextA,
    conversationKey: "agent-income-complete-without-category",
  };
  const beforeIncomeWithoutCategoryProposals = proposals.length;
  const beforeIncomeWithoutCategoryCount = createdIncomes.length;
  const completeIncomeCategoryClarification =
    await conversation.processAgentMessage(incomeWithoutCategoryContext, {
      message: "Recibí 2750000 el 20 de agosto de 2026, salario de agosto",
    });
  assert.equal(
    completeIncomeCategoryClarification.type,
    "CLARIFICATION_REQUIRED",
  );
  assert.deepEqual(completeIncomeCategoryClarification.missingFields, [
    "categoryId",
  ]);
  assert.ok(
    completeIncomeCategoryClarification.options.some(
      ({ name }) => name === "Food",
    ),
  );
  assert.equal(proposals.length, beforeIncomeWithoutCategoryProposals);
  assert.equal(createdIncomes.length, beforeIncomeWithoutCategoryCount);
  const completeIncomeCategoryProposal =
    await conversation.processAgentMessage(incomeWithoutCategoryContext, {
      message: "Food",
    });
  assert.equal(completeIncomeCategoryProposal.type, "PROPOSAL_CREATED");
  const completeIncomeCategoryStoredProposal = proposals.find(
    (row) => row.id === completeIncomeCategoryProposal.proposalId,
  );
  assert.equal(
    completeIncomeCategoryStoredProposal.payload.income.amount,
    2750000,
  );
  assert.equal(
    completeIncomeCategoryStoredProposal.payload.income.incomeDate,
    "2026-08-20",
  );
  assert.equal(
    completeIncomeCategoryStoredProposal.payload.income.description,
    "Salario de agosto",
  );
  assert.equal(createdIncomes.length, beforeIncomeWithoutCategoryCount);
  const completeIncomeCategoryConfirmation =
    await conversation.processAgentMessage(incomeWithoutCategoryContext, {
      message: "sí",
    });
  assert.equal(completeIncomeCategoryConfirmation.type, "CONFIRMED");
  assert.equal(createdIncomes.length, beforeIncomeWithoutCategoryCount + 1);
  assert.equal(createdIncomes.at(-1).input.amount, 2750000);
  console.log(
    "PASS complete CREATE_INCOME without category asks, proposes and confirms",
  );

  mockInterpretation = {
    kind: "CREATE_INCOME",
    amount: "3000000",
    incomeDate: null,
    description: "Salario",
    categoryName: "Food",
  };
  const missingIncomeDateContext = {
    ...contextA,
    conversationKey: "agent-direct-income-missing-date",
  };
  const beforeMissingIncomeDateProposals = proposals.length;
  const beforeMissingIncomeDateIncomes = createdIncomes.length;
  const missingIncomeDate = await conversation.processAgentMessage(
    missingIncomeDateContext,
    { message: "Recibí un salario de 3000000" },
  );
  assert.equal(missingIncomeDate.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(missingIncomeDate.missingFields, ["incomeDate"]);
  assert.match(missingIncomeDate.message, /ingreso/);
  assert.doesNotMatch(missingIncomeDate.message, /gasto/);
  assert.equal(proposals.length, beforeMissingIncomeDateProposals);
  assert.equal(createdIncomes.length, beforeMissingIncomeDateIncomes);
  console.log("PASS incomplete CREATE_INCOME asks for the income date");

  mockInterpretation = {
    kind: "CREATE_INCOME",
    amount: "3000000",
    incomeDate: "2026-08-16",
    description: null,
    categoryName: "Food",
  };
  const missingIncomeDescriptionContext = {
    ...contextA,
    conversationKey: "agent-direct-income-missing-description",
  };
  const beforeMissingIncomeDescriptionProposals = proposals.length;
  const beforeMissingIncomeDescriptionIncomes = createdIncomes.length;
  const missingIncomeDescription = await conversation.processAgentMessage(
    missingIncomeDescriptionContext,
    { message: "Recibí un salario de 3000000" },
  );
  assert.equal(missingIncomeDescription.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(missingIncomeDescription.missingFields, ["description"]);
  assert.match(missingIncomeDescription.message, /ingreso/);
  assert.doesNotMatch(missingIncomeDescription.message, /gasto/);
  assert.equal(proposals.length, beforeMissingIncomeDescriptionProposals);
  assert.equal(createdIncomes.length, beforeMissingIncomeDescriptionIncomes);
  console.log("PASS incomplete CREATE_INCOME asks for the description");

  mockInterpretation = {
    kind: "CREATE_INCOME",
    amount: null,
    incomeDate: null,
    description: null,
    categoryName: null,
  };
  const incompleteIncomeContext = {
    ...contextA,
    conversationKey: "agent-direct-income-incomplete",
  };
  const beforeIncompleteIncomeProposals = proposals.length;
  const beforeIncompleteIncomeCount = createdIncomes.length;
  const incompleteIncome = await conversation.processAgentMessage(
    incompleteIncomeContext,
    { message: "Recibí algo" },
  );
  assert.equal(incompleteIncome.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(incompleteIncome.missingFields, [
    "amount",
    "incomeDate",
    "description",
  ]);
  assert.match(incompleteIncome.message, /ingreso/);
  assert.doesNotMatch(incompleteIncome.message, /gasto/);
  assert.equal(proposals.length, beforeIncompleteIncomeProposals);
  assert.equal(createdIncomes.length, beforeIncompleteIncomeCount);
  const incompleteIncomeDraft = categoryDrafts.find(
    (row) => row.conversation_key === incompleteIncomeContext.conversationKey,
  );
  assert.equal(incompleteIncomeDraft.status, "AWAITING_DETAILS");
  assert.equal(incompleteIncomeDraft.operation_type, "CREATE_INCOME");
  assert.equal(incompleteIncomeDraft.payload.amount, null);
  console.log("PASS fully incomplete CREATE_INCOME remains non-financially persistent");

  mockInterpretation = {
    kind: "CREATE_INCOME",
    amount: "3000000",
    incomeDate: null,
    description: null,
    categoryName: null,
  };
  const incomeDetailsContext = {
    ...contextA,
    conversationKey: "agent-income-details-continuation",
  };
  const beforeIncomeDetailsProposals = proposals.length;
  const beforeIncomeDetailsIncomes = createdIncomes.length;
  const incomeDetailsInitial = await conversation.processAgentMessage(
    incomeDetailsContext,
    { message: "Recibí un salario de 3000000" },
  );
  assert.equal(incomeDetailsInitial.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(incomeDetailsInitial.missingFields, [
    "incomeDate",
    "description",
  ]);
  const incomeDetailsDraft = categoryDrafts.find(
    (row) => row.conversation_key === incomeDetailsContext.conversationKey,
  );
  assert.equal(incomeDetailsDraft.status, "AWAITING_DETAILS");
  assert.equal(incomeDetailsDraft.operation_type, "CREATE_INCOME");
  assert.equal(incomeDetailsDraft.payload.amount, "3000000");
  const incomeDetailsCompleted = await conversation.processAgentMessage(
    incomeDetailsContext,
    { message: "Hoy, salario" },
    async () => {
      throw new Error("OpenAI must not receive persisted income details");
    },
  );
  assert.equal(incomeDetailsCompleted.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(incomeDetailsCompleted.missingFields, ["categoryId"]);
  assert.equal(incomeDetailsDraft.status, "AWAITING_CATEGORY");
  assert.equal(incomeDetailsDraft.operation_type, "CREATE_INCOME");
  assert.equal(incomeDetailsDraft.payload.income.amount, 3000000);
  assert.equal(
    incomeDetailsDraft.payload.income.incomeDate,
    new Date().toISOString().slice(0, 10),
  );
  assert.equal(incomeDetailsDraft.payload.income.description, "salario");
  assert.equal(proposals.length, beforeIncomeDetailsProposals);
  assert.equal(createdIncomes.length, beforeIncomeDetailsIncomes);
  const incomeDetailsProposal = await conversation.processAgentMessage(
    incomeDetailsContext,
    { message: "Food" },
  );
  assert.equal(incomeDetailsProposal.type, "PROPOSAL_CREATED");
  const incomeDetailsStoredProposal = proposals.find(
    (row) => row.id === incomeDetailsProposal.proposalId,
  );
  assert.equal(incomeDetailsStoredProposal.payload.income.amount, 3000000);
  assert.equal(createdIncomes.length, beforeIncomeDetailsIncomes);
  const incomeDetailsConfirmation = await conversation.processAgentMessage(
    incomeDetailsContext,
    { message: "sí" },
  );
  assert.equal(incomeDetailsConfirmation.type, "CONFIRMED");
  assert.equal(createdIncomes.length, beforeIncomeDetailsIncomes + 1);
  assert.equal(createdIncomes.at(-1).input.amount, 3000000);
  const repeatedIncomeDetailsConfirmation = await conversation.processAgentMessage(
    incomeDetailsContext,
    { message: "sí" },
  );
  assert.notEqual(repeatedIncomeDetailsConfirmation.type, "CONFIRMED");
  assert.equal(createdIncomes.length, beforeIncomeDetailsIncomes + 1);
  console.log(
    "PASS incomplete CREATE_INCOME preserves amount through details, category and confirmation",
  );

  mockInterpretation = {
    kind: "CREATE_INCOME",
    amount: "500000",
    incomeDate: "hoy",
    description: "Honorarios",
    categoryName: "Food",
  };
  const naturalIncomeDateContext = {
    ...contextA,
    conversationKey: "agent-direct-income-natural-date",
  };
  const naturalIncomeDateProposal = await conversation.processAgentMessage(
    naturalIncomeDateContext,
    { message: "Recibí honorarios" },
  );
  assert.equal(naturalIncomeDateProposal.type, "PROPOSAL_CREATED");
  const naturalIncomeDateStored = proposals.find(
    (row) => row.id === naturalIncomeDateProposal.proposalId,
  );
  assert.equal(
    naturalIncomeDateStored.payload.income.incomeDate,
    new Date().toISOString().slice(0, 10),
  );
  await conversation.processAgentMessage(naturalIncomeDateContext, {
    message: "no",
  });
  console.log("PASS direct CREATE_INCOME normalizes natural dates");

  const reportedIncomePhrases = [
    "Recibí un salario de 3000000",
    "Me consignaron 3000000",
    "Recibí honorarios",
    "Entró un ingreso de 500000",
  ];
  for (const [index, phrase] of reportedIncomePhrases.entries()) {
    mockInterpretation = {
      kind: "CREATE_INCOME",
      amount: "500000",
      incomeDate: "2026-08-16",
      description: "Ingreso de prueba",
      categoryName: "Food",
    };
    const phraseContext = {
      ...contextA,
      conversationKey: `agent-reported-income-phrase-${index}`,
    };
    const beforePhraseIncomes = createdIncomes.length;
    const phraseResult = await conversation.processAgentMessage(
      phraseContext,
      { message: phrase },
    );
    assert.equal(phraseResult.type, "PROPOSAL_CREATED");
    assert.equal(createdIncomes.length, beforePhraseIncomes);
    await conversation.processAgentMessage(phraseContext, { message: "no" });
  }
  console.log(
    "PASS reported Income phrases exercise the flow with a controlled CREATE_INCOME result",
  );

  const correctionContext = {
    ...contextA,
    conversationKey: "agent-pending-correction-flow",
  };
  const correctionExpenseBefore = createdExpenses.length;
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Éxito",
    description: "Compra original",
    totalAmount: "50000",
    expenseDate: "2026-09-14",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const correctionProposal = await conversation.processAgentMessage(
    correctionContext,
    { message: "Pagué 50000 en Éxito" },
  );
  assert.equal(correctionProposal.type, "PROPOSAL_CREATED");
  const correctionStored = proposals.find(
    (row) => row.id === correctionProposal.proposalId,
  );
  assert.ok(correctionStored);
  const correctionProposalId = correctionStored.id;
  const correctionDraft = {
    id: "63000000-0000-4000-8000-000000000001",
    household_id: correctionContext.householdId,
    actor_member_id: correctionContext.actorMemberId,
    conversation_key: correctionContext.conversationKey,
    operation_type: "CREATE_EXPENSE",
    status: "AWAITING_DETAILS",
    payload: {
      amount: "50000",
      date: "2026-09-14",
      merchant: "Éxito",
      description: "Compra original",
      paidBySelf: true,
      paidByMemberName: null,
      categoryName: "Food",
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  categoryDrafts.push(correctionDraft);
  const correctionDraftSnapshot = JSON.stringify(correctionDraft);
  const correctionCases = [
    ["fueron 70000", "amount", "70000"],
    ["en realidad fue 2026-09-15", "date", "2026-09-15"],
    ["era mercado de septiembre", "description", "mercado de septiembre"],
    ["la categoría correcta es Vivienda", "category", "Vivienda"],
    ["pagó Alejandra", "payer", "Alejandra"],
  ];
  for (const [message, field, value] of correctionCases) {
    mockInterpretation = { kind: "CORRECTION", field, value };
    const updated = await conversation.processAgentMessage(correctionContext, {
      message,
    });
    assert.equal(updated.type, "PROPOSAL_UPDATED");
    assert.equal(updated.proposalId, correctionProposalId);
    assert.equal(updated.operationType, "CREATE_EXPENSE");
    assert.equal(updated.payload.actorMemberId, correctionContext.actorMemberId);
    assert.equal(updated.payload.source, correctionContext.source);
    assert.equal(updated.payload.expense.merchant, "Éxito");
    if (field === "amount") assert.equal(updated.payload.expense.totalAmount, 70000);
    if (field === "date") assert.equal(updated.payload.expense.expenseDate, "2026-09-15");
    if (field === "description") {
      assert.equal(updated.payload.expense.description, "mercado de septiembre");
    }
    if (field === "category") {
      assert.equal(updated.payload.expense.categoryId, "category-vivienda");
    }
    if (field === "payer") {
      assert.equal(updated.payload.expense.paidByMemberId, memberB);
    }
    assert.equal(updated.status, "AWAITING_CONFIRMATION");
    assert.equal(createdExpenses.length, correctionExpenseBefore);
    assert.equal(JSON.stringify(correctionDraft), correctionDraftSnapshot);
  }
  mockInterpretation = { kind: "CORRECTION", field: "amount", value: "80000" };
  const negatedCorrection = await conversation.processAgentMessage(
    correctionContext,
    { message: "No, fueron 80000" },
  );
  assert.equal(negatedCorrection.type, "PROPOSAL_UPDATED");
  assert.equal(negatedCorrection.proposalId, correctionProposalId);
  assert.equal(negatedCorrection.payload.expense.totalAmount, 80000);
  const correctionConfirmed = await conversation.processAgentMessage(
    correctionContext,
    { message: "sí" },
  );
  assert.equal(correctionConfirmed.type, "CONFIRMED");
  assert.equal(createdExpenses.length, correctionExpenseBefore + 1);
  assert.equal(createdExpenses.at(-1).input.totalAmount, 80000);
  assert.equal(createdExpenses.at(-1).input.paidByMemberId, memberB);
  assert.equal(createdExpenses.at(-1).input.categoryId, "category-vivienda");
  assert.equal(
    categoryDrafts.some((row) => row.id === correctionDraft.id),
    false,
  );
  assert.equal(
    proposals.find((row) => row.id === correctionProposalId)?.status,
    "COMPLETED",
  );
  console.log(
    "PASS expense correction updates one proposal, preserves draft and confirms once",
  );

  const rejectionCorrectionContext = {
    ...contextA,
    conversationKey: "agent-pending-correction-rejection",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Mercado",
    description: "Original",
    totalAmount: "25000",
    expenseDate: "2026-09-14",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const rejectionCorrectionProposal = await conversation.processAgentMessage(
    rejectionCorrectionContext,
    { message: "Pagué 25000 en Mercado" },
  );
  mockInterpretation = {
    kind: "CORRECTION",
    field: "description",
    value: "Compra cancelada",
  };
  const rejectedCorrection = await conversation.processAgentMessage(
    rejectionCorrectionContext,
    { message: "era compra cancelada" },
  );
  assert.equal(rejectedCorrection.type, "PROPOSAL_UPDATED");
  const beforeCorrectionRejectionExpenses = createdExpenses.length;
  const rejectedAfterCorrection = await conversation.processAgentMessage(
    rejectionCorrectionContext,
    { message: "no" },
  );
  assert.equal(rejectedAfterCorrection.type, "REJECTED");
  assert.equal(createdExpenses.length, beforeCorrectionRejectionExpenses);
  assert.equal(
    proposals.some((row) => row.id === rejectionCorrectionProposal.proposalId),
    false,
  );
  console.log("PASS corrected proposal can be rejected without financial writes");

  const incomeCorrectionContext = {
    ...contextA,
    conversationKey: "agent-pending-income-correction",
  };
  const beforeIncomeCorrection = createdIncomes.length;
  const incomeCorrectionProposal = await createIncome.createIncomeTool(
    incomeCorrectionContext,
    {
      memberId: memberA,
      amount: 300,
      incomeDate: "2026-09-14",
      description: "Ingreso original",
      categoryId: "category-1",
    },
  );
  mockInterpretation = { kind: "CORRECTION", field: "amount", value: "600" };
  const incomeCorrection = await conversation.processAgentMessage(
    incomeCorrectionContext,
    { message: "fueron 600" },
  );
  assert.equal(incomeCorrection.type, "PROPOSAL_UPDATED");
  assert.equal(incomeCorrection.proposalId, incomeCorrectionProposal.proposalId);
  assert.equal(incomeCorrection.operationType, "CREATE_INCOME");
  assert.equal(incomeCorrection.payload.income.amount, 600);
  assert.equal(incomeCorrection.payload.income.description, "Ingreso original");
  assert.equal(createdIncomes.length, beforeIncomeCorrection);
  const incomeCorrectionConfirmed = await conversation.processAgentMessage(
    incomeCorrectionContext,
    { message: "sí" },
  );
  assert.equal(incomeCorrectionConfirmed.type, "CONFIRMED");
  assert.equal(createdIncomes.length, beforeIncomeCorrection + 1);
  assert.equal(createdIncomes.at(-1).input.amount, 600);
  console.log("PASS income correction preserves operation and confirms once");

  const incompatibleIncomeContext = {
    ...contextA,
    conversationKey: "agent-income-correction-incompatible",
  };
  const incompatibleIncomeProposal = await createIncome.createIncomeTool(
    incompatibleIncomeContext,
    {
      memberId: memberA,
      amount: 700,
      incomeDate: "2026-09-14",
      description: "Income payer test",
      categoryId: "category-1",
    },
  );
  const incompatibleIncomeRow = proposals.find(
    (row) => row.id === incompatibleIncomeProposal.proposalId,
  );
  const incompatibleIncomeUpdatedAt = incompatibleIncomeRow.updated_at;
  mockInterpretation = { kind: "CORRECTION", field: "payer", value: "Felipe" };
  const incompatibleIncomeCorrection = await conversation.processAgentMessage(
    incompatibleIncomeContext,
    { message: "pagó Felipe" },
  );
  assert.equal(incompatibleIncomeCorrection.type, "CLARIFICATION_REQUIRED");
  assert.equal(incompatibleIncomeRow.updated_at, incompatibleIncomeUpdatedAt);
  assert.equal(incompatibleIncomeRow.payload.income.amount, 700);
  await conversation.processAgentMessage(incompatibleIncomeContext, {
    message: "no",
  });
  console.log("PASS payer correction is rejected for CREATE_INCOME");

  const noPendingCorrectionContext = {
    ...contextA,
    conversationKey: "agent-correction-without-pending",
  };
  const noPendingDraft = {
    ...correctionDraft,
    id: "63000000-0000-4000-8000-000000000002",
    conversation_key: noPendingCorrectionContext.conversationKey,
  };
  categoryDrafts.push(noPendingDraft);
  const beforeNoPending = {
    proposals: proposals.length,
    expenses: createdExpenses.length,
    draftPayload: JSON.stringify(noPendingDraft.payload),
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Éxito",
    description: "Compra original",
    totalAmount: "50000",
    expenseDate: "2026-09-14",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const noPendingCorrection = await conversation.processAgentMessage(
    noPendingCorrectionContext,
    { message: "fueron 70000" },
  );
  assert.equal(noPendingCorrection.type, "PROPOSAL_CREATED");
  assert.equal(proposals.length, beforeNoPending.proposals + 1);
  assert.equal(createdExpenses.length, beforeNoPending.expenses);
  assert.equal(JSON.stringify(noPendingDraft.payload), beforeNoPending.draftPayload);
  await conversation.processAgentMessage(noPendingCorrectionContext, {
    message: "no",
  });
  assert.equal(proposals.length, beforeNoPending.proposals);
  assert.equal(createdExpenses.length, beforeNoPending.expenses);
  assert.equal(
    categoryDrafts.some((row) => row.id === noPendingDraft.id),
    false,
  );
  console.log("PASS correction-like input continues active draft without pending proposal");

  const noPendingWithoutDraftContext = {
    ...contextA,
    conversationKey: "agent-correction-without-pending-no-draft",
  };
  const beforeNoPendingWithoutDraft = {
    proposals: proposals.length,
    expenses: createdExpenses.length,
  };
  mockInterpretation = { kind: "CORRECTION", field: "amount", value: "70000" };
  const noPendingWithoutDraft = await conversation.processAgentMessage(
    noPendingWithoutDraftContext,
    { message: "fueron 70000" },
  );
  assert.equal(noPendingWithoutDraft.type, "CLARIFICATION_REQUIRED");
  assert.match(noPendingWithoutDraft.message, /propuesta activa/);
  assert.equal(proposals.length, beforeNoPendingWithoutDraft.proposals);
  assert.equal(createdExpenses.length, beforeNoPendingWithoutDraft.expenses);
  console.log("PASS correction without pending proposal remains non-mutating");

  const invalidCorrectionContext = {
    ...contextA,
    conversationKey: "agent-invalid-pending-correction",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Invalid Correction Market",
    description: "Original",
    totalAmount: "1000",
    expenseDate: "2026-09-14",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const invalidCorrectionProposal = await conversation.processAgentMessage(
    invalidCorrectionContext,
    { message: "Pagué 1000" },
  );
  const invalidCorrectionRow = proposals.find(
    (row) => row.id === invalidCorrectionProposal.proposalId,
  );
  const invalidCorrectionUpdatedAt = invalidCorrectionRow.updated_at;
  const invalidCorrectionCases = [
    { field: "amount", value: "-5", message: "fueron -5" },
    { field: "date", value: "fecha inválida", message: "fue fecha inválida" },
    { field: "category", value: "No existe", message: "la categoría correcta es No existe" },
    { field: "payer", value: "No existe", message: "pagó No existe" },
    { field: "unknown", value: "valor", message: "corrige valor" },
  ];
  for (const testCase of invalidCorrectionCases) {
    mockInterpretation = {
      kind: "CORRECTION",
      field: testCase.field,
      value: testCase.value,
    };
    const invalidResult = await conversation.processAgentMessage(
      invalidCorrectionContext,
      { message: testCase.message },
    );
    assert.equal(invalidResult.type, "CLARIFICATION_REQUIRED");
    assert.equal(invalidCorrectionRow.updated_at, invalidCorrectionUpdatedAt);
    assert.equal(invalidCorrectionRow.payload.expense.totalAmount, 1000);
  }
  await conversation.processAgentMessage(invalidCorrectionContext, {
    message: "no",
  });
  console.log("PASS invalid and incompatible corrections do not mutate proposals");

  mockInterpretation = { kind: "UNSUPPORTED" };
  const shortInputContext = {
    ...contextA,
    conversationKey: "agent-short-input-with-pending",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Short Input Market",
    description: "Original",
    totalAmount: "900",
    expenseDate: "2026-09-14",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const shortInputProposal = await conversation.processAgentMessage(
    shortInputContext,
    { message: "Pagué 900" },
  );
  const shortInputRow = proposals.find(
    (row) => row.id === shortInputProposal.proposalId,
  );
  const shortInputUpdatedAt = shortInputRow.updated_at;
  mockInterpretation = { kind: "UNSUPPORTED" };
  for (const message of ["70000", "Ayer", "Comida"]) {
    const shortResult = await conversation.processAgentMessage(
      shortInputContext,
      { message },
    );
    assert.equal(shortResult.type, "UNSUPPORTED");
    assert.equal(shortInputRow.updated_at, shortInputUpdatedAt);
  }
  await conversation.processAgentMessage(shortInputContext, { message: "no" });
  console.log("PASS short ambiguous messages do not trigger corrections");

  const paymentVerbContext = {
    ...contextA,
    conversationKey: "agent-payment-verb-without-pending",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Carulla",
    description: null,
    totalAmount: "10000",
    expenseDate: "2026-09-15",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const paymentVerbResult = await conversation.processAgentMessage(
    paymentVerbContext,
    { message: "Pago 10000 en Carulla" },
  );
  assert.equal(paymentVerbResult.type, "PROPOSAL_CREATED");
  assert.notEqual(paymentVerbResult.message, "No hay una propuesta activa para corregir.");
  await conversation.processAgentMessage(paymentVerbContext, { message: "no" });

  const paymentVerbPendingContext = {
    ...contextA,
    conversationKey: "agent-payment-verb-with-pending",
  };
  const paymentVerbPending = await conversation.processAgentMessage(
    paymentVerbPendingContext,
    { message: "Pagué 20000 en Carulla" },
  );
  const paymentVerbPendingRow = proposals.find(
    (row) => row.id === paymentVerbPending.proposalId,
  );
  assert.ok(paymentVerbPendingRow);
  const paymentVerbPendingSnapshot = JSON.stringify(paymentVerbPendingRow);
  const proposalsBeforePaymentVerb = proposals.length;
  const expensesBeforePaymentVerb = createdExpenses.length;
  const paymentVerbConflict = await expectAgentError(
    conversation.processAgentMessage(paymentVerbPendingContext, {
      message: "Pago 10000 en Carulla",
    }),
    "PENDING_PROPOSAL_EXISTS",
  );
  assert.equal(paymentVerbConflict, undefined);
  assert.equal(proposals.length, proposalsBeforePaymentVerb);
  assert.equal(createdExpenses.length, expensesBeforePaymentVerb);
  assert.equal(JSON.stringify(paymentVerbPendingRow), paymentVerbPendingSnapshot);
  await conversation.processAgentMessage(paymentVerbPendingContext, {
    message: "no",
  });
  console.log("PASS payment verb is not treated as correction");

  const correctionPrefixContext = {
    ...contextA,
    conversationKey: "agent-correction-prefixes",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Prefix Market",
    description: "Original",
    totalAmount: "50000",
    expenseDate: "2026-09-15",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const correctionPrefixProposal = await conversation.processAgentMessage(
    correctionPrefixContext,
    { message: "Pagué 50000 en Prefix Market" },
  );
  const correctionPrefixBeforeExpenses = createdExpenses.length;
  const correctionPrefixCases = [
    ["No, eran 70000", "70000"],
    ["No, fueron 80000", "80000"],
    ["No fueron 81000", "81000"],
    ["No eran 82000", "82000"],
    ["Quiero corregir el monto a 83000", "83000"],
    ["El monto debe ser 84000", "84000"],
    ["Fueron 90000", "90000"],
    ["Eran 91000", "91000"],
  ];
  for (const [message, value] of correctionPrefixCases) {
    mockInterpretation = { kind: "CORRECTION", field: "amount", value };
    const corrected = await conversation.processAgentMessage(
      correctionPrefixContext,
      { message },
    );
    assert.equal(corrected.type, "PROPOSAL_UPDATED");
    assert.equal(corrected.proposalId, correctionPrefixProposal.proposalId);
    assert.equal(corrected.payload.expense.totalAmount, Number(value));
    assert.equal(createdExpenses.length, correctionPrefixBeforeExpenses);
  }
  const naturalCorrectionCases = [
    {
      message: "La categoría debe ser Salud",
      field: "category",
      value: "Salud",
      assertPayload: (expense) =>
        assert.equal(expense.categoryId, "category-salud"),
    },
    {
      message: "La fecha correcta es ayer",
      field: "date",
      value: "ayer",
      assertPayload: (expense) =>
        assert.equal(
          expense.expenseDate,
          new Date(Date.now() - 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        ),
    },
    {
      message: "La descripción correcta es supermercado",
      field: "description",
      value: "supermercado",
      assertPayload: (expense) =>
        assert.equal(expense.description, "supermercado"),
    },
  ];
  for (const testCase of naturalCorrectionCases) {
    mockInterpretation = {
      kind: "CORRECTION",
      field: testCase.field,
      value: testCase.value,
    };
    const corrected = await conversation.processAgentMessage(
      correctionPrefixContext,
      { message: testCase.message },
    );
    assert.equal(corrected.type, "PROPOSAL_UPDATED");
    assert.equal(corrected.proposalId, correctionPrefixProposal.proposalId);
    assert.equal(createdExpenses.length, correctionPrefixBeforeExpenses);
    testCase.assertPayload(corrected.payload.expense);
  }
  mockInterpretation = {
    kind: "CORRECTION",
    field: "payer",
    value: "Felipe",
  };
  const payerCorrection = await conversation.processAgentMessage(
    correctionPrefixContext,
    { message: "Pagó Felipe" },
  );
  assert.equal(payerCorrection.type, "PROPOSAL_UPDATED");
  assert.equal(payerCorrection.proposalId, correctionPrefixProposal.proposalId);
  assert.equal(payerCorrection.payload.expense.paidByMemberId, memberA);
  assert.equal(createdExpenses.length, correctionPrefixBeforeExpenses);
  mockInterpretation = {
    kind: "CORRECTION",
    field: "payer",
    value: "Felipe",
  };
  const negatedPayerCorrection = await conversation.processAgentMessage(
    correctionPrefixContext,
    { message: "No, pagó Felipe" },
  );
  assert.equal(negatedPayerCorrection.type, "PROPOSAL_UPDATED");
  assert.equal(negatedPayerCorrection.proposalId, correctionPrefixProposal.proposalId);
  assert.equal(negatedPayerCorrection.payload.expense.paidByMemberId, memberA);
  assert.equal(createdExpenses.length, correctionPrefixBeforeExpenses);
  await conversation.processAgentMessage(correctionPrefixContext, {
    message: "no",
  });
  console.log("PASS correction prefixes and payer correction remain supported");

  const explicitRejectionMessages = [
    "No",
    "No gracias",
    "Rechazo",
    "Rechazar",
    "Cancelar",
    "Cancelo",
    "No quiero confirmar",
  ];
  for (const [index, message] of explicitRejectionMessages.entries()) {
    const rejectionContext = {
      ...contextA,
      conversationKey: `agent-explicit-rejection-${index}`,
    };
    mockInterpretation = {
      kind: "CREATE_EXPENSE",
      merchant: "Rejection Market",
      description: null,
      totalAmount: "1000",
      expenseDate: "2026-09-15",
      paidBySelf: true,
      paidByMemberName: null,
      categoryName: "Food",
    };
    const proposal = await conversation.processAgentMessage(rejectionContext, {
      message: "Pagué 1000 en Rejection Market",
    });
    const rejected = await conversation.processAgentMessage(rejectionContext, {
      message,
    });
    assert.equal(rejected.type, "REJECTED");
    assert.equal(
      proposals.some((row) => row.id === proposal.proposalId),
      false,
    );
  }
  console.log("PASS explicit rejection messages remain prioritized");

  const d3Results = [];
  function recordD3Case(name, result) {
    d3Results.push({ name, result });
    console.log(`PASS D3 ${name}: ${result}`);
  }

  const d3ExpenseRecognitionCases = [
    ["Gasté 70000 en comida", "PROPOSAL_CREATED"],
    ["Pagué 70000 en comida", "PROPOSAL_CREATED"],
    ["Fueron 70000 en comida", "PROPOSAL_CREATED"],
    ["Fueron 70000", "PROPOSAL_CREATED"],
    ["Fueron 70000 ayer", "PROPOSAL_CREATED"],
    ["Fueron 70000 de comida", "PROPOSAL_CREATED"],
    ["Hoy gasté 70000 en comida", "PROPOSAL_CREATED"],
  ];
  for (const [message, expectedType] of d3ExpenseRecognitionCases) {
    const conversationKey = `d3-expense-${d3Results.length}`;
    const d3Context = { ...contextA, conversationKey };
    mockInterpretation = {
      kind: "CREATE_EXPENSE",
      merchant: "D3 Market",
      description: null,
      totalAmount: "70000",
      expenseDate: "2026-08-16",
      paidBySelf: true,
      paidByMemberName: null,
      categoryName: "Food",
    };
    const beforeProposalCount = proposals.length;
    const beforeExpenseCount = createdExpenses.length;
    const result = await conversation.processAgentMessage(d3Context, {
      message,
    });
    assert.equal(result.type, expectedType);
    if (expectedType === "PROPOSAL_CREATED") {
      assert.equal(proposals.length, beforeProposalCount + 1);
      assert.equal(createdExpenses.length, beforeExpenseCount);
      const stored = proposals.find((row) => row.conversation_key === conversationKey);
      assert.equal(stored.operation_type, "CREATE_EXPENSE");
      assert.equal(stored.status, "AWAITING_CONFIRMATION");
      assert.equal(stored.payload.expense.totalAmount, 70000);
      await conversation.processAgentMessage(d3Context, { message: "no" });
      assert.equal(createdExpenses.length, beforeExpenseCount);
    } else {
      assert.equal(proposals.length, beforeProposalCount);
      assert.equal(createdExpenses.length, beforeExpenseCount);
    }
    recordD3Case(`expense ${message}`, `${result.type}${expectedType === "PROPOSAL_CREATED" ? "; rejected without write" : "; observed current correction guard"}`);
  }

  const d3IncomeRecognitionCases = [
    "Recibí 3000000 de salario",
    "Hoy recibí 3000000 de salario",
    "Me consignaron 3000000 por salario",
  ];
  for (const message of d3IncomeRecognitionCases) {
    const conversationKey = `d3-income-${d3Results.length}`;
    const d3Context = { ...contextA, conversationKey };
    mockInterpretation = {
      kind: "CREATE_INCOME",
      amount: "3000000",
      incomeDate: "2026-08-16",
      description: "Salario",
      categoryName: "Food",
    };
    const beforeProposalCount = proposals.length;
    const beforeIncomeCount = createdIncomes.length;
    const result = await conversation.processAgentMessage(d3Context, {
      message,
    });
    assert.equal(result.type, "PROPOSAL_CREATED");
    assert.equal(proposals.length, beforeProposalCount + 1);
    assert.equal(createdIncomes.length, beforeIncomeCount);
    const stored = proposals.find((row) => row.conversation_key === conversationKey);
    assert.equal(stored.operation_type, "CREATE_INCOME");
    assert.equal(stored.status, "AWAITING_CONFIRMATION");
    assert.equal(stored.payload.income.amount, 3000000);
    await conversation.processAgentMessage(d3Context, { message: "no" });
    assert.equal(createdIncomes.length, beforeIncomeCount);
    recordD3Case(`income ${message}`, "PROPOSAL_CREATED; rejected without write");
  }

  const d3ConfirmationCases = ["sí", "confirmar"];
  for (const confirmationMessage of d3ConfirmationCases) {
    const conversationKey = `d3-confirm-${d3Results.length}`;
    const d3Context = { ...contextA, conversationKey };
    mockInterpretation = {
      kind: "CREATE_EXPENSE",
      merchant: "Confirmation Market",
      description: null,
      totalAmount: "71000",
      expenseDate: "2026-08-16",
      paidBySelf: true,
      paidByMemberName: null,
      categoryName: "Food",
    };
    const proposalResult = await conversation.processAgentMessage(d3Context, {
      message: "Pagué 71000 en Confirmation Market",
    });
    assert.equal(proposalResult.type, "PROPOSAL_CREATED");
    const beforeExpenseCount = createdExpenses.length;
    const confirmed = await conversation.processAgentMessage(d3Context, {
      message: confirmationMessage,
    });
    assert.equal(confirmed.type, "CONFIRMED");
    assert.equal(createdExpenses.length, beforeExpenseCount + 1);
    const repeated = await conversation.processAgentMessage(d3Context, {
      message: confirmationMessage,
    });
    assert.equal(repeated.type, "CLARIFICATION_REQUIRED");
    assert.equal(createdExpenses.length, beforeExpenseCount + 1);
    recordD3Case(`confirmation ${confirmationMessage}`, "CONFIRMED once; duplicate ignored");
  }

  const d3RejectionCases = ["no", "rechazar"];
  for (const rejectionMessage of d3RejectionCases) {
    const conversationKey = `d3-reject-${d3Results.length}`;
    const d3Context = { ...contextA, conversationKey };
    mockInterpretation = {
      kind: "CREATE_INCOME",
      amount: "72000",
      incomeDate: "2026-08-16",
      description: "D3 rejection",
      categoryName: "Food",
    };
    const proposalResult = await conversation.processAgentMessage(d3Context, {
      message: "Recibí 72000",
    });
    assert.equal(proposalResult.type, "PROPOSAL_CREATED");
    const beforeIncomeCount = createdIncomes.length;
    const rejected = await conversation.processAgentMessage(d3Context, {
      message: rejectionMessage,
    });
    assert.equal(rejected.type, "REJECTED");
    assert.equal(createdIncomes.length, beforeIncomeCount);
    assert.equal(
      proposals.some((row) => row.conversation_key === conversationKey),
      false,
    );
    recordD3Case(`rejection ${rejectionMessage}`, "REJECTED without write");
  }

  const d3NoProposalContext = {
    ...contextA,
    conversationKey: "d3-no-active-proposal",
  };
  const d3NoProposalBeforeWrites = {
    expenses: createdExpenses.length,
    incomes: createdIncomes.length,
  };
  const d3NoProposalConfirmation = await conversation.processAgentMessage(
    d3NoProposalContext,
    { message: "confirmar" },
  );
  assert.equal(d3NoProposalConfirmation.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(d3NoProposalConfirmation.missingFields, ["proposalId"]);
  const d3NoProposalRejection = await conversation.processAgentMessage(
    d3NoProposalContext,
    { message: "rechazar" },
  );
  assert.equal(d3NoProposalRejection.type, "CLARIFICATION_REQUIRED");
  assert.deepEqual(d3NoProposalRejection.missingFields, ["proposalId"]);
  assert.equal(createdExpenses.length, d3NoProposalBeforeWrites.expenses);
  assert.equal(createdIncomes.length, d3NoProposalBeforeWrites.incomes);
  recordD3Case("confirmation/rejection without proposal", "clarification without writes");

  for (const message of ["70000", "Ayer", "Comida"]) {
    const d3Context = {
      ...contextA,
      conversationKey: `d3-isolated-${message.toLowerCase()}`,
    };
    mockInterpretation = { kind: "UNSUPPORTED" };
    const beforeProposalCount = proposals.length;
    const isolatedResult = await conversation.processAgentMessage(d3Context, {
      message,
    });
    assert.equal(isolatedResult.type, "UNSUPPORTED");
    assert.equal(proposals.length, beforeProposalCount);
    assert.equal(
      categoryDrafts.some((row) => row.conversation_key === d3Context.conversationKey),
      false,
    );
    recordD3Case(`isolated input ${message}`, "UNSUPPORTED without mutation");
  }

  const d3CorrectionContext = {
    ...contextA,
    conversationKey: "d3-correction-matrix",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "D3 Correction Market",
    description: "Original description",
    totalAmount: "73000",
    expenseDate: "2026-08-16",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const d3CorrectionProposal = await conversation.processAgentMessage(
    d3CorrectionContext,
    { message: "Pagué 73000 en D3 Correction Market" },
  );
  assert.equal(d3CorrectionProposal.type, "PROPOSAL_CREATED");
  const d3CorrectionRow = proposals.find(
    (row) => row.id === d3CorrectionProposal.proposalId,
  );
  const d3CorrectionProposalCount = proposals.length;
  const d3CorrectionExpenseCount = createdExpenses.length;
  const d3CorrectionCases = [
    {
      field: "amount",
      value: "80000",
      message: "No, fueron 80000",
      assertPayload: (expense) => assert.equal(expense.totalAmount, 80000),
    },
    {
      field: "date",
      value: "ayer",
      message: "No, fue ayer",
      assertPayload: (expense) =>
        assert.equal(
          expense.expenseDate,
          new Date(Date.now() - 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        ),
    },
    {
      field: "description",
      value: "restaurante",
      message: "No, era restaurante",
      assertPayload: (expense) => assert.equal(expense.description, "restaurante"),
    },
    {
      field: "category",
      value: "Transporte",
      message: "No, la categoría era Transporte",
      assertPayload: (expense) =>
        assert.equal(expense.categoryId, "category-transporte"),
    },
    {
      field: "payer",
      value: "Alejandra",
      message: "No, pagó Alejandra",
      assertPayload: (expense) => assert.equal(expense.paidByMemberId, memberB),
    },
  ];
  for (const testCase of d3CorrectionCases) {
    mockInterpretation = {
      kind: "CORRECTION",
      field: testCase.field,
      value: testCase.value,
    };
    const corrected = await conversation.processAgentMessage(
      d3CorrectionContext,
      { message: testCase.message },
    );
    assert.equal(corrected.type, "PROPOSAL_UPDATED");
    assert.equal(corrected.proposalId, d3CorrectionProposal.proposalId);
    assert.equal(corrected.operationType, "CREATE_EXPENSE");
    assert.equal(corrected.status, "AWAITING_CONFIRMATION");
    assert.equal(proposals.length, d3CorrectionProposalCount);
    assert.equal(createdExpenses.length, d3CorrectionExpenseCount);
    testCase.assertPayload(corrected.payload.expense);
    assert.equal(d3CorrectionRow.household_id, householdA);
    assert.equal(d3CorrectionRow.conversation_key, d3CorrectionContext.conversationKey);
    assert.equal(
      categoryDrafts.some(
        (row) => row.conversation_key === d3CorrectionContext.conversationKey,
      ),
      false,
    );
    recordD3Case(`correction ${testCase.field}`, "same proposal; AWAITING_CONFIRMATION; no write");
  }
  await conversation.processAgentMessage(d3CorrectionContext, { message: "no" });

  const d3ConfirmCorrectionContext = {
    ...contextA,
    conversationKey: "d3-correction-confirm",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "D3 Confirm Market",
    description: "Original",
    totalAmount: "74000",
    expenseDate: "2026-08-16",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const d3ConfirmProposal = await conversation.processAgentMessage(
    d3ConfirmCorrectionContext,
    { message: "Pagué 74000 en D3 Confirm Market" },
  );
  const d3ConfirmBeforeExpenses = createdExpenses.length;
  mockInterpretation = { kind: "CORRECTION", field: "amount", value: "84000" };
  const d3ConfirmedCorrection = await conversation.processAgentMessage(
    d3ConfirmCorrectionContext,
    { message: "No, fueron 84000" },
  );
  assert.equal(d3ConfirmedCorrection.type, "PROPOSAL_UPDATED");
  const d3Confirmed = await conversation.processAgentMessage(
    d3ConfirmCorrectionContext,
    { message: "sí" },
  );
  assert.equal(d3Confirmed.type, "CONFIRMED");
  assert.equal(createdExpenses.length, d3ConfirmBeforeExpenses + 1);
  assert.equal(createdExpenses.at(-1).input.totalAmount, 84000);
  assert.equal(
    proposals.find((row) => row.id === d3ConfirmProposal.proposalId)?.status,
    "COMPLETED",
  );
  assert.equal(
    categoryDrafts.some(
      (row) => row.conversation_key === d3ConfirmCorrectionContext.conversationKey,
    ),
    false,
  );
  recordD3Case("confirmation after correction", "corrected payload persisted once");

  const d3RejectCorrectionContext = {
    ...contextA,
    conversationKey: "d3-correction-reject",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "D3 Reject Market",
    description: "Original",
    totalAmount: "75000",
    expenseDate: "2026-08-16",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const d3RejectProposal = await conversation.processAgentMessage(
    d3RejectCorrectionContext,
    { message: "Pagué 75000 en D3 Reject Market" },
  );
  const d3RejectBeforeExpenses = createdExpenses.length;
  mockInterpretation = { kind: "CORRECTION", field: "amount", value: "85000" };
  const d3RejectedCorrection = await conversation.processAgentMessage(
    d3RejectCorrectionContext,
    { message: "No, fueron 85000" },
  );
  assert.equal(d3RejectedCorrection.type, "PROPOSAL_UPDATED");
  const d3Rejected = await conversation.processAgentMessage(
    d3RejectCorrectionContext,
    { message: "no" },
  );
  assert.equal(d3Rejected.type, "REJECTED");
  assert.equal(createdExpenses.length, d3RejectBeforeExpenses);
  assert.equal(
    proposals.some((row) => row.id === d3RejectProposal.proposalId),
    false,
  );
  recordD3Case("rejection after correction", "corrected payload rejected without write");

  const d3ResolvedCases = [
    { key: "d3-correction-after-confirm", resolution: "sí" },
    { key: "d3-correction-after-reject", resolution: "no" },
  ];
  for (const { key, resolution } of d3ResolvedCases) {
    const d3Context = { ...contextA, conversationKey: key };
    mockInterpretation = {
      kind: "CREATE_EXPENSE",
      merchant: "D3 Resolved Market",
      description: "Original",
      totalAmount: "76000",
      expenseDate: "2026-08-16",
      paidBySelf: true,
      paidByMemberName: null,
      categoryName: "Food",
    };
    await conversation.processAgentMessage(d3Context, {
      message: "Pagué 76000 en D3 Resolved Market",
    });
    const beforeProposalCount = proposals.length;
    const beforeExpenseCount = createdExpenses.length;
    await conversation.processAgentMessage(d3Context, { message: resolution });
    assert.equal(
      proposals.length,
      resolution === "sí" ? beforeProposalCount : beforeProposalCount - 1,
    );
    assert.equal(
      createdExpenses.length,
      beforeExpenseCount + (resolution === "sí" ? 1 : 0),
    );
    mockInterpretation = { kind: "CORRECTION", field: "amount", value: "86000" };
    const correctedAfterResolution = await conversation.processAgentMessage(
      d3Context,
      { message: "No, fueron 86000" },
    );
    assert.equal(correctedAfterResolution.type, "CLARIFICATION_REQUIRED");
    assert.match(correctedAfterResolution.message, /propuesta activa/);
    assert.equal(
      proposals.length,
      resolution === "sí" ? beforeProposalCount : beforeProposalCount - 1,
    );
    assert.equal(
      createdExpenses.length,
      beforeExpenseCount + (resolution === "sí" ? 1 : 0),
    );
    recordD3Case(`correction after ${resolution === "sí" ? "confirmation" : "rejection"}`, "no mutation");
  }

  const d3IsolationContext = {
    ...contextA,
    conversationKey: "d3-correction-isolation",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "D3 Isolation Market",
    description: "Original",
    totalAmount: "77000",
    expenseDate: "2026-08-16",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const d3IsolationProposal = await conversation.processAgentMessage(
    d3IsolationContext,
    { message: "Pagué 77000 en D3 Isolation Market" },
  );
  const d3IsolationRow = proposals.find(
    (row) => row.id === d3IsolationProposal.proposalId,
  );
  const d3IsolationSnapshot = JSON.stringify(d3IsolationRow);
  const d3IsolationBeforeExpenses = createdExpenses.length;
  for (const foreignContext of [
    { ...d3IsolationContext, conversationKey: "d3-foreign-conversation" },
    { ...d3IsolationContext, householdId: householdB },
  ]) {
    mockInterpretation = { kind: "CORRECTION", field: "amount", value: "87000" };
    const isolatedCorrection = await conversation.processAgentMessage(
      foreignContext,
      { message: "No, fueron 87000" },
    );
    assert.equal(isolatedCorrection.type, "CLARIFICATION_REQUIRED");
    assert.equal(JSON.stringify(d3IsolationRow), d3IsolationSnapshot);
    assert.equal(createdExpenses.length, d3IsolationBeforeExpenses);
  }
  await conversation.processAgentMessage(d3IsolationContext, { message: "no" });
  recordD3Case("correction isolation", "foreign household/conversation cannot mutate proposal");

  assert.equal(d3Results.length, 28);
  console.log(`PASS D3 regression matrix completed (${d3Results.length} cases)`);

  const correctionLikeDraftMessages = [
    "Fueron 70000",
    "No, fueron 80000",
    "Quiero corregir el monto a 80000",
    "El monto debe ser 80000",
  ];
  const operationDraftContext = {
    ...contextA,
    conversationKey: "d3-correction-like-operation-draft",
  };
  mockInterpretation = {
    kind: "AMBIGUOUS_MOVEMENT",
    amount: "1000",
    date: null,
    merchant: "Draft Market",
    description: null,
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: null,
  };
  await conversation.processAgentMessage(operationDraftContext, {
    message: "Registra 1000 en Draft Market",
  });
  const operationDraftRow = categoryDrafts.find(
    (row) => row.conversation_key === operationDraftContext.conversationKey,
  );
  const operationDraftPayload = JSON.stringify(operationDraftRow.payload);
  for (const message of correctionLikeDraftMessages) {
    const result = await conversation.processAgentMessage(
      operationDraftContext,
      { message },
      async () => {
        throw new Error("OpenAI must not receive operation draft replies");
      },
    );
    assert.equal(result.type, "CLARIFICATION_REQUIRED");
    assert.equal(operationDraftRow.status, "AWAITING_OPERATION");
    assert.equal(JSON.stringify(operationDraftRow.payload), operationDraftPayload);
  }
  await conversation.processAgentMessage(operationDraftContext, {
    message: "cancelar",
  });

  const categoryDraftContext = {
    ...contextA,
    conversationKey: "d3-correction-like-category-draft",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Category Draft Market",
    description: null,
    totalAmount: "1000",
    expenseDate: "2026-09-15",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: null,
  };
  await conversation.processAgentMessage(categoryDraftContext, {
    message: "Pagué 1000 en Category Draft Market",
  });
  const categoryDraftRow = categoryDrafts.find(
    (row) => row.conversation_key === categoryDraftContext.conversationKey,
  );
  const categoryDraftPayload = JSON.stringify(categoryDraftRow.payload);
  for (const message of correctionLikeDraftMessages) {
    const result = await conversation.processAgentMessage(
      categoryDraftContext,
      { message },
      async () => {
        throw new Error("OpenAI must not receive category draft replies");
      },
    );
    assert.equal(result.type, "CLARIFICATION_REQUIRED");
    assert.equal(categoryDraftRow.status, "AWAITING_CATEGORY");
    assert.equal(JSON.stringify(categoryDraftRow.payload), categoryDraftPayload);
  }
  await conversation.processAgentMessage(categoryDraftContext, {
    message: "cancelar",
  });

  const detailsDraftContext = {
    ...contextA,
    conversationKey: "d3-correction-like-details-draft",
  };
  mockInterpretation = {
    kind: "AMBIGUOUS_MOVEMENT",
    amount: "1000",
    date: null,
    merchant: "Details Draft Market",
    description: null,
    paidBySelf: false,
    paidByMemberName: null,
    categoryName: null,
  };
  await conversation.processAgentMessage(detailsDraftContext, {
    message: "Registra 1000 en Details Draft Market",
  });
  await conversation.processAgentMessage(detailsDraftContext, {
    message: "gasto",
  });
  const detailsDraftRow = categoryDrafts.find(
    (row) => row.conversation_key === detailsDraftContext.conversationKey,
  );
  const detailsDraftPayload = JSON.stringify(detailsDraftRow.payload);
  for (const message of correctionLikeDraftMessages) {
    const result = await conversation.processAgentMessage(
      detailsDraftContext,
      { message },
      async () => {
        throw new Error("OpenAI must not receive details draft replies");
      },
    );
    assert.equal(result.type, "CLARIFICATION_REQUIRED");
    assert.equal(detailsDraftRow.status, "AWAITING_DETAILS");
    assert.equal(JSON.stringify(detailsDraftRow.payload), detailsDraftPayload);
  }
  await conversation.processAgentMessage(detailsDraftContext, {
    message: "cancelar",
  });
  console.log("PASS correction-like messages preserve AgentDraft states without pending proposals");

  const fallbackPendingContext = {
    ...contextA,
    conversationKey: "d3-correction-fallback-pending",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Fallback Market",
    description: "Original",
    totalAmount: "50000",
    expenseDate: "2026-09-15",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const fallbackProposal = await conversation.processAgentMessage(
    fallbackPendingContext,
    { message: "Pagué 50000 en Fallback Market" },
  );
  assert.equal(fallbackProposal.type, "PROPOSAL_CREATED");
  const fallbackRow = proposals.find(
    (row) => row.id === fallbackProposal.proposalId,
  );
  assert.ok(fallbackRow);
  const fallbackBefore = {
    proposalCount: proposals.length,
    expenseCount: createdExpenses.length,
    incomeCount: createdIncomes.length,
    createdAt: fallbackRow.created_at,
  };
  const fallbackOperationStart = operations.length;
  mockInterpretation = {
    kind: "CORRECTION",
    field: "amount",
    value: "80000",
  };
  const fallbackUpdated = await conversation.processAgentMessage(
    fallbackPendingContext,
    { message: "La cantidad fue 80000" },
  );
  assert.equal(fallbackUpdated.type, "PROPOSAL_UPDATED");
  assert.equal(fallbackUpdated.proposalId, fallbackProposal.proposalId);
  assert.equal(fallbackUpdated.operationType, "CREATE_EXPENSE");
  assert.equal(fallbackUpdated.status, "AWAITING_CONFIRMATION");
  assert.equal(fallbackUpdated.payload.expense.totalAmount, 80000);
  assert.equal(fallbackRow.created_at, fallbackBefore.createdAt);
  assert.equal(proposals.length, fallbackBefore.proposalCount);
  assert.equal(createdExpenses.length, fallbackBefore.expenseCount);
  assert.equal(createdIncomes.length, fallbackBefore.incomeCount);
  assert.equal(
    operations
      .slice(fallbackOperationStart)
      .filter(
        (operation) =>
          operation.type === "from" &&
          operation.table === "tb_pending_proposals",
      ).length,
    2,
  );
  assert.equal(
    operations
      .slice(fallbackOperationStart)
      .filter(
        (operation) =>
          operation.type === "update" &&
          operation.table === "tb_pending_proposals",
      ).length,
    1,
  );
  await conversation.processAgentMessage(fallbackPendingContext, {
    message: "no",
  });
  console.log("PASS contextual CORRECTION fallback updates one pending proposal");

  const fallbackWithoutPendingContext = {
    ...contextA,
    conversationKey: "d3-correction-fallback-without-pending",
  };
  const noPendingBefore = {
    proposalCount: proposals.length,
    expenseCount: createdExpenses.length,
    incomeCount: createdIncomes.length,
  };
  const noPendingOperationStart = operations.length;
  mockInterpretation = {
    kind: "CORRECTION",
    field: "amount",
    value: "80000",
  };
  const noPendingFallback = await conversation.processAgentMessage(
    fallbackWithoutPendingContext,
    { message: "La cantidad fue 80000" },
  );
  assert.equal(noPendingFallback.type, "CLARIFICATION_REQUIRED");
  assert.match(noPendingFallback.message, /propuesta activa/);
  assert.equal(proposals.length, noPendingBefore.proposalCount);
  assert.equal(createdExpenses.length, noPendingBefore.expenseCount);
  assert.equal(createdIncomes.length, noPendingBefore.incomeCount);
  assert.equal(
    operations
      .slice(noPendingOperationStart)
      .filter(
        (operation) =>
          operation.type === "select" &&
          operation.table === "tb_pending_proposals",
      ).length,
    1,
  );
  console.log("PASS contextual CORRECTION fallback without proposal is non-mutating");

  const normalNoFallbackContext = {
    ...contextA,
    conversationKey: "d3-correction-fallback-normal-expense",
  };
  const normalNoFallbackOperationStart = operations.length;
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Normal Market",
    description: null,
    totalAmount: "70000",
    expenseDate: "2026-09-15",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const normalNoFallback = await conversation.processAgentMessage(
    normalNoFallbackContext,
    { message: "Registré 70000 en Normal Market" },
  );
  assert.equal(normalNoFallback.type, "PROPOSAL_CREATED");
  assert.equal(
    operations
      .slice(normalNoFallbackOperationStart)
      .filter(
        (operation) =>
          operation.type === "from" &&
          operation.table === "tb_pending_proposals",
      ).length -
      operations
        .slice(normalNoFallbackOperationStart)
        .filter(
          (operation) =>
            operation.type === "insert" &&
            operation.table === "tb_pending_proposals",
        ).length -
      operations
        .slice(normalNoFallbackOperationStart)
        .filter(
          (operation) =>
            operation.type === "update" &&
            operation.table === "tb_pending_proposals",
        ).length,
    0,
  );
  await conversation.processAgentMessage(normalNoFallbackContext, {
    message: "no",
  });
  console.log("PASS normal creation avoids contextual pending lookup");

  const fallbackIsolationContext = {
    ...contextA,
    conversationKey: "d3-correction-fallback-isolation",
  };
  mockInterpretation = {
    kind: "CREATE_EXPENSE",
    merchant: "Fallback Isolation Market",
    description: "Original",
    totalAmount: "50000",
    expenseDate: "2026-09-15",
    paidBySelf: true,
    paidByMemberName: null,
    categoryName: "Food",
  };
  const fallbackIsolationProposal = await conversation.processAgentMessage(
    fallbackIsolationContext,
    { message: "Pagué 50000 en Fallback Isolation Market" },
  );
  const fallbackIsolationRow = proposals.find(
    (row) => row.id === fallbackIsolationProposal.proposalId,
  );
  const fallbackIsolationSnapshot = JSON.stringify(fallbackIsolationRow);
  const fallbackIsolationBeforeExpenses = createdExpenses.length;
  for (const foreignContext of [
    {
      ...fallbackIsolationContext,
      conversationKey: "d3-correction-fallback-foreign-conversation",
    },
    {
      ...fallbackIsolationContext,
      householdId: householdB,
      actorMemberId: memberB,
    },
  ]) {
    mockInterpretation = {
      kind: "CORRECTION",
      field: "amount",
      value: "81000",
    };
    const isolatedFallback = await conversation.processAgentMessage(
      foreignContext,
      { message: "La cantidad fue 81000" },
    );
    assert.equal(isolatedFallback.type, "CLARIFICATION_REQUIRED");
    assert.match(isolatedFallback.message, /propuesta activa/);
    assert.equal(JSON.stringify(fallbackIsolationRow), fallbackIsolationSnapshot);
    assert.equal(createdExpenses.length, fallbackIsolationBeforeExpenses);
  }
  await conversation.processAgentMessage(fallbackIsolationContext, {
    message: "no",
  });
  console.log("PASS contextual CORRECTION fallback preserves household and conversation isolation");

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
