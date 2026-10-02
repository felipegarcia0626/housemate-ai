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
const provisioningTriggerName = "housemate_test_pause_provisioning_user";
const provisioningTriggerFunction = "housemate_test_pause_provisioning_user";
const provisioningAdvisoryLockKey = 3141592653;

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
        server.close(() =>
          reject(new Error("Could not determine a free port.")),
        );
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
         AND NEW.status IN ('COMPLETED', 'REJECTED') THEN
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

async function createProvisioningPauseTrigger(controller) {
  await controller.query(`
    CREATE OR REPLACE FUNCTION public.${provisioningTriggerFunction}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $trigger$
    BEGIN
      PERFORM pg_advisory_xact_lock(${provisioningAdvisoryLockKey});
      RETURN NEW;
    END;
    $trigger$;

    CREATE TRIGGER ${provisioningTriggerName}
    BEFORE INSERT ON public.tb_users
    FOR EACH ROW
    EXECUTE FUNCTION public.${provisioningTriggerFunction}();
  `);
}

async function dropProvisioningPauseTrigger(controller) {
  await controller.query(`
    DROP TRIGGER IF EXISTS ${provisioningTriggerName}
      ON public.tb_users;
    DROP FUNCTION IF EXISTS public.${provisioningTriggerFunction}();
  `);
}

async function startProvisionTransaction(
  postgres,
  authUserId,
  displayName,
  householdName,
) {
  const client = await connectClient(postgres);
  try {
    await client.query("BEGIN");
    const resultPromise = client
      .query(
        `SELECT public.fn_provision_authenticated_user($1, $2, $3) AS result`,
        [authUserId, displayName, householdName],
      )
      .then(({ rows }) => rows[0].result);
    return { client, pid: client.processID, resultPromise };
  } catch (error) {
    try {
      await client.end();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Provisioning transaction startup cleanup failed.",
      );
    }
    throw error;
  }
}

async function finishProvisionTransaction(transaction, commit) {
  let transactionError;
  try {
    await transaction.client.query(commit ? "COMMIT" : "ROLLBACK");
    transaction.finished = true;
  } catch (error) {
    transactionError = error;
  } finally {
    try {
      await transaction.client.end();
    } catch (closeError) {
      if (transactionError) {
        throw new AggregateError(
          [transactionError, closeError],
          "Provisioning transaction cleanup failed.",
        );
      }
      throw closeError;
    }
  }
  if (transactionError) {
    throw transactionError;
  }
}

