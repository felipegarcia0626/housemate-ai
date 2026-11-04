const assert = require("node:assert/strict");

// Called only with the runner's disposable PostgreSQL instance, no remote URL.
module.exports = async function whatsappAuthorizationConcurrency(postgres) {
  const clients = [0, 1, 2].map(() => postgres.getPgClient("housemate_test"));
  await Promise.all(clients.map((c) => c.connect()));
  const [operation, change, observer] = clients;
  const uid = (n) => `44000000-0044-4000-8000-${String(n).padStart(12, "0")}`;
  const household = uid(99);
  const sender = (n) => `199900003${String(n).padStart(2, "0")}`;
  const queryResult = async (client, sql, args) =>
    (await client.query(sql, args)).rows[0].result;
  const admit = (client, n) =>
    queryResult(
      client,
      "SELECT public.fn_admit_whatsapp_sender($1,$2) AS result",
      [sender(n), uid(n)],
    );
  const revoke = (client, n) =>
    queryResult(
      client,
      "SELECT public.fn_revoke_whatsapp_link($1,$2,1) AS result",
      [uid(n), uid(100 + n)],
    );
  const capture = (promise) =>
    promise.then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
  async function state(n) {
    const result = {};
    for (const [key, table, filter] of [
      ["links", "tb_whatsapp_links", "user_id"],
      ["challenges", "tb_whatsapp_link_challenges", "user_id"],
      ["contexts", "tb_whatsapp_user_contexts", "user_id"],
      ["proposals", "tb_pending_proposals", "actor_member_id"],
      ["drafts", "tb_agent_category_drafts", "actor_member_id"],
      ["incomes", "tb_incomes", "created_by"],
      ["expenses", "tb_expenses", "created_by"],
      ["distributions", "tb_expense_distributions", "household_member_id"],
    ]) {
      result[key] = (
        await observer.query(
          `SELECT to_jsonb(t) AS row FROM public.${table} t WHERE ${filter}=$1 ORDER BY to_jsonb(t)::text`,
          [uid(n)],
        )
      ).rows.map(({ row }) => row);
    }
    for (const table of [
      "tb_whatsapp_link_events",
      "tb_whatsapp_link_attempt_buckets",
      "tb_processed_whatsapp_events",
    ]) {
      result[table] = (
        await observer.query(
          `SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows.map(({ row }) => row);
    }
    return result;
  }
  function revokedOnly(before, after) {
    assert.equal(after.links.length, 1);
    assert.ok(after.links[0].revoked_at);
    assert.equal(after.links[0].status, "REVOKED");
    assert.equal(after.links[0].authorization_version, 2);
    assert.deepEqual(after, {
      ...before,
      links: [
        {
          ...before.links[0],
          status: "REVOKED",
          authorization_version: 2,
          revoked_at: after.links[0].revoked_at,
        },
      ],
    });
  }
  async function waitBlocked(client) {
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    return async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (
          (
            await observer.query(
              "SELECT cardinality(pg_blocking_pids($1))>0 AS waiting",
              [pid],
            )
          ).rows[0].waiting
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Expected real authorization lock wait");
    };
  }
  async function prepare(n, kind = "CREATE_INCOME") {
    const admission = await admit(operation, n);
    assert.equal(admission.status, "ADMITTED");
    await operation.query(
      "SELECT public.fn_transition_whatsapp_household_context($1,'test-emitter',$1,$2,'SET_SELECTION',$3,$1)",
      [uid(n), admission.epoch, household],
    );
    const proposal = await queryResult(
      operation,
      "SELECT to_jsonb(public.fn_create_whatsapp_pending_proposal($1,$2,$3,$4,$5,$6,$4,$4,$7)) AS result",
      [
        uid(200 + n),
        household,
        `authorization:${n}`,
        uid(n),
        kind,
        JSON.stringify({ actorMemberId: uid(n), source: "WHATSAPP" }),
        admission.epoch,
      ],
    );
    return { admission, proposal };
  }
  function confirm(client, n, prepared, kind) {
    const args = [
      uid(n),
      prepared.proposal.id,
      household,
      `authorization:${n}`,
      prepared.proposal.updated_at,
      prepared.admission.epoch,
    ];
    if (kind === "CREATE_INCOME")
      return queryResult(
        client,
        `SELECT public.fn_confirm_pending_income_eligible(
      p_auth_user_id=>$1,p_proposal_id=>$2,p_household_id=>$3,p_conversation_key=>$4,
      p_actor_member_id=>$1,p_context_source=>'WHATSAPP',p_expected_updated_at=>$5,
      p_created_by=>$1,p_member_id=>$1,p_amount=>9,p_income_date=>current_date,p_description=>'Authorization race',
      p_whatsapp_user_id=>$1,p_whatsapp_lease_id=>$1,p_whatsapp_lease_epoch=>$6) AS result`,
        args,
      );
    return queryResult(
      client,
      `SELECT public.fn_confirm_pending_expense_eligible(
      p_auth_user_id=>$1,p_proposal_id=>$2,p_household_id=>$3,p_conversation_key=>$4,
      p_actor_member_id=>$1,p_context_source=>'WHATSAPP',p_expected_updated_at=>$5,
      p_created_by=>$1,p_paid_by=>$1,p_total_amount=>9,p_expense_date=>current_date,
      p_source=>'WHATSAPP',p_items=>'[]',p_distributions=>jsonb_build_array(jsonb_build_object('householdMemberId',$1::uuid,'amount',9,'percentage',100)),
      p_whatsapp_user_id=>$1,p_whatsapp_lease_id=>$1,p_whatsapp_lease_epoch=>$6) AS result`,
      args,
    );
  }
  function financialState(before, after, n, kind, result) {
    assert.equal(after.proposals.length, 1);
    const proposal = after.proposals[0];
    assert.equal(proposal.status, "COMPLETED");
    assert.ok(proposal.resolved_at);
    const isIncome = kind === "CREATE_INCOME";
    const key = isIncome ? "incomes" : "expenses";
    const reference = isIncome ? "income_id" : "expense_id";
    const movement = after[key][0];
    assert.equal(after[key].length, 1);
    assert.equal(movement.id, result[reference]);
    assert.equal(proposal[reference], movement.id);
    assert.equal(proposal[isIncome ? "expense_id" : "income_id"], null);
    assert.equal(movement.household_id, household);
    assert.equal(movement.created_by, uid(n));
    assert.equal(movement[isIncome ? "member_id" : "paid_by"], uid(n));
    assert.equal(movement[isIncome ? "amount" : "total_amount"], 9);
    assert.deepEqual(
      {
        ...proposal,
        status: before.proposals[0].status,
        resolved_at: before.proposals[0].resolved_at,
        expense_id: before.proposals[0].expense_id,
        income_id: before.proposals[0].income_id,
        updated_at: before.proposals[0].updated_at,
      },
      before.proposals[0],
    );
    assert.deepEqual(after.contexts, before.contexts);
    assert.deepEqual(after.drafts, before.drafts);
    assert.deepEqual(
      after[isIncome ? "expenses" : "incomes"],
      before[isIncome ? "expenses" : "incomes"],
    );
    if (isIncome) assert.deepEqual(after.distributions, before.distributions);
    else {
      assert.equal(movement.status, "CONFIRMED");
      assert.equal(after.distributions.length, 1);
      assert.equal(after.distributions[0].expense_id, movement.id);
      assert.equal(after.distributions[0].household_member_id, uid(n));
      assert.equal(after.distributions[0].amount, 9);
      assert.equal(after.distributions[0].percentage, 100);
    }
  }
  try {
    await observer.query(`CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,email text);
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz`);
    await observer.query(
      "INSERT INTO public.tb_households(id,name) VALUES($1,'Authorization races')",
      [household],
    );
    for (let n = 1; n <= 12; n++) {
      await observer.query(
        "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'authorization-race@example.test',now())",
        [uid(n)],
      );
      await observer.query(
        "INSERT INTO public.tb_users(id,auth_user_id,external_identifier,display_name) VALUES($1,$1,$2,'Authorization race')",
        [uid(n), `supabase:${uid(n)}`],
      );
      await observer.query(
        "INSERT INTO public.tb_household_members(id,user_id,household_id,display_name,role,status) VALUES($1,$1,$2,'Authorization race',$3,'ACTIVE')",
        [uid(n), household, n === 1 ? "OWNER" : "MEMBER"],
      );
      await observer.query(
        "INSERT INTO public.tb_whatsapp_links(id,user_id,sender,status,authorization_version,verified_at) VALUES($1,$2,$3,'ACTIVE',1,clock_timestamp())",
        [uid(100 + n), uid(n), sender(n)],
      );
    }
    await Promise.all(
      clients.map((c) => c.query("SET statement_timeout='10s'")),
    );
    await operation.query("SET ROLE service_role");
    await change.query("SET ROLE service_role");
    const waitOperation = await waitBlocked(operation),
      waitChange = await waitBlocked(change);

    // The second admission must keep the winner's complete snapshot unchanged.
    const beforeConcurrentAdmission = await state(10);
    await operation.query("BEGIN");
    const winner = await admit(operation, 10);
    const pendingAdmission = capture(admit(change, 10));
    await waitChange();
    await operation.query("COMMIT");
    assert.deepEqual((await pendingAdmission).result, {
      status: "BUSY",
      acquired: false,
    });
    const afterConcurrentAdmission = await state(10);
    assert.deepEqual(
      { ...afterConcurrentAdmission, contexts: [] },
      beforeConcurrentAdmission,
    );
    assert.equal(
      afterConcurrentAdmission.contexts[0].processing_lease_id,
      uid(10),
    );
    assert.equal(
      afterConcurrentAdmission.contexts[0].processing_epoch,
      winner.epoch,
    );
    assert.equal(
      afterConcurrentAdmission.contexts[0].authorization_link_id,
      uid(110),
    );

    for (const renewalFirst of [true, false]) {
      const n = renewalFirst ? 11 : 12;
      const admitted = await admit(operation, n);
      const before = await state(n);
      const renew = (client) =>
        queryResult(
          client,
          "SELECT public.fn_renew_whatsapp_context_lease($1,$1,$2) AS result",
          [uid(n), admitted.epoch],
        );
      let pending;
      let renewedContext;
      if (renewalFirst) {
        await operation.query("BEGIN");
        assert.equal(await renew(operation), true);
        renewedContext = (
          await operation.query(
            "SELECT to_jsonb(t) AS row FROM public.tb_whatsapp_user_contexts t WHERE user_id=$1",
            [uid(n)],
          )
        ).rows[0].row;
        pending = capture(revoke(change, n));
        await waitChange();
        await operation.query("COMMIT");
        assert.equal((await pending).result.status, "REVOKED");
      } else {
        await change.query("BEGIN");
        await revoke(change, n);
        pending = capture(renew(operation));
        await waitOperation();
        await change.query("COMMIT");
        assert.equal((await pending).result, false);
      }
      revokedOnly(
        renewalFirst ? { ...before, contexts: [renewedContext] } : before,
        await state(n),
      );
    }
    console.log(
      "PASS concurrent admission and both renewal/revocation orders preserve complete state",
    );

    // Admission linearizes before revocation, which then fences the exact lease.
    const beforeFirstAdmission = await state(1);
    await operation.query("BEGIN");
    const admitted = await admit(operation, 1);
    assert.equal(admitted.status, "ADMITTED");
    let pending = capture(revoke(change, 1));
    await waitChange();
    await operation.query("COMMIT");
    assert.equal((await pending).result.status, "REVOKED");
    const admissionState = await state(1);
    assert.equal(admissionState.contexts.length, 1);
    const admittedContext = admissionState.contexts[0];
    assert.equal(admitted.epoch, 1);
    assert.deepEqual(admittedContext, {
      user_id: uid(1),
      selected_household_id: null,
      selected_member_id: null,
      menu_household_ids: null,
      menu_phone_number_id: null,
      menu_expires_at: null,
      processing_lease_id: uid(1),
      processing_epoch: admitted.epoch,
      processing_expires_at: admittedContext.processing_expires_at,
      updated_at: admittedContext.updated_at,
      authorization_origin: "VERIFIED",
      authorization_sender: sender(1),
      authorization_link_id: uid(101),
      authorization_version: 1,
    });
    assert.ok(Number.isFinite(Date.parse(admittedContext.updated_at)));
    assert.ok(
      Date.parse(admittedContext.processing_expires_at) >
        Date.parse(admittedContext.updated_at),
    );
    revokedOnly(
      { ...beforeFirstAdmission, contexts: [admittedContext] },
      admissionState,
    );
    assert.equal(admissionState.contexts[0].authorization_link_id, uid(101));
    assert.equal(admissionState.contexts[0].authorization_version, 1);
    assert.equal(admissionState.contexts[0].authorization_origin, "VERIFIED");
    assert.equal(admissionState.contexts[0].authorization_sender, sender(1));
    assert.equal(admissionState.contexts[0].processing_lease_id, uid(1));
    assert.equal(admissionState.links[0].status, "REVOKED");
    assert.equal(admissionState.links[0].authorization_version, 2);
    assert.equal(
      await queryResult(
        operation,
        "SELECT public.fn_renew_whatsapp_context_lease($1,$1,$2) AS result",
        [uid(1), admitted.epoch],
      ),
      false,
    );
    assert.equal((await admit(operation, 1)).status, "UNAVAILABLE");
    assert.deepEqual(await state(1), admissionState);

    // Revocation wins: no context row may be created by the blocked admission.
    const beforeAdmission = await state(2);
    await change.query("BEGIN");
    await revoke(change, 2);
    pending = capture(admit(operation, 2));
    await waitOperation();
    await change.query("COMMIT");
    assert.equal((await pending).result.status, "UNAVAILABLE");
    revokedOnly(beforeAdmission, await state(2));

    // Both orders for both financial confirmation entry points.
    let n = 2;
    for (const kind of ["CREATE_INCOME", "CREATE_EXPENSE"]) {
      for (const operationFirst of [true, false]) {
        n++;
        const prepared = await prepare(n, kind);
        const before = await state(n);
        if (operationFirst) {
          await operation.query("BEGIN");
          const result = await confirm(operation, n, prepared, kind);
          assert.equal(result.status, "CREATED");
          pending = capture(revoke(change, n));
          await waitChange();
          await operation.query("COMMIT");
          assert.equal((await pending).result.status, "REVOKED");
          const after = await state(n);
          financialState(before, after, n, kind, result);
          revokedOnly(
            {
              ...before,
              proposals: after.proposals,
              incomes: after.incomes,
              expenses: after.expenses,
              distributions: after.distributions,
            },
            after,
          );
        } else {
          await change.query("BEGIN");
          await revoke(change, n);
          pending = capture(confirm(operation, n, prepared, kind));
          await waitOperation();
          await change.query("COMMIT");
          const failed = await pending;
          assert.equal(failed.error?.code, "40001");
          assert.equal(
            failed.error?.message,
            "WhatsApp context lease is no longer current",
          );
          revokedOnly(before, await state(n));
        }
        console.log(
          `PASS ${kind} authorization operationFirst=${operationFirst}, real lock wait and persisted state`,
        );
      }
    }

    // Two operations with one lease/proposal: one movement and terminal replay.
    const prepared = await prepare(7);
    const beforeDuplicate = await state(7);
    await operation.query("BEGIN");
    const result = await confirm(operation, 7, prepared, "CREATE_INCOME");
    pending = capture(confirm(change, 7, prepared, "CREATE_INCOME"));
    await waitChange();
    await operation.query("COMMIT");
    const replay = (await pending).result;
    assert.equal(replay.status, "ALREADY_COMPLETED");
    assert.equal(replay.income_id, result.income_id);
    const afterDuplicate = await state(7);
    financialState(beforeDuplicate, afterDuplicate, 7, "CREATE_INCOME", result);
    assert.deepEqual(afterDuplicate.links, beforeDuplicate.links);

    // A new verified binding never upgrades an old lease's identity/version.
    const old = await prepare(8);
    await revoke(change, 8);
    await operation.query(
      "SELECT public.fn_start_whatsapp_link_challenge($1,$2,$3,$4,$2)",
      [uid(8), uid(308), sender(8), "8".repeat(64)],
    );
    const linked = await queryResult(
      operation,
      "SELECT public.fn_complete_whatsapp_link_challenge($1,$2,$3,'authorization-relink') AS result",
      [uid(308), sender(8), "8".repeat(64)],
    );
    assert.equal(linked.status, "LINKED");
    assert.equal(
      await queryResult(
        operation,
        "SELECT public.fn_assert_whatsapp_context_lease($1,$1,$2) AS result",
        [uid(8), old.admission.epoch],
      ),
      false,
    );
    await operation.query(
      "SELECT public.fn_release_whatsapp_context_lease($1,$1,$2)",
      [uid(8), old.admission.epoch],
    );
    const fresh = await admit(operation, 8);
    assert.equal(fresh.origin, "VERIFIED");
    assert.equal(fresh.authorizationVersion, 3);
    assert.equal(fresh.linkId, linked.linkId);
    assert.ok(fresh.epoch > old.admission.epoch);
    assert.equal(
      await queryResult(
        operation,
        "SELECT public.fn_assert_whatsapp_context_lease($1,$1,$2) AS result",
        [uid(8), old.admission.epoch],
      ),
      false,
    );
    // Expiry must be checked after waiting for an identity row lock as well.
    await operation.query(
      "SELECT public.fn_release_whatsapp_context_lease($1,$1,$2)",
      [uid(9), 1],
    );
    const expiring = await admit(operation, 9);
    assert.equal(expiring.status, "ADMITTED");
    await observer.query(
      "UPDATE public.tb_whatsapp_user_contexts SET processing_expires_at=clock_timestamp()+interval '2 seconds' WHERE user_id=$1",
      [uid(9)],
    );
    const beforeExpiry = await state(9);
    await change.query("RESET ROLE");
    await change.query("BEGIN");
    await change.query(
      "SELECT id FROM public.tb_whatsapp_links WHERE user_id=$1 FOR UPDATE",
      [uid(9)],
    );
    pending = capture(
      queryResult(
        operation,
        "SELECT public.fn_renew_whatsapp_context_lease($1,$1,$2) AS result",
        [uid(9), expiring.epoch],
      ),
    );
    await waitOperation();
    await observer.query("SELECT pg_sleep(2.1)");
    await change.query("COMMIT");
    await change.query("SET ROLE service_role");
    assert.equal(
      (await pending).result,
      false,
      "an identity wait must not resurrect an expired lease",
    );
    assert.deepEqual(await state(9), beforeExpiry);
    console.log("PASS expiry during identity lock wait cannot renew a lease");
    console.log(
      "PASS atomic admission/revocation, renewal fencing, same-lease idempotence and relink version isolation",
    );
  } finally {
    await Promise.allSettled(clients.map((c) => c.query("ROLLBACK")));
    await Promise.allSettled(clients.map((c) => c.end()));
  }
};
