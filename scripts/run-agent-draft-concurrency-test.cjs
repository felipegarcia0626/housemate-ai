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
const advisoryLockKey = 2718281831;
const triggerName = "housemate_2r4_pause_terminal_update";
const triggerFunction = "housemate_2r4_pause_terminal_update";

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

function draftIdFor(scenario) {
  return `70000000-0000-4000-8000-${String(scenario).padStart(12, "0")}`;
}

function proposalIdFor(scenario) {
  return `71000000-0000-4000-8000-${String(scenario).padStart(12, "0")}`;
}

function conversationKeyFor(scenario) {
  return `2r4-${scenario}`;
}

async function insertDraft(
  client,
  {
    id,
    conversationKey,
    operationType = "CREATE_EXPENSE",
    status = "AWAITING_DETAILS",
    updatedAt = "2000-01-01 00:00:00+00",
    marker = "v1",
  },
) {
  const payload = {
    amount: "100",
    date: "2026-09-01",
    merchant: `2R4 ${marker}`,
    description: `2R4 ${marker}`,
    version: marker,
  };
  await client.query(
    `INSERT INTO public.tb_agent_category_drafts (
       id, household_id, actor_member_id, conversation_key, source,
       operation_type, payload, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'WEB', $5, $6::jsonb, $7, $8, $8)`,
    [
      id,
      householdId,
      memberId,
      conversationKey,
      operationType,
      JSON.stringify(payload),
      status,
      updatedAt,
    ],
  );
  return {
    id,
    householdId,
    actorMemberId: memberId,
    conversationKey,
    source: "WEB",
    updatedAt,
  };
}

async function insertProposal(
  client,
  {
    id,
    conversationKey,
    operationType,
    draftId,
    updatedAt = "2000-01-01 00:00:00+00",
  },
) {
  await client.query(
    `INSERT INTO public.tb_pending_proposals (
       id, household_id, conversation_key, operation_type, payload,
       status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, 'AWAITING_CONFIRMATION', $6, $6)`,
    [
      id,
      householdId,
      conversationKey,
      operationType,
      JSON.stringify({
        actorMemberId: memberId,
        source: "WEB",
        draftId,
      }),
      updatedAt,
    ],
  );
}