async function waitForProvisioningLock(controller, pid, granted) {
  await waitFor(async () => {
    const { rows } = await controller.query(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_locks
          WHERE pid = $1
            AND locktype = 'advisory'
            AND classid = 0
            AND objid = $2
            AND granted = $3
       ) AS present`,
      [pid, provisioningAdvisoryLockKey, granted],
    );
    return rows[0].present === true;
  }, granted ? "first provisioning transaction did not acquire lock" : "second provisioning transaction did not wait for lock");
}

async function runProvisioningRace(
  controller,
  postgres,
  authUserId,
  firstName,
  secondName,
  householdName,
) {
  const first = await startProvisionTransaction(
    postgres,
    authUserId,
    firstName,
    householdName,
  );
  let second;
  try {
    await waitForProvisioningLock(controller, first.pid, true);
    second = await startProvisionTransaction(
      postgres,
      authUserId,
      secondName,
      householdName,
    );
    await waitForProvisioningLock(controller, second.pid, false);
    const firstResult = await first.resultPromise;
    await finishProvisionTransaction(first, true);
    const secondResult = await second.resultPromise;
    await finishProvisionTransaction(second, true);
    return [firstResult, secondResult];
  } catch (error) {
    const cleanupErrors = [];
    try {
    if (!first.finished) await finishProvisionTransaction(first, false);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (second) {
      try {
      if (!second.finished) await finishProvisionTransaction(second, false);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Provisioning race and cleanup failed.",
      );
    }
    throw error;
  }
}

async function assertProvisioningState(controller, authUserId) {
  const { rows } = await controller.query(
    `SELECT
       (SELECT count(*)::int FROM public.tb_users WHERE auth_user_id = $1) AS user_count,
       (SELECT count(*)::int
          FROM public.tb_household_members member
          JOIN public.tb_users app_user ON app_user.id = member.user_id
         WHERE app_user.auth_user_id = $1) AS membership_count,
       (SELECT count(*)::int
          FROM public.tb_households household
          JOIN public.tb_household_members member
            ON member.household_id = household.id
          JOIN public.tb_users app_user ON app_user.id = member.user_id
         WHERE app_user.auth_user_id = $1) AS household_count`,
    [authUserId],
  );
  assert.deepEqual(rows[0], {
    user_count: 1,
    membership_count: 1,
    household_count: 1,
  });
}

async function cleanupProvisioningScenario(controller, authUserId, householdId) {
  await controller.query(
    `DELETE FROM public.tb_household_members
      WHERE user_id IN (
        SELECT id FROM public.tb_users WHERE auth_user_id = $1
      )`,
    [authUserId],
  );
  await controller.query(
    `DELETE FROM public.tb_households
      WHERE id = $1`,
    [householdId],
  );
  await controller.query(
    `DELETE FROM public.tb_users WHERE auth_user_id = $1`,
    [authUserId],
  );
}

async function runProvisioningConcurrencyScenarios({ controller, postgres }) {
  const newAuthUserId = "b0000000-0000-4000-8000-000000000001";
  const partialAuthUserId = "b0000000-0000-4000-8000-000000000002";
  const partialExternalId = "e2e-provision-partial-0002";
  const scenarioHouseholdName = "E2E Provisioning Household 0001";
  const partialHouseholdName = "E2E Provisioning Household 0002";

  try {
    await createProvisioningPauseTrigger(controller);

    const firstResults = await runProvisioningRace(
      controller,
      postgres,
      newAuthUserId,
      "Concurrent One",
      "Concurrent Two",
      scenarioHouseholdName,
    );
    assert.deepEqual(
      firstResults.map((result) => result.status).sort(),
      ["ALREADY_PROVISIONED", "PROVISIONING_COMPLETED"],
    );
    await assertProvisioningState(controller, newAuthUserId);
    console.log("PASS provisioning new-user race: one completion, one idempotent result, one user/household/membership");

    const { rows: partialRows } = await controller.query(
      `INSERT INTO public.tb_users (display_name, external_identifier, auth_user_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Partial User", partialExternalId, partialAuthUserId],
    );
    assert.equal(partialRows.length, 1);
    const partialResults = await runProvisioningRace(
      controller,
      postgres,
      partialAuthUserId,
      "Partial One",
      "Partial Two",
      partialHouseholdName,
    );
    assert.deepEqual(
      partialResults.map((result) => result.status).sort(),
      ["ALREADY_PROVISIONED", "PROVISIONING_COMPLETED"],
    );
    await assertProvisioningState(controller, partialAuthUserId);
    console.log("PASS provisioning partial-user race: one completion, one idempotent result, one user/household/membership");

    const repeatClient = await connectClient(postgres);
    let repeatResult;
    try {
      const { rows: repeatRows } = await repeatClient.query(
        `SELECT public.fn_provision_authenticated_user($1, $2, $3) AS result`,
        [newAuthUserId, "Repeat Name", "Repeat Household"],
      );
      repeatResult = repeatRows[0].result;
    } finally {
      await repeatClient.end();
    }
    assert.equal(repeatResult.status, "ALREADY_PROVISIONED");
    await assertProvisioningState(controller, newAuthUserId);
    console.log("PASS provisioning sequential repeat: idempotent result and stable relationship counts");
  } finally {
    await dropProvisioningPauseTrigger(controller);
    const { rows: scenarioRows } = await controller.query(
      `SELECT household_id FROM public.tb_household_members member
        JOIN public.tb_users app_user ON app_user.id = member.user_id
       WHERE app_user.auth_user_id = $1`,
      [newAuthUserId],
    );
    const { rows: partialScenarioRows } = await controller.query(
      `SELECT household_id FROM public.tb_household_members member
        JOIN public.tb_users app_user ON app_user.id = member.user_id
       WHERE app_user.auth_user_id = $1`,
      [partialAuthUserId],
    );
    if (scenarioRows[0]) {
      await cleanupProvisioningScenario(controller, newAuthUserId, scenarioRows[0].household_id);
    }
    if (partialScenarioRows[0]) {
      await cleanupProvisioningScenario(controller, partialAuthUserId, partialScenarioRows[0].household_id);
    }
  }
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
  const suffix = String(
    100 + round * 2 + (movement === "EXPENSE" ? 1 : 2),
  ).padStart(12, "0");
  return `30000000-0000-4000-8000-${suffix}`;
}

function startConfirmQuery(
  client,
  {
    movement,
    proposalId,
    conversationKey,
    updatedAt,
    merchant,
    description,
    round,
    expenseDescription = `2L3 expense item ${round}`,
    expenseItemName = `item-${round}`,
  },
) {
  if (movement === "EXPENSE") {
    return client.query(
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
        expenseDescription,
        JSON.stringify([{ name: expenseItemName, totalAmount: 100 }]),
        JSON.stringify([
          { householdMemberId: memberId, amount: 100, percentage: 100 },
        ]),
      ],
    );
  }

  return client.query(
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

function startRejectQuery(client, { movement, proposalId, conversationKey }) {
  return client.query(
    `SELECT public.fn_reject_pending_proposal(
       $1, $2, $3, $4, 'WEB'::public.expense_source,
       $5::public.pending_operation_type
     ) AS result`,
    [
      proposalId,
      householdId,
      conversationKey,
      memberId,
      movement === "EXPENSE" ? "CREATE_EXPENSE" : "CREATE_INCOME",
    ],
  );
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

    firstQuery = startConfirmQuery(c1, {
      movement,
      proposalId,
      conversationKey,
      updatedAt,
      merchant,
      description,
      round,
    });

    await waitForAdvisoryWait(controller, c1.processID);

    secondQuery = startConfirmQuery(c2, {
      movement,
      proposalId,
      conversationKey,
      updatedAt,
      merchant,
      description,
      round,
    });

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
      isExpense ? expenseRows[0]?.id : incomeRows[0]?.id,
      referenceId,
    );
    console.log(
      `PASS 2L3 ${movement.toLowerCase()} concurrency round ${round}: one write, one idempotent result`,
    );
  } finally {
    await controller
      .query("SELECT pg_advisory_unlock($1)", [advisoryLockKey])
      .catch(() => {});
    await Promise.allSettled([firstQuery, secondQuery]);
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    await c1.end().catch(() => {});
    await c2.end().catch(() => {});
  }
}

