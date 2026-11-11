const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

// Only called with the runner's disposable PostgreSQL instance. Never a URL.
module.exports = async function eventRecovery(postgres) {
  const clients = [0, 1, 2].map(() => postgres.getPgClient("housemate_test"));
  await Promise.all(clients.map((client) => client.connect()));
  const [first, second, inspect] = clients;
  const uid = (n) => `46000000-0046-4000-8000-${String(n).padStart(12, "0")}`;
  const household = uid(99);
  const sender = (n) => `199900046${String(n).padStart(2, "0")}`;
  const digest = "a".repeat(64);
  const result = async (client, sql, args = []) =>
    (await client.query(sql, args)).rows[0].result;
  const claim = (client, n, event, token) =>
    result(
      client,
      "SELECT public.fn_claim_whatsapp_event($1,$2,'123456',$3,$4) AS result",
      [event, sender(n), digest, token],
    );
  const begin = (client, event, token, epoch = 1) =>
    result(
      client,
      "SELECT public.fn_begin_whatsapp_event($1,$2,$3) AS result",
      [event, token, epoch],
    );
  async function receipt(event) {
    return result(
      inspect,
      "SELECT to_jsonb(r) AS result FROM public.tb_whatsapp_event_receipts r WHERE external_event_id=$1",
      [event],
    );
  }
  async function state(n, event) {
    const output = { receipt: await receipt(event) };
    for (const [key, table, filter] of [
      ["proposals", "tb_pending_proposals", "actor_member_id"],
      ["drafts", "tb_agent_category_drafts", "actor_member_id"],
      ["incomes", "tb_incomes", "created_by"],
      ["expenses", "tb_expenses", "created_by"],
      ["distributions", "tb_expense_distributions", "household_member_id"],
    ])
      output[key] = (
        await inspect.query(
          `SELECT to_jsonb(t) AS row FROM public.${table} t WHERE ${filter}=$1 ORDER BY id`,
          [uid(n)],
        )
      ).rows.map(({ row }) => row);
    return output;
  }
  async function prepare(n, kind) {
    const event = `recovery-financial-${n}-${randomUUID()}`,
      token = randomUUID();
    const admission = await claim(first, n, event, token);
    assert.equal(admission.status, "CLAIMED");
    assert.equal((await begin(first, event, token)).status, "STARTED");
    await first.query(
      "SELECT public.fn_transition_whatsapp_household_context($1,'123456',$2,$3,'SET_SELECTION',$4,$1)",
      [uid(n), admission.leaseId, admission.contextEpoch, household],
    );
    await first.query("SELECT public.fn_bind_whatsapp_event_context($1,$2,1)", [
      event,
      token,
    ]);
    const proposal = await result(
      first,
      "SELECT to_jsonb(public.fn_create_whatsapp_proposal_event($1,$2,1,$3,$4,$5,$6)) AS result",
      [
        event,
        token,
        randomUUID(),
        `whatsapp:123456:${sender(n)}`,
        kind,
        JSON.stringify({ actorMemberId: uid(n), source: "WHATSAPP" }),
      ],
    );
    return { event, token, proposal, n, kind, admission };
  }
  function confirm(client, p) {
    const args = [
      p.event,
      p.token,
      p.proposal.id,
      `whatsapp:123456:${sender(p.n)}`,
      p.proposal.updated_at,
      uid(p.n),
    ];
    return p.kind === "CREATE_INCOME"
      ? result(
          client,
          "SELECT public.fn_confirm_whatsapp_income_event($1,$2,1,$3,$4,$5,$6,9,current_date,'Recovery fixture',NULL) AS result",
          args,
        )
      : result(
          client,
          "SELECT public.fn_confirm_whatsapp_expense_event($1,$2,1,$3,$4,$5,$6,NULL,NULL,NULL,9,current_date,NULL,'[]',jsonb_build_array(jsonb_build_object('householdMemberId',$6::uuid,'amount',9,'percentage',100))) AS result",
          args,
        );
  }
  async function waiting(client) {
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    return async () => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        if (
          (
            await inspect.query(
              "SELECT cardinality(pg_blocking_pids($1))>0 AS waiting",
              [pid],
            )
          ).rows[0].waiting
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Expected actual receipt lock wait");
    };
  }
  async function waitForBlocker(blockedPid, blockerPid) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const blocked = await inspect.query(
        "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS waiting",
        [blockedPid, blockerPid],
      );
      if (blocked.rows[0].waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Claim did not reach the deterministic lease-trigger barrier");
  }
  try {
    await inspect.query(
      "INSERT INTO public.tb_households(id,name) VALUES($1,'Receipt races')",
      [household],
    );
    // 0051 revokes this direct privilege from the current service_role. Keep a
    // narrowly scoped test-only role to model a legacy instance that still had
    // the pre-cut ledger INSERT grant during the 0046 race.
    await inspect.query("CREATE ROLE whatsapp_legacy_runtime NOLOGIN");
    await inspect.query("GRANT USAGE ON SCHEMA public TO whatsapp_legacy_runtime");
    await inspect.query(
      "GRANT INSERT ON public.tb_processed_whatsapp_events TO whatsapp_legacy_runtime",
    );
    for (let n = 1; n <= 16; n++) {
      await inspect.query(
        "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'receipt-race@example.test',now())",
        [uid(n)],
      );
      await inspect.query(
        "INSERT INTO public.tb_users(id,auth_user_id,display_name,external_identifier) VALUES($1,$1,'Receipt race',$2)",
        [uid(n), `supabase:${uid(n)}`],
      );
      await inspect.query(
        "INSERT INTO public.tb_household_members(id,user_id,household_id,display_name,role,status) VALUES($1,$1,$2,'Receipt race',$3,'ACTIVE')",
        [uid(n), household, n === 1 ? "OWNER" : "MEMBER"],
      );
      if (n <= 12)
        await inspect.query(
          "INSERT INTO public.tb_whatsapp_links(id,user_id,sender,status,authorization_version,verified_at) VALUES($1,$2,$3,'ACTIVE',1,now())",
          [uid(100 + n), uid(n), sender(n)],
        );
    }
    await Promise.all(
      clients.map((c) => c.query("SET statement_timeout='10s'")),
    );
    await first.query("SET ROLE service_role");
    await second.query("SET ROLE service_role");
    const waitSecond = await waiting(second);
    const waitFirst = await waiting(first);
    // Claim commits before the loser can inspect it. Only one receives CLAIMED.
    const e = "recovery-concurrent",
      t = randomUUID();
    await first.query("BEGIN");
    assert.equal((await claim(first, 1, e, t)).status, "CLAIMED");
    const other = claim(second, 1, e, randomUUID());
    await waitSecond();
    await first.query("COMMIT");
    assert.equal((await other).status, "BUSY");
    const starts = await Promise.all([begin(first, e, t), begin(second, e, t)]);
    assert.deepEqual(starts.map((x) => x.status).sort(), [
      "ALREADY_STARTED",
      "STARTED",
    ]);
    await inspect.query(
      "UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=clock_timestamp()-interval '1 second' WHERE external_event_id=$1",
      [e],
    );
    assert.equal((await claim(second, 1, e, t)).status, "UNCERTAIN");
    const closed = await receipt(e);
    await assert.rejects(
      begin(first, e, t),
      (err) =>
        err.code === "40001" &&
        err.message === "WhatsApp event is no longer current",
    );
    assert.deepEqual(await receipt(e), closed);
    console.log(
      "PASS receipt concurrent claim/begin grants once; abandoned RUNNING stays UNCERTAIN",
    );

    // Reproduce a legacy ledger INSERT after fn_claim's historical check but
    // before its own INSERT. An AFTER trigger is the synchronization barrier:
    // the new claim has already updated the lease row when it blocks, while the
    // legacy session can insert without taking the WhatsApp advisory gate.
    const raceUser = uid(17);
    const raceLink = uid(117);
    const raceSender = sender(17);
    const raceEvent = `recovery-legacy-claim-race-${randomUUID()}`;
    const raceToken = randomUUID();
    let legacyTransactionOpen = false;
    let racingClaim;
    try {
      await inspect.query(
        "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())",
        [raceUser, `claim-race-${randomUUID()}@example.test`],
      );
      await inspect.query(
        "INSERT INTO public.tb_users(id,auth_user_id,display_name,external_identifier) VALUES($1,$1,'Claim race fixture',$2)",
        [raceUser, `supabase:${raceUser}`],
      );
      await inspect.query(
        "INSERT INTO public.tb_whatsapp_links(id,user_id,sender,status,authorization_version,verified_at) VALUES($1,$2,$3,'ACTIVE',1,now())",
        [raceLink, raceUser, raceSender],
      );
      await inspect.query(`
        CREATE TABLE public.test_whatsapp_claim_lease_capture (
          user_id uuid NOT NULL,
          lease_id uuid NOT NULL,
          lease_epoch bigint NOT NULL
        );
        CREATE FUNCTION public.test_pause_whatsapp_claim_after_lease()
        RETURNS trigger LANGUAGE plpgsql AS $capture$
        BEGIN
          IF NEW.user_id = '${raceUser}'::uuid
             AND NEW.authorization_sender = '${raceSender}'
             AND NEW.processing_lease_id IS NOT NULL
             AND NEW.processing_lease_id IS DISTINCT FROM OLD.processing_lease_id THEN
            INSERT INTO public.test_whatsapp_claim_lease_capture(user_id,lease_id,lease_epoch)
            VALUES(NEW.user_id,NEW.processing_lease_id,NEW.processing_epoch);
            PERFORM pg_catalog.pg_advisory_xact_lock(21104,46046);
          END IF;
          RETURN NEW;
        END
        $capture$;
        CREATE TRIGGER test_pause_whatsapp_claim_after_lease
        AFTER UPDATE OF processing_lease_id ON public.tb_whatsapp_user_contexts
        FOR EACH ROW EXECUTE FUNCTION public.test_pause_whatsapp_claim_after_lease();
      `);

      await second.query("BEGIN");
      legacyTransactionOpen = true;
      await second.query("SELECT pg_catalog.pg_advisory_xact_lock(21104,46046)");
      const [blockedPid, blockerPid] = await Promise.all([
        first.query("SELECT pg_backend_pid() AS pid"),
        second.query("SELECT pg_backend_pid() AS pid"),
      ]).then((results) => results.map((result) => result.rows[0].pid));
      racingClaim = claim(first, 17, raceEvent, raceToken);
      await waitForBlocker(blockedPid, blockerPid);
      // Model the old grant in an isolated role; 0051 correctly revokes it
      // from the current service_role.
      await second.query("SET LOCAL ROLE whatsapp_legacy_runtime");
      await second.query(
        "INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES($1)",
        [raceEvent],
      );
      await second.query("COMMIT");
      legacyTransactionOpen = false;

      const historical = await racingClaim;
      assert.equal(historical.status, "HISTORICAL");
      const captured = await inspect.query(
        "SELECT user_id,lease_id,lease_epoch FROM public.test_whatsapp_claim_lease_capture",
      );
      assert.equal(captured.rowCount, 1);
      const oldFence = captured.rows[0];
      const contextAfterHistorical = await inspect.query(
        "SELECT processing_lease_id,processing_epoch,processing_expires_at FROM public.tb_whatsapp_user_contexts WHERE user_id=$1",
        [raceUser],
      );
      assert.equal(contextAfterHistorical.rowCount, 1);
      assert.equal(contextAfterHistorical.rows[0].processing_lease_id, null);
      assert.equal(contextAfterHistorical.rows[0].processing_expires_at, null);
      const receiptCount = await inspect.query(
        "SELECT count(*)::int AS n FROM public.tb_whatsapp_event_receipts WHERE external_event_id=$1",
        [raceEvent],
      );
      assert.equal(receiptCount.rows[0].n, 0);

      await inspect.query(
        "DROP TRIGGER test_pause_whatsapp_claim_after_lease ON public.tb_whatsapp_user_contexts; DROP FUNCTION public.test_pause_whatsapp_claim_after_lease(); DROP TABLE public.test_whatsapp_claim_lease_capture",
      );
      const nextLeaseId = randomUUID();
      const nextAdmission = await result(
        first,
        "SELECT public.fn_admit_whatsapp_sender($1,$2) AS result",
        [raceSender, nextLeaseId],
      );
      assert.equal(nextAdmission.status, "ADMITTED");
      assert.ok(nextAdmission.epoch > Number(oldFence.lease_epoch));
      const contextBeforeStaleRelease = await inspect.query(
        "SELECT processing_lease_id,processing_epoch,processing_expires_at FROM public.tb_whatsapp_user_contexts WHERE user_id=$1",
        [raceUser],
      );
      assert.equal(
        await result(
          first,
          "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3) AS result",
          [raceUser, oldFence.lease_id, oldFence.lease_epoch],
        ),
        false,
      );
      assert.equal(
        await result(
          first,
          "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3) AS result",
          [raceUser, oldFence.lease_id, nextAdmission.epoch],
        ),
        false,
      );
      assert.equal(
        await result(
          first,
          "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3) AS result",
          [raceUser, nextLeaseId, oldFence.lease_epoch],
        ),
        false,
      );
      assert.deepEqual(
        await inspect.query(
          "SELECT processing_lease_id,processing_epoch,processing_expires_at FROM public.tb_whatsapp_user_contexts WHERE user_id=$1",
          [raceUser],
        ).then((response) => response.rows),
        contextBeforeStaleRelease.rows,
      );
      assert.equal(
        await result(
          first,
          "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3) AS result",
          [raceUser, nextLeaseId, nextAdmission.epoch],
        ),
        true,
      );
      console.log(
        "PASS legacy ledger insert racing claim returns HISTORICAL, releases only its lease, and cannot release a newer epoch",
      );
    } finally {
      if (legacyTransactionOpen) await second.query("ROLLBACK").catch(() => {});
      if (racingClaim) await racingClaim.catch(() => {});
      await inspect
        .query(
          "DROP TRIGGER IF EXISTS test_pause_whatsapp_claim_after_lease ON public.tb_whatsapp_user_contexts; DROP FUNCTION IF EXISTS public.test_pause_whatsapp_claim_after_lease(); DROP TABLE IF EXISTS public.test_whatsapp_claim_lease_capture",
        )
        .catch(() => {});
      const remainingContext = await inspect
        .query(
          "SELECT processing_lease_id,processing_epoch FROM public.tb_whatsapp_user_contexts WHERE user_id=$1",
          [raceUser],
        )
        .catch(() => ({ rows: [] }));
      if (remainingContext.rows[0]?.processing_lease_id) {
        await inspect
          .query(
            "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
            [
              raceUser,
              remainingContext.rows[0].processing_lease_id,
              remainingContext.rows[0].processing_epoch,
            ],
          )
          .catch(() => {});
      }
      await inspect
        .query("DELETE FROM public.tb_whatsapp_event_receipts WHERE external_event_id=$1", [raceEvent])
        .catch(() => {});
      await inspect
        .query("DELETE FROM public.tb_processed_whatsapp_events WHERE external_event_id=$1", [raceEvent])
        .catch(() => {});
      await inspect
        .query("DELETE FROM public.tb_whatsapp_user_contexts WHERE user_id=$1", [raceUser])
        .catch(() => {});
      await inspect
        .query("DELETE FROM public.tb_whatsapp_links WHERE id=$1", [raceLink])
        .catch(() => {});
      await inspect
        .query("DELETE FROM public.tb_users WHERE id=$1", [raceUser])
        .catch(() => {});
      await inspect
        .query("DELETE FROM auth.users WHERE id=$1", [raceUser])
        .catch(() => {});
      await inspect
        .query("DROP OWNED BY whatsapp_legacy_runtime; DROP ROLE whatsapp_legacy_runtime")
        .catch(() => {});
    }

    for (const [n, kind] of [
      [2, "CREATE_EXPENSE"],
      [3, "CREATE_INCOME"],
    ]) {
      const p = await prepare(n, kind),
        before = await state(n, p.event);
      // Failure after the nested confirmation must roll everything back.
      await inspect.query(`CREATE FUNCTION public.test_receipt_checkpoint_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.business_result IS NOT NULL AND OLD.business_result IS NULL THEN RAISE EXCEPTION 'injected receipt checkpoint failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_receipt_checkpoint_failure BEFORE UPDATE ON public.tb_whatsapp_event_receipts FOR EACH ROW EXECUTE FUNCTION public.test_receipt_checkpoint_failure()`);
      await assert.rejects(
        confirm(first, p),
        (err) =>
          err.code === "P0001" &&
          err.message === "injected receipt checkpoint failure",
      );
      assert.deepEqual(await state(n, p.event), before);
      await inspect.query(
        "DROP TRIGGER test_receipt_checkpoint_failure ON public.tb_whatsapp_event_receipts; DROP FUNCTION public.test_receipt_checkpoint_failure()",
      );
      // Deliberately discard the returned result after COMMIT; recover from SQL.
      await confirm(first, p);
      const after = await state(n, p.event),
        checkpoint = after.receipt.business_result;
      assert.equal(checkpoint.status, "CREATED");
      assert.equal(after.proposals[0].status, "COMPLETED");
      const key = kind === "CREATE_EXPENSE" ? "expenses" : "incomes",
        reference = kind === "CREATE_EXPENSE" ? "expense_id" : "income_id";
      assert.equal(after[key].length, before[key].length + 1);
      assert.equal(after[key][0].id, checkpoint[reference]);
      assert.equal(after.proposals[0][reference], checkpoint[reference]);
      assert.deepEqual(await confirm(first, p), checkpoint);
      assert.deepEqual(await state(n, p.event), after);
      await first.query(
        "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
        [uid(n), p.admission.leaseId, p.admission.contextEpoch],
      );
      await inspect.query(
        "UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=clock_timestamp()-interval '1 second' WHERE external_event_id=$1",
        [p.event],
      );
      assert.equal(
        (await claim(second, n, p.event, randomUUID())).status,
        "READY",
      );
      const ticket = randomUUID();
      await second.query("BEGIN");
      const send = await result(
        second,
        "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
        [p.event, sender(n), digest, ticket],
      );
      assert.equal(send.status, "SEND");
      assert.ok(send.text);
      const competingDelivery = result(
        first,
        "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
        [p.event, sender(n), digest, randomUUID()],
      );
      await waitFirst();
      await second.query("COMMIT");
      assert.equal((await competingDelivery).status, "BUSY");
      assert.equal(
        (
          await result(
            second,
            "SELECT public.fn_finish_whatsapp_delivery($1,$2,$3,'ACCEPTED',200,NULL) AS result",
            [p.event, ticket, send.epoch],
          )
        ).status,
        "ACCEPTED",
      );
      assert.equal(
        (await claim(first, n, p.event, randomUUID())).status,
        "DUPLICATE",
      );
      console.log(
        `PASS ${kind} checkpoint rollback, lost SQL response, immutable replay and single delivery permit`,
      );
    }

    const rejected = await prepare(8, "CREATE_INCOME");
    const rejectConversation = `whatsapp:123456:${sender(8)}`;
    const reject = (client) =>
      result(
        client,
        "SELECT public.fn_reject_whatsapp_proposal_event($1,$2,1,$3,$4,'CREATE_INCOME') AS result",
        [rejected.event, rejected.token, rejected.proposal.id, rejectConversation],
      );
    const beforeRejectedCheckpoint = await state(8, rejected.event);

    await inspect.query(`CREATE FUNCTION public.test_rejection_checkpoint_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.business_result IS NOT NULL AND OLD.business_result IS NULL THEN RAISE EXCEPTION 'injected rejection checkpoint failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_rejection_checkpoint_failure BEFORE UPDATE ON public.tb_whatsapp_event_receipts FOR EACH ROW EXECUTE FUNCTION public.test_rejection_checkpoint_failure()`);
    await assert.rejects(
      reject(first),
      (err) =>
        err.code === "P0001" &&
        err.message === "injected rejection checkpoint failure",
    );
    assert.deepEqual(
      await state(8, rejected.event),
      beforeRejectedCheckpoint,
    );
    await inspect.query(
      "DROP TRIGGER test_rejection_checkpoint_failure ON public.tb_whatsapp_event_receipts; DROP FUNCTION public.test_rejection_checkpoint_failure()",
    );

    // A concurrent duplicate wrapper call blocks behind the checkpoint
    // transaction and then returns its immutable result without rejecting twice.
    await first.query("BEGIN");
    const rejectionOutcome = await reject(first);
    assert.equal(rejectionOutcome.status, "REJECTED");
    const waitConcurrentReject = await waiting(second);
    const concurrentRejection = reject(second);
    await waitConcurrentReject();
    await first.query("COMMIT");
    assert.deepEqual(await concurrentRejection, rejectionOutcome);

    const afterRejectedCheckpoint = await state(8, rejected.event);
    const rejectedProposal = afterRejectedCheckpoint.proposals.find(
      (row) => row.id === rejected.proposal.id,
    );
    assert.equal(rejectedProposal.status, "REJECTED");
    assert.equal(rejectedProposal.version, 2);
    assert.equal(
      afterRejectedCheckpoint.receipt.business_result.status,
      "REJECTED",
    );
    assert.equal(
      afterRejectedCheckpoint.receipt.reply_text,
      "Operación rechazada.",
    );
    assert.equal(afterRejectedCheckpoint.receipt.reply_template, "TEXT_V1");
    assert.equal(afterRejectedCheckpoint.receipt.delivery_state, "READY");
    assert.equal(afterRejectedCheckpoint.receipt.processing_state, "RUNNING");
    assert.equal(afterRejectedCheckpoint.receipt.operation_digest.length, 64);
    assert.equal(afterRejectedCheckpoint.incomes.length, 0);
    assert.deepEqual(await state(8, rejected.event), afterRejectedCheckpoint);

    assert.equal(
      (
        await result(
          first,
          "SELECT public.fn_finish_whatsapp_event($1,$2,1,'TEXT_V1','Operación rechazada.','{\"financial\":true}') AS result",
          [rejected.event, rejected.token],
        )
      ).status,
      "COMPLETED",
    );
    await first.query(
      "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
      [uid(8), rejected.admission.leaseId, rejected.admission.contextEpoch],
    );
    assert.equal(
      (await claim(second, 8, rejected.event, randomUUID())).status,
      "READY",
    );
    const rejectionDeliveryToken = randomUUID();
    const rejectionDelivery = await result(
      second,
      "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
      [
        rejected.event,
        sender(8),
        digest,
        rejectionDeliveryToken,
      ],
    );
    assert.equal(rejectionDelivery.status, "SEND");
    assert.equal(rejectionDelivery.text, "Operación rechazada.");
    assert.equal(
      (
        await result(
          second,
          "SELECT public.fn_finish_whatsapp_delivery($1,$2,$3,'ACCEPTED',200,NULL) AS result",
          [rejected.event, rejectionDeliveryToken, rejectionDelivery.epoch],
        )
      ).status,
      "ACCEPTED",
    );
    assert.equal(
      (await claim(first, 8, rejected.event, randomUUID())).status,
      "DUPLICATE",
    );
    assert.equal(
      (await state(8, rejected.event)).proposals.find(
        (row) => row.id === rejected.proposal.id,
      ).version,
      2,
    );
    console.log(
      "PASS WhatsApp proposal rejection checkpoint rollback, concurrent replay, stored-response redelivery and single mutation",
    );

    const p = await prepare(4, "CREATE_INCOME");
    await first.query(
      "SELECT public.fn_update_whatsapp_proposal_event($1,$2,1,$3,$4,'CREATE_INCOME','{}',$5)",
      [
        p.event,
        p.token,
        p.proposal.id,
        `whatsapp:123456:${sender(4)}`,
        p.proposal.updated_at,
      ],
    );
    const modified = await state(4, p.event);
    const compensate = () =>
      result(
        first,
        "SELECT public.fn_compensate_whatsapp_proposal_event($1,$2,1,$3,$4,'CREATE_INCOME') AS result",
        [p.event, p.token, p.proposal.id, `whatsapp:123456:${sender(4)}`],
      );
    assert.equal((await compensate()).status, "VERSION_CONFLICT");
    assert.deepEqual(await state(4, p.event), modified);
    await inspect.query(
      "UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=clock_timestamp()-interval '1 second' WHERE external_event_id=$1",
      [p.event],
    );
    const expired = await state(4, p.event);
    await assert.rejects(
      compensate(),
      (err) =>
        err.code === "40001" &&
        err.message === "WhatsApp event is no longer current",
    );
    assert.deepEqual(await state(4, p.event), expired);
    console.log(
      "PASS creator/version compensation refuses modified proposal and stale worker without deletion",
    );

    // Both actual gate orders: confirmation commits before revocation, or the
    // revocation commits before the operation can revalidate its receipt.
    for (const [n, operationFirst] of [
      [5, true],
      [6, false],
    ]) {
      const q = await prepare(n, "CREATE_INCOME");
      await first.query("BEGIN");
      await second.query("BEGIN");
      if (operationFirst) {
        await confirm(first, q);
        const revoking = result(
          second,
          "SELECT public.fn_revoke_whatsapp_link($1,$2,1) AS result",
          [uid(n), uid(100 + n)],
        );
        await waitSecond();
        await first.query("COMMIT");
        assert.equal((await revoking).status, "REVOKED");
        await second.query("COMMIT");
      } else {
        assert.equal(
          (
            await result(
              second,
              "SELECT public.fn_revoke_whatsapp_link($1,$2,1) AS result",
              [uid(n), uid(100 + n)],
            )
          ).status,
          "REVOKED",
        );
        const pending = confirm(first, q).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await waitFirst();
        await second.query("COMMIT");
        assert.equal((await pending).error.code, "40001");
        await first.query("ROLLBACK");
      }
      const s = await state(n, q.event);
      assert.equal(s.incomes.length, operationFirst ? 1 : 0);
      assert.equal(
        s.proposals[0].status,
        operationFirst ? "COMPLETED" : "AWAITING_CONFIRMATION",
      );
      assert.equal(Boolean(s.receipt.business_result), operationFirst);
      if (operationFirst) {
        await inspect.query(
          "UPDATE public.tb_whatsapp_event_receipts SET processing_state='COMPLETED' WHERE external_event_id=$1",
          [q.event],
        );
        assert.equal(
          (
            await result(
              first,
              "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
              [q.event, sender(n), digest, randomUUID()],
            )
          ).status,
          "BLOCKED",
        );
        assert.equal((await receipt(q.event)).reply_text, null);
      }
      console.log(
        `PASS event confirmation/revocation operationFirst=${operationFirst}; result and authorization fencing`,
      );
    }

    // Link completion and receipt insertion form one transaction too.
    const linkId = uid(313),
      linkEvent = "recovery-link",
      codeDigest = "b".repeat(64);
    assert.equal(
      (
        await result(
          first,
          "SELECT public.fn_start_whatsapp_link_challenge($1,$2,$3,$4,$2) AS result",
          [uid(13), linkId, sender(13), codeDigest],
        )
      ).status,
      "PENDING",
    );
    await inspect.query(`CREATE FUNCTION public.test_link_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected link receipt failure' USING ERRCODE='P0001'; END $$;
      CREATE TRIGGER test_link_receipt_failure BEFORE INSERT ON public.tb_whatsapp_event_receipts FOR EACH ROW EXECUTE FUNCTION public.test_link_receipt_failure()`);
    const link = (client) =>
      result(
        client,
        "SELECT public.fn_complete_whatsapp_link_event($1,$2,'123456',$3,$4,$5) AS result",
        [linkEvent, sender(13), digest, linkId, codeDigest],
      );
    await assert.rejects(
      link(first),
      (err) =>
        err.code === "P0001" && err.message === "injected link receipt failure",
    );
    assert.equal(
      (
        await inspect.query(
          "SELECT status,attempts FROM public.tb_whatsapp_link_challenges WHERE id=$1",
          [linkId],
        )
      ).rows[0].status,
      "PENDING",
    );
    assert.equal(
      (
        await inspect.query(
          "SELECT count(*)::int AS n FROM public.tb_whatsapp_links WHERE user_id=$1",
          [uid(13)],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await inspect.query(
          "SELECT count(*)::int AS n FROM public.tb_processed_whatsapp_events WHERE external_event_id=$1",
          [linkEvent],
        )
      ).rows[0].n,
      0,
    );
    await inspect.query(
      "DROP TRIGGER test_link_receipt_failure ON public.tb_whatsapp_event_receipts; DROP FUNCTION public.test_link_receipt_failure()",
    );
    assert.deepEqual(
      (
        await inspect.query(
          "SELECT status,attempts FROM public.tb_whatsapp_link_challenges WHERE id=$1",
          [linkId],
        )
      ).rows[0],
      { status: "PENDING", attempts: 0 },
    );
    assert.equal(
      (
        await inspect.query(
          "SELECT count(*)::int AS n FROM public.tb_whatsapp_link_events WHERE external_event_id=$1",
          [linkEvent],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await inspect.query(
          "SELECT count(*)::int AS n FROM public.tb_whatsapp_link_attempt_buckets WHERE sender_digest=encode(sha256(convert_to($1,'UTF8')),'hex')",
          [sender(13)],
        )
      ).rows[0].n,
      0,
    );
    await first.query("BEGIN");
    assert.equal((await link(first)).status, "READY");
    const replay = link(second);
    await waitSecond();
    await first.query("COMMIT");
    assert.equal((await replay).status, "READY");
    const linked = await receipt(linkEvent);
    assert.equal(linked.business_result.status, "LINKED");
    assert.ok(!JSON.stringify(linked).includes(codeDigest));
    assert.equal(
      (
        await inspect.query(
          "SELECT count(*)::int AS n FROM public.tb_whatsapp_links WHERE user_id=$1 AND status='ACTIVE'",
          [uid(13)],
        )
      ).rows[0].n,
      1,
    );
    const bucket = await result(
      inspect,
      "SELECT to_jsonb(b) AS result FROM public.tb_whatsapp_link_attempt_buckets b WHERE sender_digest=encode(sha256(convert_to($1,'UTF8')),'hex')",
      [sender(13)],
    );
    assert.equal((await link(first)).status, "READY");
    assert.deepEqual(await receipt(linkEvent), linked);
    assert.deepEqual(
      await result(
        inspect,
        "SELECT to_jsonb(b) AS result FROM public.tb_whatsapp_link_attempt_buckets b WHERE sender_digest=encode(sha256(convert_to($1,'UTF8')),'hex')",
        [sender(13)],
      ),
      bucket,
    );
    console.log(
      "PASS link receipt insertion failure rolls back link, challenge, counter and reservation; concurrent replay consumes once",
    );

    await inspect.query(
      "UPDATE public.tb_whatsapp_event_receipts SET created_at=clock_timestamp()-interval '31 days',reply_expires_at=clock_timestamp()-interval '1 second' WHERE external_event_id=$1",
      [linkEvent],
    );
    assert.ok(
      (
        await inspect.query(
          "SELECT public.fn_purge_whatsapp_event_payloads(1000) AS n",
        )
      ).rows[0].n >= 1,
    );
    const tombstone = await receipt(linkEvent);
    assert.equal(tombstone.reply_text, null);
    assert.equal(tombstone.reply_guard, null);
    assert.equal(tombstone.identity_snapshot, null);
    assert.ok(tombstone.tombstoned_at);
    assert.equal(tombstone.delivery_token, null);
    assert.equal(tombstone.provider_code, null);
    assert.equal(tombstone.delivery_attempts, 0);
    assert.equal(tombstone.request_digest, linked.request_digest);
    assert.deepEqual(tombstone.business_result, linked.business_result);
    assert.equal(
      (
        await inspect.query(
          "SELECT count(*)::int AS n FROM public.tb_processed_whatsapp_events WHERE external_event_id=$1",
          [linkEvent],
        )
      ).rows[0].n,
      1,
    );
    console.log(
      "PASS retention removes expired payload and preserves deduplication tombstone",
    );

    for (const [n, change] of [
      [7, "MEMBERSHIP"],
      [8, "HOUSEHOLD"],
    ]) {
      const q = await prepare(n, "CREATE_INCOME");
      await confirm(first, q);
      await first.query(
        "SELECT public.fn_finish_whatsapp_event($1,$2,1,'TEXT_V1','ignored','{}')",
        [q.event, q.token],
      );
      await first.query(
        "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
        [uid(n), q.admission.leaseId, q.admission.contextEpoch],
      );
      if (change === "MEMBERSHIP")
        await inspect.query(
          "UPDATE public.tb_household_members SET status='LEFT' WHERE id=$1",
          [uid(n)],
        );
      else
        await inspect.query(
          "UPDATE public.tb_whatsapp_user_contexts SET selected_household_id=NULL,selected_member_id=NULL WHERE user_id=$1",
          [uid(n)],
        );
      assert.equal(
        (
          await result(
            first,
            "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
            [q.event, sender(n), digest, randomUUID()],
          )
        ).status,
        "BLOCKED",
      );
      assert.equal((await receipt(q.event)).reply_text, null);
    }
    console.log(
      "PASS membership loss and changed household block saved financial response",
    );
    const noHouseholdToken = randomUUID();
    const noHouseholdEvent = "recovery-no-households";
    const noHouseholdClaim = await claim(
      first,
      7,
      noHouseholdEvent,
      noHouseholdToken,
    );
    assert.equal(noHouseholdClaim.status, "CLAIMED");
    assert.equal(
      (await begin(first, noHouseholdEvent, noHouseholdToken)).status,
      "STARTED",
    );
    await first.query(
      "SELECT public.fn_finish_whatsapp_event($1,$2,1,'TEXT_V1','No tienes hogares activos.','{\"financial\":false}')",
      [noHouseholdEvent, noHouseholdToken],
    );
    await first.query(
      "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
      [uid(7), noHouseholdClaim.leaseId, noHouseholdClaim.contextEpoch],
    );
    assert.equal((await receipt(noHouseholdEvent)).household_id, null);
    const noHouseholdDelivery = randomUUID();
    assert.equal(
      (
        await result(
          first,
          "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
          [noHouseholdEvent, sender(7), digest, noHouseholdDelivery],
        )
      ).status,
      "SEND",
    );
    await first.query(
      "SELECT public.fn_finish_whatsapp_delivery($1,$2,1,'ACCEPTED',200,NULL)",
      [noHouseholdEvent, noHouseholdDelivery],
    );
    console.log(
      "PASS generic zero-household control reply does not inherit an inactive financial scope",
    );

    const menu = await prepare(9, "CREATE_INCOME");
    await inspect.query(
      "UPDATE public.tb_whatsapp_user_contexts SET menu_household_ids=ARRAY[$2::uuid,$2::uuid],menu_phone_number_id='123456',menu_expires_at=clock_timestamp()+interval '1 second' WHERE user_id=$1",
      [uid(9), household],
    );
    await first.query(
      "SELECT public.fn_finish_whatsapp_event($1,$2,1,'MENU_V1','Fixture menu','{}')",
      [menu.event, menu.token],
    );
    await first.query(
      "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
      [uid(9), menu.admission.leaseId, menu.admission.contextEpoch],
    );
    await inspect.query(
      "UPDATE public.tb_whatsapp_user_contexts SET menu_expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
      [uid(9)],
    );
    const menuBefore = await result(
      inspect,
      "SELECT to_jsonb(c) AS result FROM public.tb_whatsapp_user_contexts c WHERE user_id=$1",
      [uid(9)],
    );
    assert.equal(
      (
        await result(
          first,
          "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
          [menu.event, sender(9), digest, randomUUID()],
        )
      ).status,
      "EXPIRED",
    );
    assert.deepEqual(
      await result(
        inspect,
        "SELECT to_jsonb(c) AS result FROM public.tb_whatsapp_user_contexts c WHERE user_id=$1",
        [uid(9)],
      ),
      menuBefore,
    );
    console.log("PASS replay cannot restore or extend an expired menu");

    const reserved = "recovery-reserved",
      oldToken = randomUUID(),
      newToken = randomUUID();
    assert.equal(
      (await claim(first, 10, reserved, oldToken)).status,
      "CLAIMED",
    );
    await inspect.query(
      "UPDATE public.tb_whatsapp_user_contexts SET processing_expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
      [uid(10)],
    );
    await inspect.query(
      "UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=clock_timestamp()-interval '1 second' WHERE external_event_id=$1",
      [reserved],
    );
    const recovered = await claim(second, 10, reserved, newToken);
    assert.equal(recovered.status, "CLAIMED");
    assert.equal(recovered.epoch, 2);
    await assert.rejects(
      begin(first, reserved, oldToken),
      (err) => err.code === "40001",
    );
    assert.equal(
      (await begin(second, reserved, newToken, 2)).status,
      "STARTED",
    );
    const reservedBefore = await state(10, reserved);
    await assert.rejects(
      first.query(
        "SELECT public.fn_create_whatsapp_draft_event($1,$2,1,$3,'fixture','CREATE_INCOME','{}','AWAITING_DETAILS')",
        [reserved, oldToken, randomUUID()],
      ),
      (err) => err.code === "40001",
    );
    await assert.rejects(
      first.query("SELECT public.fn_renew_whatsapp_event($1,$2,1)", [
        reserved,
        oldToken,
      ]),
      (err) => err.code === "40001",
    );
    await assert.rejects(
      first.query(
        "SELECT public.fn_finish_whatsapp_event($1,$2,1,'TEXT_V1','stale','{}')",
        [reserved, oldToken],
      ),
      (err) => err.code === "40001",
    );
    assert.deepEqual(await state(10, reserved), reservedBefore);
    console.log(
      "PASS RESERVED recovery advances epoch; stale worker cannot begin, write draft, renew or finish",
    );

    await first.query(
      "SELECT public.fn_transition_whatsapp_event_context($1,$2,2,'123456','SET_SELECTION',$3,$4)",
      [reserved, newToken, household, uid(10)],
    );
    await first.query("SELECT public.fn_bind_whatsapp_event_context($1,$2,2)", [
      reserved,
      newToken,
    ]);
    const draftId = randomUUID(),
      conversation = `whatsapp:123456:${sender(10)}`;
    const createdDraft = await result(
      first,
      "SELECT to_jsonb(public.fn_create_whatsapp_draft_event($1,$2,2,$3,$4,'CREATE_INCOME','{}','AWAITING_DETAILS')) AS result",
      [reserved, newToken, draftId, conversation],
    );
    const updatedDraft = await result(
      first,
      "SELECT to_jsonb(public.fn_update_whatsapp_draft_event($1,$2,2,$3,$4,'CREATE_INCOME','{\"description\":\"fixture\"}','AWAITING_DETAILS',$5)) AS result",
      [reserved, newToken, draftId, conversation, createdDraft.updated_at],
    );
    assert.equal(updatedDraft.payload.description, "fixture");
    assert.equal(
      await result(
        first,
        "SELECT public.fn_delete_whatsapp_draft_event($1,$2,2,$3,$4,$5) AS result",
        [reserved, newToken, draftId, conversation, updatedDraft.updated_at],
      ),
      true,
    );
    const missingProposalOutcome = await result(
      first,
      "SELECT public.fn_confirm_whatsapp_income_event($1,$2,2,$3,$4,NULL,$5,NULL,NULL,NULL,NULL) AS result",
      [reserved, newToken, randomUUID(), conversation, uid(10)],
    );
    assert.equal(missingProposalOutcome.status, "NOT_FOUND");
    assert.equal((await receipt(reserved)).business_result, null);

    const rejectId = randomUUID();
    const createArgs = [
      reserved,
      newToken,
      rejectId,
      conversation,
      JSON.stringify({ actorMemberId: uid(10), source: "WHATSAPP" }),
    ];
    await first.query(
      "SELECT public.fn_create_whatsapp_proposal_event($1,$2,2,$3,$4,'CREATE_INCOME',$5)",
      createArgs,
    );
    assert.equal(
      (
        await result(
          first,
          "SELECT public.fn_reject_whatsapp_proposal_event($1,$2,2,$3,$4,'CREATE_INCOME') AS result",
          createArgs.slice(0, 4),
        )
      ).status,
      "REJECTED",
    );
    const rejectedCheckpoint = await receipt(reserved);
    assert.equal(rejectedCheckpoint.business_result.status, "REJECTED");
    assert.equal(rejectedCheckpoint.reply_text, "Operación rechazada.");
    await assert.rejects(
      first.query(
        "SELECT public.fn_confirm_whatsapp_income_event($1,$2,2,$3,$4,NULL,$5,NULL,NULL,NULL,NULL)",
        [reserved, newToken, rejectId, conversation, uid(10)],
      ),
      (err) =>
        err.code === "40001" && err.message === "Event operation changed",
    );
    assert.deepEqual(await receipt(reserved), rejectedCheckpoint);

    const compensation = await prepare(8, "CREATE_INCOME");
    assert.equal(
      (
        await result(
          first,
          "SELECT public.fn_compensate_whatsapp_proposal_event($1,$2,1,$3,$4,'CREATE_INCOME') AS result",
          [
            compensation.event,
            compensation.token,
            compensation.proposal.id,
            `whatsapp:123456:${sender(8)}`,
          ],
        )
      ).status,
      "REMOVED",
    );
    await first.query(
      "SELECT public.fn_finish_whatsapp_event($1,$2,1,'TEXT_V1','Fixture compensation','{}')",
      [compensation.event, compensation.token],
    );
    await first.query(
      "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
      [uid(8), compensation.admission.leaseId, compensation.admission.contextEpoch],
    );
    const macro = (
      await inspect.query(
        "SELECT id FROM public.tb_categories WHERE level='MACRO' AND movement_type='INCOME' AND is_active LIMIT 1",
      )
    ).rows[0].id;
    const categoryId = randomUUID();
    const category = await result(
      first,
      "SELECT to_jsonb(public.fn_insert_whatsapp_category_event($1,$2,2,$3,'Receipt fixture micro','INCOME',$4)) AS result",
      [reserved, newToken, categoryId, macro],
    );
    assert.equal(category.parent_id, macro);
    assert.equal(category.level, "MICRO");
    await inspect.query(
      "UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=clock_timestamp()-interval '1 second' WHERE external_event_id=$1",
      [reserved],
    );
    const beforeStaleWrites = await state(10, reserved);
    for (const sql of [
      "SELECT public.fn_create_whatsapp_proposal_event($1,$2,2,$3,'fixture','CREATE_INCOME','{}')",
      "SELECT public.fn_update_whatsapp_proposal_event($1,$2,2,$3,'fixture','CREATE_INCOME','{}',now())",
      "SELECT public.fn_reject_whatsapp_proposal_event($1,$2,2,$3,'fixture','CREATE_INCOME')",
      "SELECT public.fn_compensate_whatsapp_proposal_event($1,$2,2,$3,'fixture','CREATE_INCOME')",
      "SELECT public.fn_create_whatsapp_draft_event($1,$2,2,$3,'fixture','CREATE_INCOME','{}','AWAITING_DETAILS')",
      "SELECT public.fn_update_whatsapp_draft_event($1,$2,2,$3,'fixture','CREATE_INCOME','{}','AWAITING_DETAILS',now())",
      "SELECT public.fn_delete_whatsapp_draft_event($1,$2,2,$3,'fixture',now())",
      "SELECT public.fn_insert_whatsapp_category_event($1,$2,2,$3,'stale','INCOME',NULL)",
    ])
      await assert.rejects(
        first.query(sql, [reserved, newToken, randomUUID()]),
        (err) =>
          err.code === "40001" &&
          err.message === "WhatsApp event is no longer current",
      );
    assert.deepEqual(await state(10, reserved), beforeStaleWrites);
    assert.equal(
      (
        await inspect.query(
          "SELECT count(*)::int AS n FROM public.tb_categories WHERE name='stale'",
        )
      ).rows[0].n,
      0,
    );
    console.log(
      "PASS valid draft/proposal/category wrappers, exact compensation and rejection; all eight stale write entries preserve state",
    );

    // A conflicting legacy owner cannot inherit verified identity or its reply.
    await inspect.query(
      "INSERT INTO public.tb_whatsapp_links(id,user_id,sender,status,authorization_version,verified_at) VALUES($1,$1,$2,'ACTIVE',1,now())",
      [uid(15), sender(15)],
    );
    const ambiguous = await prepare(15, "CREATE_INCOME");
    await first.query(
      "SELECT public.fn_finish_whatsapp_event($1,$2,1,'TEXT_V1','Fixture private response','{\"financial\":true}')",
      [ambiguous.event, ambiguous.token],
    );
    await first.query(
      "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
      [uid(15), ambiguous.admission.leaseId, ambiguous.admission.contextEpoch],
    );
    await inspect.query(
      "UPDATE public.tb_users SET external_identifier=$1 WHERE id=$2",
      [sender(15), uid(14)],
    );
    assert.equal(
      (await claim(first, 15, "recovery-identity-conflict", randomUUID()))
        .status,
      "UNAVAILABLE",
    );
    assert.equal(
      (
        await result(
          first,
          "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
          [ambiguous.event, sender(15), digest, randomUUID()],
        )
      ).status,
      "BLOCKED",
    );
    assert.equal((await receipt(ambiguous.event)).reply_text, null);
    console.log(
      "PASS ambiguous legacy/verified ownership blocks admission and saved response without identity disclosure",
    );

    await inspect.query(
      "INSERT INTO public.tb_whatsapp_links(id,user_id,sender,status,authorization_version,verified_at) VALUES($1,$1,$2,'ACTIVE',1,now())",
      [uid(16), sender(16)],
    );
    const initialLease = randomUUID();
    const admitted = await result(
      first,
      "SELECT public.fn_admit_whatsapp_sender($1,$2) AS result",
      [sender(16), initialLease],
    );
    await first.query(
      "SELECT public.fn_transition_whatsapp_household_context($1,'123456',$2,$3,'SET_SELECTION',$4,$1)",
      [uid(16), initialLease, admitted.epoch, household],
    );
    await first.query(
      "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
      [uid(16), initialLease, admitted.epoch],
    );
    assert.equal(
      (await claim(first, 16, "reserved-changed-selection", randomUUID()))
        .status,
      "CLAIMED",
    );
    await inspect.query(
      "UPDATE public.tb_whatsapp_user_contexts SET processing_expires_at=clock_timestamp()-interval '1 second',selected_household_id=NULL,selected_member_id=NULL WHERE user_id=$1",
      [uid(16)],
    );
    await inspect.query(
      "UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=clock_timestamp()-interval '1 second' WHERE external_event_id='reserved-changed-selection'",
    );
    const changedSelection = await result(
      inspect,
      "SELECT to_jsonb(c) AS result FROM public.tb_whatsapp_user_contexts c WHERE user_id=$1",
      [uid(16)],
    );
    assert.equal(
      (await claim(second, 16, "reserved-changed-selection", randomUUID()))
        .status,
      "UNCERTAIN",
    );
    assert.deepEqual(
      await result(
        inspect,
        "SELECT to_jsonb(c) AS result FROM public.tb_whatsapp_user_contexts c WHERE user_id=$1",
        [uid(16)],
      ),
      changedSelection,
    );
    console.log(
      "PASS RESERVED cannot recover under a changed household/menu admission snapshot",
    );

    const abandoned = await prepare(11, "CREATE_INCOME"),
      ticket = randomUUID();
    await first.query(
      "SELECT public.fn_finish_whatsapp_event($1,$2,1,'TEXT_V1','Fixture reply','{}')",
      [abandoned.event, abandoned.token],
    );
    await first.query(
      "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
      [uid(11), abandoned.admission.leaseId, abandoned.admission.contextEpoch],
    );
    const sending = await result(
      first,
      "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
      [abandoned.event, sender(11), digest, ticket],
    );
    assert.equal(sending.status, "SEND");
    await inspect.query(
      "UPDATE public.tb_whatsapp_event_receipts SET delivery_expires_at=clock_timestamp()-interval '1 second' WHERE external_event_id=$1",
      [abandoned.event],
    );
    assert.equal(
      (
        await result(
          second,
          "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
          [abandoned.event, sender(11), digest, randomUUID()],
        )
      ).status,
      "UNKNOWN",
    );
    const unknown = await receipt(abandoned.event);
    await assert.rejects(
      first.query(
        "SELECT public.fn_finish_whatsapp_delivery($1,$2,$3,'ACCEPTED',200,NULL)",
        [abandoned.event, ticket, sending.epoch],
      ),
      (err) => err.code === "40001",
    );
    assert.deepEqual(await receipt(abandoned.event), unknown);
    console.log(
      "PASS abandoned SENDING becomes UNKNOWN; late outcome cannot overwrite it",
    );

    for (const kind of ["invitation", "leave", "remove", "transfer"])
      for (const operationFirst of [true, false]) {
        await inspect.query(
          "UPDATE public.tb_household_members SET role='MEMBER',status='ACTIVE' WHERE id=$1",
          [uid(12)],
        );
        await inspect.query(
          "UPDATE public.tb_household_members SET role='OWNER',status='ACTIVE' WHERE id=$1",
          [uid(1)],
        );
        await inspect.query(
          "DELETE FROM public.tb_notifications WHERE source_entity_id=$1",
          [uid(12)],
        );
        const q = await prepare(12, "CREATE_INCOME"),
          before = await state(12, q.event);
        let sql, args;
        if (kind === "invitation") {
          await inspect.query(
            "UPDATE auth.users SET email='receipt-invite@example.test' WHERE id=$1",
            [uid(12)],
          );
          const invitation = await result(
            inspect,
            "SELECT public.fn_create_household_invitation($1,$2,'receipt-invite@example.test',$3,now()+interval '1 day') AS result",
            [household, uid(1), randomUUID()],
          );
          sql = "SELECT public.fn_accept_household_invitation_by_id($1,$2)";
          args = [uid(12), invitation.invitationId];
        } else if (kind === "leave") {
          sql = "SELECT public.fn_leave_household($1,$2)";
          args = [uid(12), household];
        } else if (kind === "remove") {
          sql = "SELECT public.fn_remove_household_member($1,$2,$3)";
          args = [uid(1), household, uid(12)];
        } else {
          sql = "SELECT public.fn_transfer_household_owner($1,$2,$3,$4)";
          args = [uid(1), household, uid(12), randomUUID()];
        }
        await first.query("BEGIN");
        await second.query("BEGIN");
        if (operationFirst) {
          assert.equal((await confirm(first, q)).status, "CREATED");
          const changing = second.query(sql, args);
          await waitSecond();
          await first.query("COMMIT");
          await changing;
          await second.query("COMMIT");
        } else {
          await second.query(sql, args);
          // NOWAIT avoids introducing an inverse wait cycle while holding receipt.
          await assert.rejects(
            confirm(first, q),
            (err) => err.code === "55P03",
          );
          await first.query("ROLLBACK");
          await second.query("COMMIT");
        }
        const after = await state(12, q.event);
        assert.equal(
          after.incomes.length - before.incomes.length,
          operationFirst ? 1 : 0,
        );
        assert.equal(
          after.proposals.find((row) => row.id === q.proposal.id).status,
          operationFirst ? "COMPLETED" : "AWAITING_CONFIRMATION",
        );
        assert.equal(Boolean(after.receipt.business_result), operationFirst);
        if (!operationFirst) {
          assert.deepEqual(after.receipt, before.receipt);
          assert.deepEqual(after.incomes, before.incomes);
        }
        await first.query(
          "SELECT public.fn_release_whatsapp_context_lease($1,$2,$3)",
          [uid(12), q.admission.leaseId, q.admission.contextEpoch],
        );
        await inspect.query(
          "DELETE FROM public.tb_pending_proposals WHERE id=$1",
          [q.proposal.id],
        );
        console.log(
          `PASS receipt vs actual ${kind} RPC operationFirst=${operationFirst}; controlled completion/NOWAIT without deadlock`,
        );
      }
  } finally {
    await Promise.allSettled(clients.map((c) => c.query("ROLLBACK")));
    await Promise.all(clients.map((c) => c.end()));
  }
};