async function readDraft(client, id) {
  const { rows } = await client.query(
    `SELECT id, household_id, actor_member_id, conversation_key, source,
            operation_type, status, payload, updated_at
       FROM public.tb_agent_category_drafts
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function updateDraft(client, id, marker) {
  const { rows } = await client.query(
    `UPDATE public.tb_agent_category_drafts
        SET payload = jsonb_build_object('version', $2::text, 'marker', $2::text)
      WHERE id = $1
      RETURNING id, updated_at, payload`,
    [id, marker],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

async function casDelete(client, draft, expectedUpdatedAt, context = {}) {
  const actorMemberId =
    context.actorMemberId ?? draft.actor_member_id ?? draft.actorMemberId;
  const conversationKey =
    context.conversationKey ?? draft.conversation_key ?? draft.conversationKey;
  const source = context.source ?? draft.source;
  const { rows } = await client.query(
    `DELETE FROM public.tb_agent_category_drafts
      WHERE id = $1
        AND household_id = $2
        AND actor_member_id = $3
        AND conversation_key = $4
        AND source = $5::public.expense_source
        AND updated_at = $6
      RETURNING id`,
    [
      draft.id,
      draft.household_id ?? draft.householdId,
      actorMemberId,
      conversationKey,
      source,
      expectedUpdatedAt,
    ],
  );
  if (rows.length > 0) return "DELETED";

  const { rows: currentRows } = await client.query(
    `SELECT id
       FROM public.tb_agent_category_drafts
      WHERE id = $1
        AND household_id = $2
        AND actor_member_id = $3
        AND conversation_key = $4
        AND source = $5::public.expense_source`,
    [
      draft.id,
      draft.household_id ?? draft.householdId,
      actorMemberId,
      conversationKey,
      source,
    ],
  );
  return currentRows.length > 0 ? "VERSION_CONFLICT" : "NOT_FOUND";
}

async function assertDraftVersion(client, id, marker) {
  const draft = await readDraft(client, id);
  assert.ok(draft);
  assert.equal(draft.payload.version, marker);
  assert.equal(draft.household_id, householdId);
  assert.equal(draft.actor_member_id, memberId);
  assert.equal(draft.source, "WEB");
  return draft;
}

async function runStaleCleanupVsUpdate(controller, postgres) {
  const draft = await insertDraft(controller, {
    id: draftIdFor(1),
    conversationKey: conversationKeyFor("stale-cleanup"),
  });
  const c1 = await connectClient(postgres);
  const c2 = await connectClient(postgres);
  try {
    await c1.query("BEGIN");
    const v1 = await readDraft(c1, draft.id);
    await c2.query("BEGIN");
    await updateDraft(c2, draft.id, "v2");
    await c2.query("COMMIT");
    const result = await casDelete(c1, v1, v1.updated_at);
    await c1.query("COMMIT");
    assert.equal(result, "VERSION_CONFLICT");
    await assertDraftVersion(controller, draft.id, "v2");
    console.log(
      "PASS 2R.4 A stale cleanup cannot delete a concurrent draft update",
    );
  } finally {
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    await c1.end();
    await c2.end();
  }
}

async function runCurrentDelete(controller, postgres) {
  const draft = await insertDraft(controller, {
    id: draftIdFor(2),
    conversationKey: conversationKeyFor("current-delete"),
  });
  const c1 = await connectClient(postgres);
  try {
    await c1.query("BEGIN");
    const current = await readDraft(c1, draft.id);
    const result = await casDelete(c1, current, current.updated_at);
    await c1.query("COMMIT");
    assert.equal(result, "DELETED");
    const { rows } = await controller.query(
      "SELECT id FROM public.tb_agent_category_drafts WHERE id = $1",
      [draft.id],
    );
    assert.equal(rows.length, 0);
    console.log(
      "PASS 2R.4 B current-version cleanup deletes exactly one draft",
    );
  } finally {
    await c1.query("ROLLBACK").catch(() => {});
    await c1.end();
  }
}

async function runTerminalCleanupVsUpdate(controller, postgres) {
  const draft = await insertDraft(controller, {
    id: draftIdFor(3),
    conversationKey: conversationKeyFor("terminal-cleanup"),
  });
  const proposalId = proposalIdFor(3);
  await insertProposal(controller, {
    id: proposalId,
    conversationKey: draft.conversationKey,
    operationType: "CREATE_EXPENSE",
    draftId: draft.id,
  });
  const c1 = await connectClient(postgres);
  const c2 = await connectClient(postgres);
  try {
    await c1.query("BEGIN");
    const v1 = await readDraft(c1, draft.id);
    await c2.query("BEGIN");
    await updateDraft(c2, draft.id, "v2");
    await c2.query("COMMIT");
    await c1.query(
      `UPDATE public.tb_pending_proposals
          SET status = 'REJECTED', resolved_at = now()
        WHERE id = $1
          AND household_id = $2
          AND conversation_key = $3
          AND status = 'AWAITING_CONFIRMATION'`,
      [proposalId, householdId, draft.conversationKey],
    );
    const result = await casDelete(c1, v1, v1.updated_at);
    await c1.query("COMMIT");
    assert.equal(result, "VERSION_CONFLICT");
    const { rows: proposalRows } = await controller.query(
      "SELECT status, payload->>'draftId' AS draft_id FROM public.tb_pending_proposals WHERE id = $1",
      [proposalId],
    );
    assert.equal(proposalRows[0].status, "REJECTED");
    assert.equal(proposalRows[0].draft_id, draft.id);
    await assertDraftVersion(controller, draft.id, "v2");
    console.log(
      "PASS 2R.4 C terminal proposal cleanup preserves a concurrent draft update",
    );
  } finally {
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    await c1.end();
    await c2.end();
  }
}

async function runConfirmExpenseVsUpdate(controller, postgres) {
  const draft = await insertDraft(controller, {
    id: draftIdFor(4),
    conversationKey: conversationKeyFor("confirm-expense"),
  });
  const proposalId = proposalIdFor(4);
  await insertProposal(controller, {
    id: proposalId,
    conversationKey: draft.conversationKey,
    operationType: "CREATE_EXPENSE",
    draftId: draft.id,
  });
  const c1 = await connectClient(postgres);
  const c2 = await connectClient(postgres);
  let confirmation;
  try {
    await controller.query("SELECT pg_advisory_lock($1)", [advisoryLockKey]);
    await c1.query("BEGIN");
    const v1 = await readDraft(c1, draft.id);
    confirmation = c1.query(
      `SELECT public.fn_confirm_pending_expense_consistent(
         $1, $2, $3, $4, 'WEB'::public.expense_source, $5,
         $4, $4, $6, NULL, $7, 100.00, '2026-09-01', $8,
         'WEB'::public.expense_source,
         $9::jsonb, $10::jsonb
       ) AS result`,
      [
        proposalId,
        householdId,
        draft.conversationKey,
        memberId,
        "2000-01-01 00:00:00+00",
        expenseCategoryId,
        "2R4 expense merchant",
        "2R4 expense description",
        JSON.stringify([{ name: "2R4 item", totalAmount: 100 }]),
        JSON.stringify([
          { householdMemberId: memberId, amount: 100, percentage: 100 },
        ]),
      ],
    );
    await waitForAdvisoryWait(controller, c1.processID);
    await c2.query("BEGIN");
    await updateDraft(c2, draft.id, "v2");
    await c2.query("COMMIT");
    await controller.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);
    const result = (await confirmation).rows[0].result;
    await c1.query("COMMIT");
    assert.equal(result.status, "CREATED");
    assert.ok(result.expense_id);
    const { rows: proposals } = await controller.query(
      "SELECT status, expense_id, income_id, resolved_at FROM public.tb_pending_proposals WHERE id = $1",
      [proposalId],
    );
    assert.equal(proposals[0].status, "COMPLETED");
    assert.equal(proposals[0].expense_id, result.expense_id);
    assert.equal(proposals[0].income_id, null);
    assert.ok(proposals[0].resolved_at);
    const { rows: expenses } = await controller.query(
      "SELECT id FROM public.tb_expenses WHERE merchant = $1",
      ["2R4 expense merchant"],
    );
    assert.equal(expenses.length, 1);
    assert.equal(expenses[0].id, result.expense_id);
    const staleResult = await casDelete(c1, v1, v1.updated_at);
    assert.equal(staleResult, "VERSION_CONFLICT");
    await assertDraftVersion(controller, draft.id, "v2");
    console.log(
      "PASS 2R.4 D confirm Expense plus concurrent update writes once and preserves V2",
    );
  } finally {
    await controller
      .query("SELECT pg_advisory_unlock($1)", [advisoryLockKey])
      .catch(() => {});
    await Promise.allSettled([confirmation]);
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    await c1.end();
    await c2.end();
  }
}

async function runRejectIncomeVsUpdate(controller, postgres) {
  const draft = await insertDraft(controller, {
    id: draftIdFor(5),
    conversationKey: conversationKeyFor("reject-income"),
    operationType: "CREATE_INCOME",
  });
  const proposalId = proposalIdFor(5);
  await insertProposal(controller, {
    id: proposalId,
    conversationKey: draft.conversationKey,
    operationType: "CREATE_INCOME",
    draftId: draft.id,
  });
  const c1 = await connectClient(postgres);
  const c2 = await connectClient(postgres);
  let rejection;
  try {
    await controller.query("SELECT pg_advisory_lock($1)", [advisoryLockKey]);
    await c1.query("BEGIN");
    const v1 = await readDraft(c1, draft.id);
    rejection = c1.query(
      `SELECT public.fn_reject_pending_proposal(
         $1, $2, $3, $4, 'WEB'::public.expense_source,
         'CREATE_INCOME'::public.pending_operation_type
       ) AS result`,
      [proposalId, householdId, draft.conversationKey, memberId],
    );
    await waitForAdvisoryWait(controller, c1.processID);
    await c2.query("BEGIN");
    await updateDraft(c2, draft.id, "v2");
    await c2.query("COMMIT");
    await controller.query("SELECT pg_advisory_unlock($1)", [advisoryLockKey]);
    const result = (await rejection).rows[0].result;
    await c1.query("COMMIT");
    assert.equal(result.status, "REJECTED");
    const { rows: proposals } = await controller.query(
      "SELECT status, expense_id, income_id, resolved_at FROM public.tb_pending_proposals WHERE id = $1",
      [proposalId],
    );
    assert.equal(proposals[0].status, "REJECTED");
    assert.equal(proposals[0].expense_id, null);
    assert.equal(proposals[0].income_id, null);
    assert.ok(proposals[0].resolved_at);
    const { rows: incomes } = await controller.query(
      "SELECT id FROM public.tb_incomes WHERE description = $1",
      ["2R4 reject income"],
    );
    assert.equal(incomes.length, 0);
    const staleResult = await casDelete(c1, v1, v1.updated_at);
    assert.equal(staleResult, "VERSION_CONFLICT");
    await assertDraftVersion(controller, draft.id, "v2");
    console.log(
      "PASS 2R.4 E reject Income plus concurrent update writes no movement and preserves V2",
    );
  } finally {
    await controller
      .query("SELECT pg_advisory_unlock($1)", [advisoryLockKey])
      .catch(() => {});
    await Promise.allSettled([rejection]);
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    await c1.end();
    await c2.end();
  }
}

async function runExpirationVsUpdate(controller, postgres) {
  const draft = await insertDraft(controller, {
    id: draftIdFor(6),
    conversationKey: conversationKeyFor("expiration"),
    updatedAt: "2000-01-01 00:00:00+00",
  });
  const c1 = await connectClient(postgres);
  const c2 = await connectClient(postgres);
  try {
    await c1.query("BEGIN");
    const expiredV1 = await readDraft(c1, draft.id);
    assert.ok(Date.now() - Date.parse(expiredV1.updated_at) > 30 * 60 * 1000);
    await c2.query("BEGIN");
    await updateDraft(c2, draft.id, "v2");
    await c2.query("COMMIT");
    const result = await casDelete(c1, expiredV1, expiredV1.updated_at);
    await c1.query("COMMIT");
    assert.equal(result, "VERSION_CONFLICT");
    await assertDraftVersion(controller, draft.id, "v2");
    console.log(
      "PASS 2R.4 F expiration cleanup cannot remove a concurrent draft update",
    );
  } finally {
    await c1.query("ROLLBACK").catch(() => {});
    await c2.query("ROLLBACK").catch(() => {});
    await c1.end();
    await c2.end();
  }
}

async function runContextIsolation(controller, postgres) {
  const draft = await insertDraft(controller, {
    id: draftIdFor(7),
    conversationKey: conversationKeyFor("isolation"),
  });
  const c1 = await connectClient(postgres);
  try {
    const current = await readDraft(c1, draft.id);
    const result = await casDelete(c1, current, current.updated_at, {
      actorMemberId: "00000000-0000-4000-8000-000000000022",
    });
    assert.equal(result, "NOT_FOUND");
    await assertDraftVersion(controller, draft.id, "v1");
    console.log(
      "PASS 2R.4 G cleanup with the wrong actor context is NOT_FOUND",
    );
  } finally {
    await c1.end();
  }
}

async function main() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const databaseDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "housemate-ai-sql-agent-draft-"),
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

    await runStaleCleanupVsUpdate(controller, postgres);
    await runCurrentDelete(controller, postgres);
    await runTerminalCleanupVsUpdate(controller, postgres);
    await createPauseTrigger(controller);
    try {
      await runConfirmExpenseVsUpdate(controller, postgres);
      await runRejectIncomeVsUpdate(controller, postgres);
    } finally {
      await dropPauseTrigger(controller);
    }
    await runExpirationVsUpdate(controller, postgres);
    await runContextIsolation(controller, postgres);
    console.log(
      "PASS 2R.4 AgentDraft PostgreSQL multi-session concurrency harness completed",
    );
  } finally {
    if (controller) await controller.end().catch(() => {});
    await postgres.stop().catch(() => {});
    await removeDatabaseDirectory(databaseDir);
  }
}

main().catch((error) => {
  console.error(`FAIL 2R.4 AgentDraft concurrency harness: ${error.message}`);
  process.exit(1);
});