async function runConfirmRejectRound({
  controller,
  postgres,
  round,
  movement,
  firstOperation,
}) {
  const isExpense = movement === "EXPENSE";
  const proposalId = proposalIdFor(
    1000 + round * 2 + (firstOperation === "CONFIRM" ? 1 : 2),
    movement,
  );
  const conversationKey = `2r2-${movement.toLowerCase()}-${firstOperation.toLowerCase()}-${round}`;
  const updatedAt = "2000-01-01 00:00:00+00";
  const merchant = `2R2 ${movement} merchant ${firstOperation} ${round}`;
  const description = `2R2 ${movement} description ${firstOperation} ${round}`;

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

    const firstArgs = {
      movement,
      proposalId,
      conversationKey,
      updatedAt,
      merchant,
      description,
      round,
      expenseDescription: description,
      expenseItemName: `2R2 expense item ${round}`,
    };
    const firstIsConfirm = firstOperation === "CONFIRM";
    firstQuery = firstIsConfirm
      ? startConfirmQuery(c1, firstArgs)
      : startRejectQuery(c1, firstArgs);

    await waitForAdvisoryWait(controller, c1.processID);

    secondQuery = firstIsConfirm
      ? startRejectQuery(c2, firstArgs)
      : startConfirmQuery(c2, firstArgs);

    await waitForRowLockWait(controller, c2.processID);
    await controller.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);

    const firstResult = (await firstQuery).rows[0].result;
    await c1.query("COMMIT");
    const secondResult = (await secondQuery).rows[0].result;
    await c2.query("COMMIT");

    const { rows: proposalRows } = await controller.query(
      `SELECT id, household_id, conversation_key, actor_member_id, source,
              operation_type, status, expense_id, income_id
         FROM public.tb_pending_proposals
        WHERE id = $1`,
      [proposalId],
    );
    assert.equal(proposalRows.length, 1);
    const proposalRow = proposalRows[0];
    assert.equal(proposalRow.household_id, householdId);
    assert.equal(proposalRow.conversation_key, conversationKey);
    assert.equal(proposalRow.actor_member_id, memberId);
    assert.equal(proposalRow.source, "WEB");
    assert.equal(
      proposalRow.operation_type,
      isExpense ? "CREATE_EXPENSE" : "CREATE_INCOME",
    );
    assert.notEqual(proposalRow.status, "AWAITING_CONFIRMATION");

    const { rows: expenseRows } = await controller.query(
      "SELECT id FROM public.tb_expenses WHERE merchant = $1",
      [merchant],
    );
    const { rows: incomeRows } = await controller.query(
      "SELECT id FROM public.tb_incomes WHERE description = $1",
      [description],
    );
    assert.equal(expenseRows.length, isExpense && firstIsConfirm ? 1 : 0);
    assert.equal(incomeRows.length, !isExpense && firstIsConfirm ? 1 : 0);
    assert.equal(
      expenseRows.length + incomeRows.length,
      firstIsConfirm ? 1 : 0,
    );

    if (firstIsConfirm) {
      assert.equal(firstResult.status, "CREATED");
      assert.equal(secondResult.status, "ALREADY_COMPLETED");
      const referenceId = isExpense
        ? firstResult.expense_id
        : firstResult.income_id;
      assert.ok(referenceId);
      assert.equal(proposalRow.status, "COMPLETED");
      assert.equal(proposalRow.expense_id, isExpense ? referenceId : null);
      assert.equal(proposalRow.income_id, isExpense ? null : referenceId);
      assert.equal(
        isExpense ? expenseRows[0]?.id : incomeRows[0]?.id,
        referenceId,
      );
    } else {
      assert.equal(firstResult.status, "REJECTED");
      assert.equal(secondResult.status, "REJECTED");
      assert.equal(proposalRow.status, "REJECTED");
      assert.equal(proposalRow.expense_id, null);
      assert.equal(proposalRow.income_id, null);
    }

    console.log(
      `PASS 2R2 ${movement.toLowerCase()} ${firstOperation.toLowerCase()}-wins: terminal state and movement invariants`,
    );
  } finally {
    await controller
      .query("SELECT pg_advisory_unlock($1)", [advisoryLockKey])
      .catch(() => {});
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

    await runProvisioningConcurrencyScenarios({ controller, postgres });
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
    for (let round = 1; round <= 1; round += 1) {
      await runConfirmRejectRound({
        controller,
        postgres,
        round,
        movement: "EXPENSE",
        firstOperation: "CONFIRM",
      });
      await runConfirmRejectRound({
        controller,
        postgres,
        round,
        movement: "EXPENSE",
        firstOperation: "REJECT",
      });
      await runConfirmRejectRound({
        controller,
        postgres,
        round,
        movement: "INCOME",
        firstOperation: "CONFIRM",
      });
      await runConfirmRejectRound({
        controller,
        postgres,
        round,
        movement: "INCOME",
        firstOperation: "REJECT",
      });
    }
    await dropPauseTrigger(controller);
    console.log("PASS 2L3 concurrency harness completed: 20 rounds");
    console.log(
      "PASS 2R2 concurrency harness completed: 4 confirm/reject races",
    );
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
