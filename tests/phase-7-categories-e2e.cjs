const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { types: pgTypes } = require("pg");

// Preserve PostgreSQL timestamp precision used by the draft CAS predicates.
pgTypes.setTypeParser(1114, (value) => value);
pgTypes.setTypeParser(1184, (value) => value);

const root = path.resolve(__dirname, "..");
const clientModule = path.join(root, "infrastructure", "database", "client.ts");
const contextModule = path.join(root, "app", "api", "_lib", "http-context.ts");
const routeModule = path.join(root, "app", "api", "agent", "route.ts");
const openaiAdapterModule = path.join(
  root,
  "infrastructure",
  "openai",
  "openai.adapter.ts",
);

const householdId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const secondUserId = "55555555-5555-4555-8555-555555555555";
const actorMemberId = "33333333-3333-4333-8333-333333333333";
const secondMemberId = "44444444-4444-4444-8444-444444444444";

let currentContext = {
  householdId,
  actorMemberId,
  conversationKey: "e2e-web-expense",
};

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function columnsForSelect(columns) {
  if (columns === "*") return "*";
  return columns
    .split(",")
    .map((column) => quoteIdentifier(column.trim()))
    .join(", ");
}

function normalizeDatabaseValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeDatabaseValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        normalizeDatabaseValue(nested),
      ]),
    );
  }
  return value;
}

class PgSupabaseQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.operation = "select";
    this.filters = [];
    this.orders = [];
    this.payload = null;
    this.selectColumns = "*";
  }

  select(columns) {
    this.selectColumns = columns;
    return this;
  }

  insert(payload) {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }

  update(payload) {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column, value) {
    this.filters.push({ operator: "=", column, value });
    return this;
  }

  in(column, values) {
    this.filters.push({ operator: "IN", column, values });
    return this;
  }

  gte(column, value) {
    this.filters.push({ operator: ">=", column, value });
    return this;
  }

  lte(column, value) {
    this.filters.push({ operator: "<=", column, value });
    return this;
  }

  order(column, options = {}) {
    this.orders.push({
      column,
      ascending: options.ascending !== false,
    });
    return this;
  }

  async execute() {
    const table = quoteIdentifier(this.table);
    const values = [];
    const buildWhere = () =>
      this.filters.map((filter) => {
        const column = quoteIdentifier(filter.column);
        if (filter.operator === "IN") {
          if (filter.values.length === 0) return "FALSE";
          const placeholders = filter.values.map((value) => {
            values.push(value);
            return `$${values.length}`;
          });
          return `${column} IN (${placeholders.join(", ")})`;
        }
        values.push(filter.value);
        return `${column} ${filter.operator} $${values.length}`;
      });
    const orderSql =
      this.orders.length === 0
        ? ""
        : ` ORDER BY ${this.orders
            .map(
              (order) =>
                `${quoteIdentifier(order.column)} ${order.ascending ? "ASC" : "DESC"}`,
            )
            .join(", ")}`;

    let sql;
    if (this.operation === "select") {
      const where = buildWhere();
      const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
      sql = `SELECT ${columnsForSelect(this.selectColumns)} FROM ${table}${whereSql}${orderSql}`;
    } else if (this.operation === "insert") {
      const entries = Object.entries(this.payload);
      const names = entries.map(([name]) => quoteIdentifier(name)).join(", ");
      const placeholders = entries.map(([, value]) => {
        values.push(value);
        return `$${values.length}`;
      });
      sql = `INSERT INTO ${table} (${names}) VALUES (${placeholders.join(", ")}) RETURNING ${columnsForSelect(this.selectColumns)}`;
    } else if (this.operation === "update") {
      const assignments = Object.entries(this.payload).map(([name, value]) => {
        values.push(value);
        return `${quoteIdentifier(name)} = $${values.length}`;
      });
      const where = buildWhere();
      const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
      sql = `UPDATE ${table} SET ${assignments.join(", ")}${whereSql} RETURNING ${columnsForSelect(this.selectColumns)}`;
    } else {
      const where = buildWhere();
      const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
      sql = `DELETE FROM ${table}${whereSql} RETURNING ${columnsForSelect(this.selectColumns)}`;
    }

    try {
      const result = await this.client.query(sql, values);
      return {
        data: result.rows.map(normalizeDatabaseValue),
        error: null,
      };
    } catch (error) {
      return { data: null, error };
    }
  }

  async single() {
    const result = await this.execute();
    if (result.error) return result;
    if (result.data.length !== 1) {
      return {
        data: null,
        error: Object.assign(new Error("Expected exactly one row."), {
          code: "PGRST116",
        }),
      };
    }
    return { data: result.data[0], error: null };
  }

  async maybeSingle() {
    const result = await this.execute();
    if (result.error) return result;
    if (result.data.length > 1) {
      return {
        data: null,
        error: Object.assign(new Error("Expected zero or one row."), {
          code: "PGRST116",
        }),
      };
    }
    return { data: result.data[0] ?? null, error: null };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

class PgSupabaseClient {
  constructor(client) {
    this.client = client;
  }

  from(table) {
    return new PgSupabaseQuery(this.client, table);
  }

  async rpc(name, args) {
    const expenseArgs = [
      args.p_proposal_id,
      args.p_household_id,
      args.p_conversation_key,
      args.p_actor_member_id,
      args.p_context_source,
      args.p_expected_updated_at,
      args.p_created_by,
      args.p_paid_by,
      args.p_category_id,
      args.p_receipt_id,
      args.p_merchant,
      args.p_total_amount,
      args.p_expense_date,
      args.p_description,
      args.p_source,
      args.p_items,
      args.p_distributions,
    ];
    const incomeArgs = [
      args.p_proposal_id,
      args.p_household_id,
      args.p_conversation_key,
      args.p_actor_member_id,
      args.p_context_source,
      args.p_expected_updated_at,
      args.p_created_by,
      args.p_member_id,
      args.p_amount,
      args.p_income_date,
      args.p_description,
      args.p_category_id,
    ];
    const casts = {
      fn_confirm_pending_expense_consistent: [
        "uuid",
        "uuid",
        "text",
        "uuid",
        "public.expense_source",
        "timestamptz",
        "uuid",
        "uuid",
        "uuid",
        "uuid",
        "text",
        "numeric",
        "date",
        "text",
        "public.expense_source",
        "jsonb",
        "jsonb",
      ],
      fn_confirm_pending_income_consistent: [
        "uuid",
        "uuid",
        "text",
        "uuid",
        "public.expense_source",
        "timestamptz",
        "uuid",
        "uuid",
        "numeric",
        "date",
        "text",
        "uuid",
      ],
    };
    const functionCasts = casts[name];
    if (!functionCasts) {
      return {
        data: null,
        error: Object.assign(new Error(`Unexpected RPC ${name}`), {
          code: "UNEXPECTED_RPC",
        }),
      };
    }
    const values =
      name === "fn_confirm_pending_income_consistent"
        ? incomeArgs
        : expenseArgs;
    try {
      const placeholders = functionCasts.map(
        (type, index) => `$${index + 1}::${type}`,
      );
      const queryValues = values.map((value, index) =>
        functionCasts[index] === "jsonb" &&
        value !== null &&
        value !== undefined
          ? JSON.stringify(value)
          : value,
      );
      const result = await this.client.query(
        `SELECT public.${quoteIdentifier(name)}(${placeholders.join(", ")}) AS result`,
        queryValues,
      );
      return {
        data: normalizeDatabaseValue(result.rows[0].result),
        error: null,
      };
    } catch (error) {
      return { data: null, error };
    }
  }
}

async function sqlFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("Could not determine a free port.")),
        );
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function expandIncludes(filePath, stack = []) {
  const absolute = path.resolve(filePath);
  if (stack.includes(absolute)) throw new Error("Circular SQL include.");
  const source = await fs.readFile(absolute, "utf8");
  const lines = source.split(/\r?\n/);
  const expanded = [];
  for (const line of lines) {
    const match = line.match(/^\s*\\ir\s+(.+?)\s*$/);
    if (!match) {
      expanded.push(line);
      continue;
    }
    expanded.push(
      await expandIncludes(path.resolve(path.dirname(absolute), match[1]), [
        ...stack,
        absolute,
      ]),
    );
  }
  return expanded.join("\n");
}

