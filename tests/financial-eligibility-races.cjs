const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// Receives only the disposable database created by run-sql-tests.cjs.
module.exports = async function eligibilityRaces(postgres) {
  const clients = [0, 1, 2].map(() => postgres.getPgClient("housemate_test"));
  await Promise.all(clients.map((c) => c.connect()));
  const [financial, change, inspect] = clients;
  const auth = "42000000-0042-4000-8000-000000000001";
  const ownerAuth = "42000000-0042-4000-8000-000000000002";
  const household = "00000000-0000-4000-8000-000000000001";
  const user = "00000000-0000-4000-8000-000000000011";
  const member = "00000000-0000-4000-8000-000000000021";
  const owner = "00000000-0000-4000-8000-000000000022";
  const guard =
    "SELECT public.fn_require_financial_eligibility('" +
    auth +
    "','" +
    household +
    "','" +
    member +
    "')";
  const write =
    "SELECT public.fn_create_income_eligible('" +
    auth +
    "','" +
    member +
    "','" +
    household +
    "','" +
    member +
    "',42,current_date,'Eligibility race',NULL)";
  const capture = (promise) =>
    promise.then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
  const count = async (movement = "income") =>
    Number(
      (
        await inspect.query(
          "SELECT count(*) AS n FROM public.tb_" +
            (movement === "income" ? "incomes" : "expenses"),
        )
      ).rows[0].n,
    );
  async function reset() {
    // Lifecycle RPCs deduplicate notifications per membership; isolate each race.
    await inspect.query(
      "DELETE FROM public.tb_notifications WHERE source_entity_id=$1 AND deduplication_key IN ($2,$3)",
      [
        member,
        "membership:" + member + ":left",
        "membership:" + member + ":removed",
      ],
    );
    await inspect.query(
      "UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1",
      [auth],
    );
    await inspect.query(
      "UPDATE public.tb_users SET auth_user_id=$1 WHERE id=$2",
      [auth, user],
    );
    await inspect.query(
      "UPDATE public.tb_household_members SET status='ACTIVE',role='MEMBER' WHERE id=$1",
      [member],
    );
    await inspect.query(
      "UPDATE public.tb_household_members SET role='OWNER' WHERE id=$1",
      [owner],
    );
  }
  async function blocked(pid) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (
        (
          await inspect.query(
            "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
            [pid],
          )
        ).rows[0].blocked
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error("Expected real PostgreSQL lock wait");
  }
  function denied(error) {
    assert.equal(error?.code, "42501");
    assert.equal(error?.detail, "HOUSEMATE_FINANCIAL_ELIGIBILITY_V1");
  }
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "../database/migrations/0042_financial_eligibility.sql",
    ),
    "utf8",
  );
  const current = migration
    .match(
      /CREATE FUNCTION public.fn_require_financial_eligibility[\s\S]*?\$\$;/,
    )[0]
    .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
  const previous = current.replace(
    /  -- Household precedes[\s\S]*?(?=  SELECT id INTO v_user_id)/,
    "",
  );
  assert.notEqual(previous, current);
  try {
    await Promise.all(
      clients.map((c) => c.query("SET statement_timeout='8s'")),
    );
    const fp = (await financial.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    const cp = (await change.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    await inspect.query("INSERT INTO auth.users VALUES($1,$2,now())", [
      ownerAuth,
      "owner@example.test",
    ]);
    await inspect.query(
      "UPDATE public.tb_users SET auth_user_id=$1 WHERE id=$2",
      [ownerAuth, "00000000-0000-4000-8000-000000000012"],
    );
    const leave =
      "SELECT public.fn_leave_household('" + auth + "','" + household + "')";
    const remove =
      "SELECT public.fn_remove_household_member('" +
      ownerAuth +
      "','" +
      household +
      "','" +
      member +
      "')";
    await reset();
    const before = await count();
    // Install the former helper only in the isolated database, then restore it.
    await inspect.query(previous);
    try {
      await financial.query("BEGIN");
      await financial.query(guard);
      await change.query("BEGIN; SET LOCAL ROLE service_role");
      const leaving = capture(change.query(leave));
      await blocked(cp);
      const writing = capture(financial.query(write));
      const results = await Promise.all([leaving, writing]);
      assert.ok(
        results.some((r) => r.error?.code === "40P01"),
        "Former order must deadlock",
      );
      assert.ok(
        results.every((r) => !r.error || r.error.code === "40P01"),
        "Reject unrelated SQL errors",
      );
    } finally {
      await financial.query("ROLLBACK");
      await change.query("ROLLBACK");
      await inspect.query(current);
    }
    assert.equal(await count(), before);
    assert.equal(
      (
        await inspect.query(
          "SELECT status FROM public.tb_household_members WHERE id=$1",
          [member],
        )
      ).rows[0].status,
      "ACTIVE",
    );
    console.log(
      "PASS former guard reproduces 40P01 with actual leave RPC and FK; rollback preserves state",
    );

    for (const [label, mutation, lifecycle] of [
      ["leave", leave, true],
      ["remove", remove, true],
      [
        "membership",
        "UPDATE public.tb_household_members SET status='LEFT' WHERE id='" +
          member +
          "'",
        false,
      ],
      [
        "Auth linkage",
        "UPDATE public.tb_users SET auth_user_id=NULL WHERE id='" + user + "'",
        false,
      ],
    ]) {
      for (const first of [true, false]) {
        await reset();
        const initial = await count();
        await financial.query("BEGIN");
        await change.query(
          lifecycle ? "BEGIN; SET LOCAL ROLE service_role" : "BEGIN",
        );
        if (first) {
          // Stop at the production guard boundary to interleave the actual RPC.
          await financial.query(guard);
          const pending = capture(change.query(mutation));
          await blocked(cp);
          await financial.query("SET LOCAL ROLE service_role");
          await financial.query(write);
          await financial.query("COMMIT");
          assert.equal((await pending).error, undefined);
          await change.query("COMMIT");
        } else {
          await change.query(mutation);
          await financial.query("SET LOCAL ROLE service_role");
          const pending = capture(financial.query(write));
          await blocked(fp);
          await change.query("COMMIT");
          denied((await pending).error);
          await financial.query("ROLLBACK");
        }
        assert.equal((await count()) - initial, first ? 1 : 0);
        if (label === "Auth linkage")
          assert.equal(
            (
              await inspect.query(
                "SELECT auth_user_id FROM public.tb_users WHERE id=$1",
                [user],
              )
            ).rows[0].auth_user_id,
            null,
          );
        else
          assert.equal(
            (
              await inspect.query(
                "SELECT status FROM public.tb_household_members WHERE id=$1",
                [member],
              )
            ).rows[0].status,
            label === "remove" ? "REMOVED" : "LEFT",
          );
        console.log(
          "PASS " +
            label +
            " financialFirst=" +
            first +
            "; both transactions and exact persisted state",
        );
      }
    }
    for (const movement of ["income", "expense"]) {
      for (const first of [true, false]) {
        await reset();
        const id = randomUUID();
        const conversation = "eligibility-race-" + id;
        await inspect.query(
          "INSERT INTO public.tb_pending_proposals(id,household_id,conversation_key,operation_type,payload,status) VALUES($1,$2,$5,$3,$4,'AWAITING_CONFIRMATION')",
          [
            id,
            household,
            "CREATE_" + movement.toUpperCase(),
            JSON.stringify({ actorMemberId: member, source: "WEB" }),
            conversation,
          ],
        );
        // Preserve timestamp microseconds rather than round-tripping through Date.
        const version = (
          await inspect.query(
            "SELECT updated_at::text AS version FROM public.tb_pending_proposals WHERE id=$1",
            [id],
          )
        ).rows[0].version;
        const args =
          movement === "income"
            ? "p_member_id=>'" +
              member +
              "',p_amount=>42,p_income_date=>current_date,p_description=>'Eligibility race'"
            : "p_paid_by=>'" +
              member +
              "',p_total_amount=>42,p_expense_date=>current_date,p_source=>'WEB',p_items=>'[]',p_distributions=>'" +
              JSON.stringify([
                { householdMemberId: member, amount: 42, percentage: 100 },
              ]) +
              "'";
        const confirm =
          "SELECT public.fn_confirm_pending_" +
          movement +
          "_eligible(p_auth_user_id=>'" +
          auth +
          "',p_proposal_id=>'" +
          id +
          "',p_household_id=>'" +
          household +
          "',p_conversation_key=>'" +
          conversation +
          "',p_actor_member_id=>'" +
          member +
          "',p_context_source=>'WEB',p_expected_updated_at=>$1,p_created_by=>'" +
          member +
          "'," +
          args +
          ") AS result";
        const initial = await count(movement);
        await financial.query("BEGIN; SET LOCAL ROLE service_role");
        await change.query("BEGIN");
        const revoke =
          "UPDATE auth.users SET email_confirmed_at=NULL WHERE id='" +
          auth +
          "'";
        if (first) {
          assert.equal(
            (await financial.query(confirm, [version])).rows[0].result.status,
            "CREATED",
          );
          const pending = capture(change.query(revoke));
          await blocked(cp);
          await financial.query("COMMIT");
          assert.equal((await pending).error, undefined);
          await change.query("COMMIT");
        } else {
          await change.query(revoke);
          const pending = capture(financial.query(confirm, [version]));
          await blocked(fp);
          await change.query("COMMIT");
          denied((await pending).error);
          await financial.query("ROLLBACK");
        }
        const proposal = (
          await inspect.query(
            "SELECT status,expense_id,income_id FROM public.tb_pending_proposals WHERE id=$1",
            [id],
          )
        ).rows[0];
        assert.equal(
          proposal.status,
          first ? "COMPLETED" : "AWAITING_CONFIRMATION",
        );
        assert.equal(proposal[movement + "_id"] !== null, first);
        assert.equal((await count(movement)) - initial, first ? 1 : 0);
        console.log(
          "PASS " +
            movement +
            " confirmation financialFirst=" +
            first +
            "; proposal/reference and exact row delta",
        );
      }
    }
  } finally {
    await Promise.allSettled(clients.map((c) => c.query("ROLLBACK")));
    await Promise.allSettled(clients.map((c) => c.end()));
  }
};
