const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

// Uses only the disposable PostgreSQL instance owned by run-sql-tests.cjs.
module.exports = async function webPendingProposalConcurrency(postgres) {
  const clients = [0, 1, 2].map(() => postgres.getPgClient("housemate_test"));
  await Promise.all(clients.map((client) => client.connect()));
  const [first, second, observer] = clients;
  const householdId = randomUUID();
  const appUserId = randomUUID();
  const authUserId = randomUUID();
  const memberId = randomUUID();
  const expenseMacroId = randomUUID();
  const expenseCategoryId = randomUUID();
  const incomeMacroId = randomUUID();
  const incomeCategoryId = randomUUID();
  const suffix = randomUUID();
  const date = new Date().toISOString().slice(0, 10);
  let observerHoldsLock = false;
  let fixturesCommitted = false;

  async function authenticate(client) {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query(
      "SELECT set_config('request.jwt.claim.role','authenticated',true)",
    );
    await client.query(
      "SELECT set_config('request.jwt.claim.sub',$1,true)",
      [authUserId],
    );
  }

  function proposalPayload(operation, description) {
    const presented = operation === "CREATE_EXPENSE"
      ? {
          paidByMemberId: memberId,
          totalAmount: 42.25,
          expenseDate: date,
          description,
          categoryId: expenseCategoryId,
          receiptId: null,
          merchant: `0054 ${suffix}`,
          items: [],
          splits: [{ householdMemberId: memberId, percentage: 100 }],
        }
      : {
          memberId,
          amount: 42.25,
          incomeDate: date,
          description,
          categoryId: incomeCategoryId,
        };
    const persistence = operation === "CREATE_EXPENSE"
      ? {
          householdId,
          createdBy: memberId,
          paidByMemberId: memberId,
          categoryId: expenseCategoryId,
          receiptId: null,
          merchant: `0054 ${suffix}`,
          totalAmount: 42.25,
          expenseDate: date,
          description,
          source: "WEB",
          items: [],
          distributions: [{
            householdMemberId: memberId,
            amount: 42.25,
            percentage: 100,
          }],
        }
      : {
          householdId,
          createdBy: memberId,
          memberId,
          amount: 42.25,
          incomeDate: date,
          description,
          categoryId: incomeCategoryId,
        };
    return {
      actorMemberId: memberId,
      source: "WEB",
      [operation === "CREATE_EXPENSE" ? "expense" : "income"]: presented,
      _web_confirmation: { presented, persistence },
    };
  }

  async function insertProposal(operation, proposalId, description) {
    const payload = proposalPayload(operation, description);
    const result = await observer.query(
      `INSERT INTO public.tb_pending_proposals(
         id,household_id,conversation_key,actor_member_id,source,
         operation_type,payload,status,created_at,updated_at
       ) VALUES($1,$2,$3,$4,'WEB',$5,$6::jsonb,'AWAITING_CONFIRMATION',now(),now())
       RETURNING version::text AS version`,
      [
        proposalId,
        householdId,
        `web:${householdId}:${memberId}`,
        memberId,
        operation,
        JSON.stringify(payload),
      ],
    );
    return result.rows[0].version;
  }

  async function callConfirmation(client, operation, proposalId, expectedVersion) {
    const functionName = operation === "CREATE_EXPENSE"
      ? "fn_confirm_web_pending_expense"
      : "fn_confirm_web_pending_income";
    const result = await client.query(
      `SELECT public.${functionName}($1,$2,$3) AS result`,
      [proposalId, householdId, expectedVersion],
    );
    return result.rows[0].result;
  }

  async function callRejection(client, proposalId) {
    const result = await client.query(
      "SELECT public.fn_reject_web_pending_proposal($1,$2,'CREATE_EXPENSE') AS result",
      [proposalId, householdId],
    );
    return result.rows[0].result;
  }

  async function callCorrection(client, proposalId, expectedVersion, description) {
    const result = await client.query(
      `SELECT public.fn_update_web_pending_proposal(
        $1,$2,$3,'CREATE_EXPENSE',$4::bigint,$5::jsonb
      ) AS result`,
      [
        proposalId,
        householdId,
        `web:${householdId}:${memberId}`,
        expectedVersion,
        JSON.stringify(proposalPayload("CREATE_EXPENSE", description)),
      ],
    );
    return result.rows[0].result;
  }

  async function callCompensation(client, proposalId, createdAt, expectedVersion) {
    const result = await client.query(
      `SELECT public.fn_compensate_web_pending_proposal(
        $1,$2,$3,'CREATE_EXPENSE',$4::timestamptz,$5::bigint
      ) AS result`,
      [proposalId, householdId, `web:${householdId}:${memberId}`, createdAt, expectedVersion],
    );
    return result.rows[0].result;
  }

  async function waitForBlocker(pid, blockerPid, label) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const result = await observer.query(
        "SELECT pg_blocking_pids($1) AS blockers",
        [pid],
      );
      const blockers = result.rows[0].blockers.map(Number);
      if (blockers.includes(Number(blockerPid))) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for PostgreSQL lock boundary: ${label}`);
  }

  async function pid(client) {
    return Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  }

  async function count(table) {
    const result = await observer.query(
      `SELECT count(*)::int AS count FROM public.${table} WHERE household_id=$1`,
      [householdId],
    );
    return result.rows[0].count;
  }

  async function holdPauseLock() {
    await observer.query("SELECT pg_advisory_lock(2054,54)");
    observerHoldsLock = true;
  }

  async function releasePauseLock() {
    if (!observerHoldsLock) return;
    await observer.query("SELECT pg_advisory_unlock(2054,54)");
    observerHoldsLock = false;
  }

  try {
    await Promise.all(
      clients.map((client) => client.query("SET statement_timeout='12s'")),
    );
    await observer.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users(
        id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz
      );
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.role',true),'')
      $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      INSERT INTO auth.users(id,email,email_confirmed_at)
      VALUES('${authUserId}','${suffix}@example.test',clock_timestamp());
      INSERT INTO public.tb_households(id,name)
      VALUES('${householdId}','0054 concurrency ${suffix}');
      INSERT INTO public.tb_users(id,display_name,external_identifier,auth_user_id)
      VALUES('${appUserId}','0054 concurrency','0054-${suffix}','${authUserId}');
      INSERT INTO public.tb_household_members(
        id,household_id,user_id,display_name,role,status
      ) VALUES('${memberId}','${householdId}','${appUserId}',
        '0054 concurrency','OWNER','ACTIVE');
      INSERT INTO public.tb_categories(
        id,name,movement_type,level,parent_id,is_active
      ) VALUES
        ('${expenseMacroId}','0054 expense macro ${suffix}','EXPENSE','MACRO',NULL,true),
        ('${expenseCategoryId}','0054 expense micro ${suffix}','EXPENSE','MICRO','${expenseMacroId}',true),
        ('${incomeMacroId}','0054 income macro ${suffix}','INCOME','MACRO',NULL,true),
        ('${incomeCategoryId}','0054 income micro ${suffix}','INCOME','MICRO','${incomeMacroId}',true);
      CREATE OR REPLACE FUNCTION public.test_0054_pause_pending_operation()
      RETURNS trigger LANGUAGE plpgsql AS $housemate$
      BEGIN
        IF TG_TABLE_NAME='tb_expenses'
           AND current_setting('housemate.test_pause',true)='expense' THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(2054,54);
        ELSIF TG_TABLE_NAME='tb_incomes'
           AND current_setting('housemate.test_pause',true)='income' THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(2054,54);
        ELSIF TG_TABLE_NAME='tb_pending_proposals' THEN
          IF NEW.status='REJECTED'
             AND current_setting('housemate.test_pause',true)='reject' THEN
            PERFORM pg_catalog.pg_advisory_xact_lock(2054,54);
          ELSIF NEW.payload IS DISTINCT FROM OLD.payload
             AND current_setting('housemate.test_pause',true)='correction' THEN
            PERFORM pg_catalog.pg_advisory_xact_lock(2054,54);
          END IF;
        END IF;
        RETURN NEW;
      END;
      $housemate$;
      DROP TRIGGER IF EXISTS test_0054_pause_expense ON public.tb_expenses;
      CREATE TRIGGER test_0054_pause_expense BEFORE INSERT ON public.tb_expenses
        FOR EACH ROW EXECUTE FUNCTION public.test_0054_pause_pending_operation();
      DROP TRIGGER IF EXISTS test_0054_pause_income ON public.tb_incomes;
      CREATE TRIGGER test_0054_pause_income BEFORE INSERT ON public.tb_incomes
        FOR EACH ROW EXECUTE FUNCTION public.test_0054_pause_pending_operation();
      DROP TRIGGER IF EXISTS test_0054_pause_reject ON public.tb_pending_proposals;
      CREATE TRIGGER test_0054_pause_reject BEFORE UPDATE ON public.tb_pending_proposals
        FOR EACH ROW EXECUTE FUNCTION public.test_0054_pause_pending_operation();
    `);
    fixturesCommitted = true;

    const confirmConfirmId = randomUUID();
    const confirmConfirmVersion = await insertProposal(
      "CREATE_EXPENSE",
      confirmConfirmId,
      "0054 concurrent confirm-confirm",
    );
    const beforeConfirmConfirm = await count("tb_expenses");
    await holdPauseLock();
    await authenticate(first);
    await first.query("SELECT set_config('housemate.test_pause','expense',true)");
    const firstPid = await pid(first);
    const firstConfirm = callConfirmation(
      first,
      "CREATE_EXPENSE",
      confirmConfirmId,
      confirmConfirmVersion,
    );
    await waitForBlocker(firstPid, await pid(observer), "confirm-confirm first write");
    await authenticate(second);
    const secondPid = await pid(second);
    const secondConfirm = callConfirmation(
      second,
      "CREATE_EXPENSE",
      confirmConfirmId,
      confirmConfirmVersion,
    );
    await waitForBlocker(secondPid, firstPid, "confirm-confirm contender");
    await releasePauseLock();
    const firstOutcome = await firstConfirm;
    await first.query("COMMIT");
    const secondOutcome = await secondConfirm;
    await second.query("COMMIT");
    assert.equal(firstOutcome.status, "CREATED");
    assert.equal(secondOutcome.status, "ALREADY_COMPLETED");
    assert.equal(secondOutcome.expense_id, firstOutcome.expense_id);
    assert.equal((await count("tb_expenses")) - beforeConfirmConfirm, 1);
    console.log("PASS Web proposal concurrent confirmations create one Expense");

    const confirmRejectId = randomUUID();
    const confirmRejectVersion = await insertProposal(
      "CREATE_EXPENSE",
      confirmRejectId,
      "0054 concurrent confirm-reject",
    );
    const beforeConfirmReject = await count("tb_expenses");
    await holdPauseLock();
    await authenticate(first);
    await first.query("SELECT set_config('housemate.test_pause','expense',true)");
    const confirmPid = await pid(first);
    const confirmFirst = callConfirmation(
      first,
      "CREATE_EXPENSE",
      confirmRejectId,
      confirmRejectVersion,
    );
    await waitForBlocker(confirmPid, await pid(observer), "confirm-reject confirmation");
    await authenticate(second);
    const rejectPid = await pid(second);
    const rejectSecond = callRejection(second, confirmRejectId);
    await waitForBlocker(rejectPid, confirmPid, "confirm-reject rejection");
    await releasePauseLock();
    const confirmed = await confirmFirst;
    await first.query("COMMIT");
    const rejected = await rejectSecond;
    await second.query("COMMIT");
    assert.equal(confirmed.status, "CREATED");
    assert.equal(rejected.status, "ALREADY_COMPLETED");
    assert.equal(rejected.expense_id, confirmed.expense_id);
    assert.equal((await count("tb_expenses")) - beforeConfirmReject, 1);
    console.log("PASS Web proposal confirmation wins deterministic confirm/reject race");

    const correctionConfirmId = randomUUID();
    const correctionConfirmVersion = await insertProposal(
      "CREATE_EXPENSE",
      correctionConfirmId,
      "0055 correction-confirm race original",
    );
    const beforeCorrectionConfirm = await count("tb_expenses");
    await holdPauseLock();
    await authenticate(first);
    await first.query("SELECT set_config('housemate.test_pause','correction',true)");
    const correctionPid = await pid(first);
    const correctionFirst = callCorrection(
      first,
      correctionConfirmId,
      correctionConfirmVersion,
      "0055 correction-confirm race corrected",
    );
    await waitForBlocker(correctionPid, await pid(observer), "correction-confirm update");
    await authenticate(second);
    const confirmAfterCorrectionPid = await pid(second);
    const confirmAfterCorrection = callConfirmation(
      second,
      "CREATE_EXPENSE",
      correctionConfirmId,
      correctionConfirmVersion,
    );
    await waitForBlocker(
      confirmAfterCorrectionPid,
      correctionPid,
      "correction-confirm stale confirmation",
    );
    await releasePauseLock();
    await correctionFirst;
    await first.query("COMMIT");
    await assert.rejects(
      () => confirmAfterCorrection,
      (error) => error.code === "40001",
    );
    await second.query("ROLLBACK");
    const correctedProposal = await observer.query(
      `SELECT status,version::text AS version,payload -> 'expense' ->> 'description' AS description
         FROM public.tb_pending_proposals WHERE id=$1`,
      [correctionConfirmId],
    );
    assert.equal(correctedProposal.rows[0].status, "AWAITING_CONFIRMATION");
    assert.equal(correctedProposal.rows[0].version, "2");
    assert.equal(correctedProposal.rows[0].description, "0055 correction-confirm race corrected");
    assert.equal((await count("tb_expenses")) - beforeCorrectionConfirm, 0);
    await observer.query(
      "DELETE FROM public.tb_pending_proposals WHERE id=$1",
      [correctionConfirmId],
    );
    console.log("PASS Web correction fences a concurrent confirmation using the stale proposal version");

    const sameTokenId = randomUUID();
    const sameTokenVersion = await insertProposal(
      "CREATE_EXPENSE",
      sameTokenId,
      "0056 same-token correction race original",
    );
    await holdPauseLock();
    await authenticate(first);
    await first.query("SELECT set_config('housemate.test_pause','correction',true)");
    const firstCorrectionPid = await pid(first);
    const firstCorrection = callCorrection(
      first,
      sameTokenId,
      sameTokenVersion,
      "0056 correction winner",
    );
    await waitForBlocker(firstCorrectionPid, await pid(observer), "same-token first correction");
    await authenticate(second);
    const secondCorrectionPid = await pid(second);
    const secondCorrection = callCorrection(
      second,
      sameTokenId,
      sameTokenVersion,
      "0056 correction loser",
    );
    await waitForBlocker(secondCorrectionPid, firstCorrectionPid, "same-token correction contender");
    await releasePauseLock();
    const firstCorrectionResult = await firstCorrection;
    assert.equal(firstCorrectionResult.version, "2");
    await first.query("COMMIT");
    await assert.rejects(
      () => secondCorrection,
      (error) => error.code === "40001",
    );
    await second.query("ROLLBACK");
    const sameTokenRow = await observer.query(
      `SELECT version::text AS version,payload -> 'expense' ->> 'description' AS description
         FROM public.tb_pending_proposals WHERE id=$1`,
      [sameTokenId],
    );
    assert.equal(sameTokenRow.rows[0].version, "2");
    assert.equal(sameTokenRow.rows[0].description, "0056 correction winner");
    await observer.query("DELETE FROM public.tb_pending_proposals WHERE id=$1", [sameTokenId]);
    console.log("PASS concurrent corrections with one token allow exactly one winner");

    const correctionCompensationId = randomUUID();
    const correctionCompensationVersion = await insertProposal(
      "CREATE_EXPENSE",
      correctionCompensationId,
      "0056 correction-compensation race original",
    );
    const correctionCompensationCreation = await observer.query(
      "SELECT created_at::text AS created_at FROM public.tb_pending_proposals WHERE id=$1",
      [correctionCompensationId],
    );
    await holdPauseLock();
    await authenticate(first);
    await first.query("SELECT set_config('housemate.test_pause','correction',true)");
    const correctionForCompPid = await pid(first);
    const correctionForComp = callCorrection(
      first,
      correctionCompensationId,
      correctionCompensationVersion,
      "0056 correction wins compensation race",
    );
    await waitForBlocker(correctionForCompPid, await pid(observer), "correction-compensation update");
    await authenticate(second);
    const compensationPid = await pid(second);
    const compensationAfterCorrection = callCompensation(
      second,
      correctionCompensationId,
      correctionCompensationCreation.rows[0].created_at,
      correctionCompensationVersion,
    );
    await waitForBlocker(compensationPid, correctionForCompPid, "compensation waits for correction");
    await releasePauseLock();
    await correctionForComp;
    await first.query("COMMIT");
    assert.equal((await compensationAfterCorrection).status, "VERSION_CONFLICT");
    await second.query("COMMIT");
    const preservedAfterComp = await observer.query(
      "SELECT version::text AS version,status FROM public.tb_pending_proposals WHERE id=$1",
      [correctionCompensationId],
    );
    assert.equal(preservedAfterComp.rows[0].version, "2");
    assert.equal(preservedAfterComp.rows[0].status, "AWAITING_CONFIRMATION");
    await observer.query("DELETE FROM public.tb_pending_proposals WHERE id=$1", [correctionCompensationId]);
    console.log("PASS stale compensation cannot delete a proposal corrected concurrently");

    const confirmationCompensationId = randomUUID();
    const confirmationCompensationVersion = await insertProposal(
      "CREATE_EXPENSE",
      confirmationCompensationId,
      "0056 confirmation-compensation race",
    );
    const confirmationCreation = await observer.query(
      "SELECT created_at::text AS created_at FROM public.tb_pending_proposals WHERE id=$1",
      [confirmationCompensationId],
    );
    const beforeConfirmCompensation = await count("tb_expenses");
    await holdPauseLock();
    await authenticate(first);
    await first.query("SELECT set_config('housemate.test_pause','expense',true)");
    const confirmationForCompPid = await pid(first);
    const confirmationForComp = callConfirmation(
      first,
      "CREATE_EXPENSE",
      confirmationCompensationId,
      confirmationCompensationVersion,
    );
    await waitForBlocker(confirmationForCompPid, await pid(observer), "confirmation-compensation financial write");
    await authenticate(second);
    const compensationAfterConfirmationPid = await pid(second);
    const compensationAfterConfirmation = callCompensation(
      second,
      confirmationCompensationId,
      confirmationCreation.rows[0].created_at,
      confirmationCompensationVersion,
    );
    await waitForBlocker(compensationAfterConfirmationPid, confirmationForCompPid, "compensation waits for confirmation");
    await releasePauseLock();
    assert.equal((await confirmationForComp).status, "CREATED");
    await first.query("COMMIT");
    assert.equal((await compensationAfterConfirmation).status, "VERSION_CONFLICT");
    await second.query("COMMIT");
    const preservedAfterConfirmation = await observer.query(
      "SELECT version::text AS version,status FROM public.tb_pending_proposals WHERE id=$1",
      [confirmationCompensationId],
    );
    assert.equal(preservedAfterConfirmation.rows[0].version, "2");
    assert.equal(preservedAfterConfirmation.rows[0].status, "COMPLETED");
    assert.equal((await count("tb_expenses")) - beforeConfirmCompensation, 1);
    console.log("PASS compensation cannot remove a proposal completed concurrently");

    const rejectConfirmId = randomUUID();
    const rejectConfirmVersion = await insertProposal(
      "CREATE_EXPENSE",
      rejectConfirmId,
      "0054 concurrent reject-confirm",
    );
    const beforeRejectConfirm = await count("tb_expenses");
    await holdPauseLock();
    await authenticate(first);
    await first.query("SELECT set_config('housemate.test_pause','reject',true)");
    const rejectFirstPid = await pid(first);
    const rejectFirst = callRejection(first, rejectConfirmId);
    await waitForBlocker(rejectFirstPid, await pid(observer), "reject-confirm rejection");
    await authenticate(second);
    const confirmSecondPid = await pid(second);
    const confirmSecond = callConfirmation(
      second,
      "CREATE_EXPENSE",
      rejectConfirmId,
      rejectConfirmVersion,
    );
    await waitForBlocker(confirmSecondPid, rejectFirstPid, "reject-confirm confirmation");
    await releasePauseLock();
    const rejectedFirstResult = await rejectFirst;
    await first.query("COMMIT");
    const confirmedSecondResult = await confirmSecond;
    await second.query("COMMIT");
    assert.equal(rejectedFirstResult.status, "REJECTED");
    assert.equal(confirmedSecondResult.status, "REJECTED");
    assert.equal((await count("tb_expenses")) - beforeRejectConfirm, 0);
    console.log("PASS Web proposal rejection wins deterministic confirm/reject race");

    const lostResponseId = randomUUID();
    const lostResponseVersion = await insertProposal(
      "CREATE_INCOME",
      lostResponseId,
      "0054 replay after discarded response",
    );
    const beforeIncome = await count("tb_incomes");
    await authenticate(first);
    const discardedResponse = await callConfirmation(
      first,
      "CREATE_INCOME",
      lostResponseId,
      lostResponseVersion,
    );
    await first.query("COMMIT");
    // Deliberately do not use the first response, modeling a lost client reply.
    void discardedResponse;
    await authenticate(second);
    const replay = await callConfirmation(
      second,
      "CREATE_INCOME",
      lostResponseId,
      lostResponseVersion,
    );
    await second.query("COMMIT");
    assert.equal(replay.status, "ALREADY_COMPLETED");
    assert.equal((await count("tb_incomes")) - beforeIncome, 1);
    console.log("PASS Web Income confirmation replay is idempotent after discarded response");
  } finally {
    await releasePauseLock().catch(() => {});
    await Promise.allSettled(clients.map((client) => client.query("ROLLBACK")));
    if (fixturesCommitted) {
      await observer.query(`
        DROP TRIGGER IF EXISTS test_0054_pause_expense ON public.tb_expenses;
        DROP TRIGGER IF EXISTS test_0054_pause_income ON public.tb_incomes;
        DROP TRIGGER IF EXISTS test_0054_pause_reject ON public.tb_pending_proposals;
        DROP FUNCTION IF EXISTS public.test_0054_pause_pending_operation();
      `);
      // Remove proposals first because their optional financial reference is
      // RESTRICT. Parent Expense deletion then cascades both child collections
      // together; do not temporarily leave an Expense with an incomplete split.
      await observer.query("DELETE FROM public.tb_pending_proposals WHERE household_id=$1", [householdId]);
      await observer.query("DELETE FROM public.tb_expenses WHERE household_id=$1", [householdId]);
      await observer.query("DELETE FROM public.tb_incomes WHERE household_id=$1", [householdId]);
      await observer.query("DELETE FROM public.tb_categories WHERE id=ANY($1::uuid[])", [[expenseCategoryId, incomeCategoryId]]);
      await observer.query("DELETE FROM public.tb_categories WHERE id=ANY($1::uuid[])", [[expenseMacroId, incomeMacroId]]);
      await observer.query("DELETE FROM public.tb_household_members WHERE household_id=$1", [householdId]);
      await observer.query("DELETE FROM public.tb_users WHERE id=$1", [appUserId]);
      await observer.query("DELETE FROM auth.users WHERE id=$1", [authUserId]);
      await observer.query("DELETE FROM public.tb_households WHERE id=$1", [householdId]);
    }
    await Promise.allSettled(clients.map((client) => client.end()));
  }
};
