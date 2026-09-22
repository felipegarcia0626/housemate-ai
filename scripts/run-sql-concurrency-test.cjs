const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const householdId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000021";
const expenseCategoryId = "00000000-0000-4000-8000-000000000031";
const incomeCategoryId = "00000000-0000-4000-8000-000000000033";
const advisoryLockKey = 2718281828;
const triggerName = "housemate_2l3_pause_proposal_update";
const triggerFunction = "housemate_2l3_pause_proposal_update";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine a free port.")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function sqlFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function expandPsqlIncludes(filePath, stack = []) {
  const absolutePath = path.resolve(filePath);
  if (stack.includes(absolutePath)) {
    throw new Error(
      `Circular SQL include detected: ${[...stack, absolutePath].join(" -> ")}`,
    );
  }

  const source = await fs.readFile(absolutePath, "utf8");
  const expanded = [];
  for (const line of source.split(/\r?\n/)) {
    const includeMatch = line.match(/^\s*\\ir\s+(.+?)\s*$/);
    if (!includeMatch) {
      expanded.push(line);
      continue;
    }
    expanded.push(
      await expandPsqlIncludes(
        path.resolve(path.dirname(absolutePath), includeMatch[1]),
        [...stack, absolutePath],
      ),
    );
  }
  return expanded.join("\n");
}

async function runSqlFile(client, filePath) {
  await client.query(await expandPsqlIncludes(filePath));
}

async function removeDatabaseDirectory(databaseDir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(databaseDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      if (attempt === 19) throw error;
      await sleep(500);
    }
  }
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timeout: ${message}`);
}

async function connectClient(postgres) {
  const client = postgres.getPgClient("housemate_test");
  await client.connect();
  return client;
}

async function createPauseTrigger(controller) {
  await controller.query(`
    CREATE OR REPLACE FUNCTION public.${triggerFunction}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $trigger$
    BEGIN
      IF OLD.status = 'AWAITING_CONFIRMATION'
         AND NEW.status = 'COMPLETED' THEN
        PERFORM pg_advisory_lock(${advisoryLockKey});
      END IF;
      RETURN NEW;
    END;
    $trigger$;

    CREATE TRIGGER ${triggerName}
    BEFORE UPDATE OF status ON public.tb_pending_proposals
    FOR EACH ROW
    EXECUTE FUNCTION public.${triggerFunction}();
  `);
}

async function dropPauseTrigger(controller) {
  await controller.query(`
    DROP TRIGGER IF EXISTS ${triggerName}
      ON public.tb_pending_proposals;
    DROP FUNCTION IF EXISTS public.${triggerFunction}();
  `);
}

async function waitForAdvisoryWait(controller, pid) {
  await waitFor(async () => {
    const { rows } = await controller.query(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_locks
         WHERE pid = $1
           AND locktype = 'advisory'
           AND granted = false
       ) AS waiting`,
      [pid],
    );
    return rows[0].waiting === true;
  }, "T1 did not reach the synchronization lock");
}

async function waitForRowLockWait(controller, pid) {
  await waitFor(async () => {
    const { rows } = await controller.query(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    );
    return rows[0]?.wait_event_type === "Lock";
  }, "T2 did not wait for the PendingProposal row lock");
}

function proposalIdFor(round, movement) {
  const suffix = String(100 + round * 2 + (movement === "EXPENSE" ? 1 : 2)).padStart(
    12,
    "0",
  );
  return `30000000-0000-4000-8000-${suffix}`;
}