async function removeDatabaseDirectory(databaseDir) {
  const retryable = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(databaseDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retryable.has(error.code) || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function loadModules(realClient, interpreter) {
  const cache = new Map();
  const overrides = new Map([
    [
      path.resolve(clientModule),
      { getSupabaseAdminClient: () => new PgSupabaseClient(realClient) },
    ],
    [
      path.resolve(openaiAdapterModule),
      { interpretExpenseMessage: interpreter },
    ],
    [
      path.resolve(contextModule),
      {
        getConfiguredHttpActorContext: async () => ({
          householdId: currentContext.householdId,
          memberId: currentContext.actorMemberId,
        }),
        getConfiguredHttpConversationKey: () => currentContext.conversationKey,
      },
    ],
  ]);

  function resolve(specifier, parent) {
    if (specifier.startsWith("@/")) {
      return path.join(root, `${specifier.slice(2)}.ts`);
    }
    if (specifier.startsWith(".")) {
      return path.resolve(path.dirname(parent), `${specifier}.ts`);
    }
    return null;
  }

  function load(filename) {
    const resolved = path.resolve(filename);
    if (overrides.has(resolved)) return overrides.get(resolved);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const loaded = { exports: {} };
    cache.set(resolved, loaded);
    const output = ts.transpileModule(
      require("node:fs").readFileSync(resolved, "utf8"),
      {
        compilerOptions: {
          esModuleInterop: true,
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
        fileName: resolved,
      },
    ).outputText;
    const localRequire = (specifier) => {
      const target = resolve(specifier, resolved);
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

async function responseJson(response) {
  const body = await response.json();
  if (response.status !== 200) {
    throw new Error(
      `Unexpected HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function main() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const databaseDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "housemate-ai-category-e2e-"),
  );
  const port = await findFreePort();
  const postgres = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "postgres",
    password: "housemate-category-e2e",
    authMethod: "password",
    persistent: false,
    onLog: () => {},
    onError: (error) => {
      if (process.env.DEBUG_SQL_TESTS === "1") console.error(error);
    },
  });
  let failure;

  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("housemate_e2e");
    const db = postgres.getPgClient("housemate_e2e");
    await db.connect();
    await db.query("CREATE ROLE service_role NOLOGIN");

    for (const migration of await sqlFiles(
      path.join(root, "database", "migrations"),
    )) {
      await db.query(await expandIncludes(migration));
    }
    for (const seed of await sqlFiles(path.join(root, "database", "seeds"))) {
      await db.query(await expandIncludes(seed));
    }
    await db.query(
      `INSERT INTO public.tb_users (id, display_name, external_identifier)
       VALUES ($1, 'E2E User', 'category-e2e-user')`,
      [userId],
    );
    await db.query(
      `INSERT INTO public.tb_users (id, display_name, external_identifier)
       VALUES ($1, 'E2E Member', 'category-e2e-member')`,
      [secondUserId],
    );
    await db.query(
      `INSERT INTO public.tb_households (id, name) VALUES ($1, 'Category E2E Household')`,
      [householdId],
    );
    await db.query(
      `INSERT INTO public.tb_household_members (id, household_id, user_id, display_name)
       VALUES ($1, $2, $3, 'E2E Actor'), ($4, $2, $5, 'E2E Member')`,
      [actorMemberId, householdId, userId, secondMemberId, secondUserId],
    );

    const expectedExpenseCategory = (
      await db.query(
        `SELECT id, parent_id FROM public.tb_categories
         WHERE movement_type = 'EXPENSE' AND level = 'MICRO' AND name = 'Supermercado'`,
      )
    ).rows[0];
    const expectedIncomeCategory = (
      await db.query(
        `SELECT id, parent_id FROM public.tb_categories
         WHERE movement_type = 'INCOME' AND level = 'MICRO' AND name = 'Sueldo mensual'`,
      )
    ).rows[0];
    assert.ok(expectedExpenseCategory && expectedIncomeCategory);

    const interpreter = async (message) => {
      if (message === "Registra gasto E2E") {
        return {
          kind: "CREATE_EXPENSE",
          merchant: "Mercado E2E",
          description: "Compra E2E",
          totalAmount: "50000",
          expenseDate: "2026-09-23",
          paidBySelf: true,
          paidByMemberName: null,
          categoryName: null,
        };
      }
      if (message === "Recibí ingreso E2E") {
        return {
          kind: "CREATE_INCOME",
          amount: "3000000",
          incomeDate: "2026-09-23",
          description: "Salario E2E",
          categoryName: null,
        };
      }
      if (message === "Registra gasto corrección E2E") {
        return {
          kind: "CREATE_EXPENSE",
          merchant: "Corrección E2E",
          description: "Categoría corregible",
          totalAmount: "12000",
          expenseDate: "2026-09-23",
          paidBySelf: true,
          paidByMemberName: null,
          categoryName: "Supermercado",
        };
      }
      if (message === "Corrige la categoría a Gasolina") {
        return { kind: "CORRECTION", field: "category", value: "Gasolina" };
      }
      throw new Error(`Unexpected deterministic Agent message: ${message}`);
    };
    const load = loadModules(db, interpreter);
    const route = load(routeModule);

    async function send(message) {
      const response = await route.POST(
        new Request("http://localhost/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        }),
      );
      return responseJson(response);
    }

    currentContext = { ...currentContext, conversationKey: "e2e-web-expense" };
    const expenseStart = await send("Registra gasto E2E");
    assert.equal(expenseStart.data.type, "CLARIFICATION_REQUIRED");
    assert.match(expenseStart.data.message, /categoría/i);
    assert.ok(
      expenseStart.data.options?.some(
        (option) => option.name === "Alimentación",
      ),
    );

    const expenseMacro = await send("Alimentación");
    assert.equal(expenseMacro.data.type, "CLARIFICATION_REQUIRED");
    assert.match(expenseMacro.data.message, /categoría específica/i);
    assert.ok(
      expenseMacro.data.options?.some(
        (option) => option.name === "Alimentación → Supermercado",
      ),
    );

    const expenseProposal = await send("Supermercado");
    assert.equal(expenseProposal.data.type, "PROPOSAL_CREATED");
    const expenseProposalRow = (
      await db.query(
        `SELECT id, status, operation_type, payload
         FROM public.tb_pending_proposals WHERE id = $1`,
        [expenseProposal.data.proposalId],
      )
    ).rows[0];
    assert.equal(expenseProposalRow.status, "AWAITING_CONFIRMATION");
    assert.equal(expenseProposalRow.operation_type, "CREATE_EXPENSE");
    assert.equal(
      expenseProposalRow.payload.expense.categoryId,
      expectedExpenseCategory.id,
    );

    const expenseConfirmation = await send("Sí");
    assert.equal(expenseConfirmation.data.type, "CONFIRMED");
    const expenseRows = (
      await db.query(
        `SELECT e.id, e.category_id, e.status, c.level, c.movement_type,
                p.status AS proposal_status, p.expense_id
         FROM public.tb_expenses e
         JOIN public.tb_categories c ON c.id = e.category_id
         JOIN public.tb_pending_proposals p ON p.id = $1
         WHERE e.id = $2 AND e.household_id = $3`,
        [
          expenseProposal.data.proposalId,
          expenseConfirmation.data.expenseId,
          householdId,
        ],
      )
    ).rows;
    assert.equal(expenseRows.length, 1);
    assert.equal(expenseRows[0].category_id, expectedExpenseCategory.id);
    assert.equal(expenseRows[0].level, "MICRO");
    assert.equal(expenseRows[0].movement_type, "EXPENSE");
    assert.equal(expenseRows[0].status, "CONFIRMED");
    assert.equal(expenseRows[0].proposal_status, "COMPLETED");
    assert.equal(expenseRows[0].expense_id, expenseConfirmation.data.expenseId);
    const expenseCount = await db.query(
      `SELECT COUNT(*)::int AS count FROM public.tb_expenses WHERE household_id = $1`,
      [householdId],
    );
    assert.equal(expenseCount.rows[0].count, 1);
    console.log(
      "PASS real Web conversation Expense macro → micro → RPC → PostgreSQL",
    );

    currentContext = { ...currentContext, conversationKey: "e2e-web-income" };
    const incomeStart = await send("Recibí ingreso E2E");
    assert.equal(incomeStart.data.type, "CLARIFICATION_REQUIRED");
    assert.ok(
      incomeStart.data.options?.some((option) => option.name === "Salario"),
    );
    const incomeMacro = await send("Salario");
    assert.equal(incomeMacro.data.type, "CLARIFICATION_REQUIRED");
    assert.ok(
      incomeMacro.data.options?.some(
        (option) => option.name === "Salario → Sueldo mensual",
      ),
    );
    const incomeProposal = await send("Sueldo mensual");
    assert.equal(incomeProposal.data.type, "PROPOSAL_CREATED");
    const incomeProposalRow = (
      await db.query(
        `SELECT status, operation_type, payload
         FROM public.tb_pending_proposals WHERE id = $1`,
        [incomeProposal.data.proposalId],
      )
    ).rows[0];
    assert.equal(incomeProposalRow.status, "AWAITING_CONFIRMATION");
    assert.equal(incomeProposalRow.operation_type, "CREATE_INCOME");
    assert.equal(
      incomeProposalRow.payload.income.categoryId,
      expectedIncomeCategory.id,
    );
    const incomeConfirmation = await send("Sí");
    assert.equal(incomeConfirmation.data.type, "CONFIRMED");
    const incomeRows = (
      await db.query(
        `SELECT i.id, i.category_id, c.level, c.movement_type,
                p.status AS proposal_status, p.income_id
         FROM public.tb_incomes i
         JOIN public.tb_categories c ON c.id = i.category_id
         JOIN public.tb_pending_proposals p ON p.id = $1
         WHERE i.id = $2 AND i.household_id = $3`,
        [
          incomeProposal.data.proposalId,
          incomeConfirmation.data.incomeId,
          householdId,
        ],
      )
    ).rows;
    assert.equal(incomeRows.length, 1);
    assert.equal(incomeRows[0].category_id, expectedIncomeCategory.id);
    assert.equal(incomeRows[0].level, "MICRO");
    assert.equal(incomeRows[0].movement_type, "INCOME");
    assert.equal(incomeRows[0].proposal_status, "COMPLETED");
    assert.equal(incomeRows[0].income_id, incomeConfirmation.data.incomeId);
    const incomeCount = await db.query(
      `SELECT COUNT(*)::int AS count FROM public.tb_incomes WHERE household_id = $1`,
      [householdId],
    );
    assert.equal(incomeCount.rows[0].count, 1);
    const crossTypeExpenseCount = await db.query(
      `SELECT COUNT(*)::int AS count FROM public.tb_expenses WHERE household_id = $1`,
      [householdId],
    );
    assert.equal(crossTypeExpenseCount.rows[0].count, 1);
    console.log(
      "PASS real Web conversation Income macro → micro → RPC → PostgreSQL",
    );

    currentContext = {
      ...currentContext,
      conversationKey: "e2e-web-macro-only",
    };
    const macroOnlyStart = await send("Registra gasto E2E");
    assert.equal(macroOnlyStart.data.type, "CLARIFICATION_REQUIRED");
    const macroOnlyReply = await send("Alimentación");
    assert.equal(macroOnlyReply.data.type, "CLARIFICATION_REQUIRED");
    assert.match(macroOnlyReply.data.message, /categoría específica/i);
    const macroOnlyProposalCount = await db.query(
      `SELECT COUNT(*)::int AS count FROM public.tb_pending_proposals
       WHERE household_id = $1 AND conversation_key = $2`,
      [householdId, currentContext.conversationKey],
    );
    assert.equal(macroOnlyProposalCount.rows[0].count, 0);
    console.log("PASS macro cannot become a final financial category");

    currentContext = {
      ...currentContext,
      conversationKey: "e2e-web-wrong-type",
    };
    const wrongTypeStart = await send("Registra gasto E2E");
    assert.equal(wrongTypeStart.data.type, "CLARIFICATION_REQUIRED");
    const wrongTypeReply = await send("Salario");
    assert.equal(wrongTypeReply.data.type, "CLARIFICATION_REQUIRED");
    assert.match(wrongTypeReply.data.message, /categoría/i);
    const wrongTypeProposalCount = await db.query(
      `SELECT COUNT(*)::int AS count FROM public.tb_pending_proposals
       WHERE household_id = $1 AND conversation_key = $2`,
      [householdId, currentContext.conversationKey],
    );
    assert.equal(wrongTypeProposalCount.rows[0].count, 0);
    console.log("PASS wrong movement type cannot create an Expense proposal");

    currentContext = {
      ...currentContext,
      conversationKey: "e2e-web-category-correction",
    };
    const correctionProposal = await send("Registra gasto corrección E2E");
    assert.equal(correctionProposal.data.type, "PROPOSAL_CREATED");
    const corrected = await send("Corrige la categoría a Gasolina");
    assert.equal(corrected.data.type, "PROPOSAL_UPDATED");
    assert.equal(corrected.data.proposalId, correctionProposal.data.proposalId);
    const correctedRow = (
      await db.query(
        `SELECT payload FROM public.tb_pending_proposals WHERE id = $1`,
        [correctionProposal.data.proposalId],
      )
    ).rows[0];
    const expectedCorrectedCategory = (
      await db.query(
        `SELECT id FROM public.tb_categories
         WHERE movement_type = 'EXPENSE' AND level = 'MICRO' AND name = 'Gasolina'`,
      )
    ).rows[0];
    assert.equal(
      correctedRow.payload.expense.categoryId,
      expectedCorrectedCategory.id,
    );
    const correctedConfirmation = await send("Sí");
    assert.equal(correctedConfirmation.data.type, "CONFIRMED");
    const correctedPersisted = (
      await db.query(
        `SELECT category_id FROM public.tb_expenses WHERE id = $1`,
        [correctedConfirmation.data.expenseId],
      )
    ).rows[0];
    assert.equal(correctedPersisted.category_id, expectedCorrectedCategory.id);
    console.log(
      "PASS real Web category correction preserves proposal and persists the new MICRO",
    );

    await db.end();
    console.log("PASS phase-7 category E2E completed on isolated PostgreSQL");
  } catch (error) {
    failure = error;
  } finally {
    let postgresStopped = false;
    try {
      await postgres.stop();
      postgresStopped = true;
    } catch (error) {
      if (error.code === "EBUSY" || error.code === "ENOTEMPTY") {
        try {
          await removeDatabaseDirectory(databaseDir);
          postgresStopped = true;
        } catch (cleanupError) {
          failure ??= cleanupError;
        }
      } else {
        failure ??= error;
      }
    }
    if (!postgresStopped) {
      try {
        await removeDatabaseDirectory(databaseDir);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure) throw failure;
}

main().catch((error) => {
  console.error(`FAIL phase-7 category E2E: ${error.stack || error.message}`);
  process.exitCode = 1;
});