async function runConcurrentRound({ controller, postgres, round, movement }) {
  const isExpense = movement === "EXPENSE";
  const proposalId = proposalIdFor(round, movement);
  const conversationKey = `2l3-${movement.toLowerCase()}-${round}`;
  const updatedAt = "2000-01-01 00:00:00+00";
  const merchant = `2L3 ${movement} merchant ${round}`;
  const description = `2L3 ${movement} description ${round}`;

  await controller.query(
    `INSERT INTO public.tb_pending_proposals (
       id, household_id, conversation_key, operation_type, payload,
       status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, 'AWAITING_CONFIRMATION', $6, $6)`,
    [
      proposalId,
      householdId,
      conversationKey,
      isExpense ? "CREATE_EXPENSE" : "CREATE_INCOME",
      JSON.stringify({ actorMemberId: memberId, source: "WEB" }),
      updatedAt,
    ],
  );

  const c1 = await connectClient(postgres);
  const c2 = await connectClient(postgres);
  let firstQuery;
  let secondQuery;
  try {
    await controller.query("SELECT pg_advisory_lock($1)", [advisoryLockKey]);
    await c1.query("BEGIN");
    await c2.query("BEGIN");

    if (isExpense) {
      firstQuery = c1.query(
        `SELECT public.fn_confirm_pending_expense_consistent(
           $1, $2, $3, $4, 'WEB'::public.expense_source, $5,
           $4, $4, $6, NULL, $7, 100.00, '2026-09-01', $8,
           'WEB'::public.expense_source,
           $9::jsonb, $10::jsonb
         ) AS result`,
        [
          proposalId,
          householdId,
          conversationKey,
          memberId,
          updatedAt,
          expenseCategoryId,
          merchant,
          `2L3 expense item ${round}`,
          JSON.stringify([{ name: `item-${round}`, totalAmount: 100 }]),
          JSON.stringify([
            { householdMemberId: memberId, amount: 100, percentage: 100 },
          ]),
        ],
      );
    } else {
      firstQuery = c1.query(
        `SELECT public.fn_confirm_pending_income_consistent(
           $1, $2, $3, $4, 'WEB'::public.expense_source, $5,
           $4, $4, 200.00, '2026-09-01', $6, $7
         ) AS result`,
        [
          proposalId,
          householdId,
          conversationKey,
          memberId,
          updatedAt,
          description,
          incomeCategoryId,
        ],
      );
    }

    await waitForAdvisoryWait(controller, c1.processID);

    if (isExpense) {
      secondQuery = c2.query(
        `SELECT public.fn_confirm_pending_expense_consistent(
           $1, $2, $3, $4, 'WEB'::public.expense_source,
           $5, $4, $4, $6, NULL, $7, 100.00, '2026-09-01', $8,
           'WEB'::public.expense_source,
           $9::jsonb, $10::jsonb
         ) AS result`,
        [
          proposalId,
          householdId,
          conversationKey,
          memberId,
          updatedAt,
          expenseCategoryId,
          merchant,
          `2L3 expense item ${round}`,
          JSON.stringify([{ name: `item-${round}`, totalAmount: 100 }]),
          JSON.stringify([
            { householdMemberId: memberId, amount: 100, percentage: 100 },
          ]),
        ],
      );
    } else {
      secondQuery = c2.query(
        `SELECT public.fn_confirm_pending_income_consistent(
           $1, $2, $3, $4, 'WEB'::public.expense_source,
           $5, $4, $4, 200.00, '2026-09-01', $6, $7
         ) AS result`,
        [
          proposalId,
          householdId,
          conversationKey,
          memberId,
          updatedAt,
          description,
          incomeCategoryId,
        ],
      );
    }

    await waitForRowLockWait(controller, c2.processID);
    await controller.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);

    const firstResult = (await firstQuery).rows[0].result;
    await c1.query("COMMIT");
    const secondResult = (await secondQuery).rows[0].result;
    await c2.query("COMMIT");

    assert.equal(firstResult.status, "CREATED");
    assert.equal(secondResult.status, "ALREADY_COMPLETED");
    const referenceId = isExpense
      ? firstResult.expense_id
      : firstResult.income_id;
    assert.ok(referenceId);

    const { rows: proposalRows } = await controller.query(
      `SELECT status, expense_id, income_id
         FROM public.tb_pending_proposals
        WHERE id = $1`,
      [proposalId],
    );
    assert.equal(proposalRows.length, 1);
    assert.equal(proposalRows[0].status, "COMPLETED");
    assert.equal(proposalRows[0].expense_id, isExpense ? referenceId : null);
    assert.equal(proposalRows[0].income_id, isExpense ? null : referenceId);

    const { rows: expenseRows } = await controller.query(
      "SELECT id FROM public.tb_expenses WHERE merchant = $1",
      [merchant],
    );
    const { rows: incomeRows } = await controller.query(
      "SELECT id FROM public.tb_incomes WHERE description = $1",
      [description],
    );
    assert.equal(expenseRows.length, isExpense ? 1 : 0);
    assert.equal(incomeRows.length, isExpense ? 0 : 1);
    assert.equal(
      (isExpense ? expenseRows[0]?.id : incomeRows[0]?.id),
      referenceId,
    );
    console.log(
      `PASS 2L3 ${movement.toLowerCase()} concurrency round ${round}: one write, one idempotent result`,
    );
  } finally {
    await controller.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]).catch(() => {});
    await Promise.allSettled([firstQuery, secondQuery]);
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    await c1.end().catch(() => {});
    await c2.end().catch(() => {});
  }
}

async function main() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const databaseDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "housemate-ai-sql-concurrency-"),
  );
  const postgres = new EmbeddedPostgres({
    databaseDir,
    port: await findFreePort(),
    user: "postgres",
    password: "housemate-sql-test",
    authMethod: "password",
    persistent: false,
    onLog: () => {},
    onError: (error) => {
      if (process.env.DEBUG_SQL_TESTS === "1") console.error(error);
    },
  });
  let controller;
  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("housemate_test");

    controller = await connectClient(postgres);
    await controller.query("CREATE ROLE service_role NOLOGIN");

    const migrationDirectory = path.join(
      repositoryRoot,
      "database",
      "migrations",
    );
    const seedDirectory = path.join(repositoryRoot, "database", "seeds");
    for (const migrationPath of await sqlFiles(migrationDirectory)) {
      await runSqlFile(controller, migrationPath);
    }
    for (let pass = 1; pass <= 2; pass += 1) {
      for (const seedPath of await sqlFiles(seedDirectory)) {
        await runSqlFile(controller, seedPath);
      }
    }

    await createPauseTrigger(controller);
    for (let round = 1; round <= 10; round += 1) {
      await runConcurrentRound({
        controller,
        postgres,
        round,
        movement: "EXPENSE",
      });
      await runConcurrentRound({
        controller,
        postgres,
        round,
        movement: "INCOME",
      });
    }
    await dropPauseTrigger(controller);
    console.log("PASS 2L3 concurrency harness completed: 20 rounds");
  } finally {
    if (controller) await controller.end().catch(() => {});
    await postgres.stop().catch(() => {});
    await removeDatabaseDirectory(databaseDir);
  }
}

main().catch((error) => {
  console.error(`FAIL 2L3 concurrency harness: ${error.message}`);
  process.exit(1);
});
