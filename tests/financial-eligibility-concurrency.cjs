const assert = require("node:assert/strict");

// Invoked only by the isolated embedded-PostgreSQL runner; no connection URL.
module.exports = async function financialEligibilityConcurrency(postgres) {
  const clients = [0, 1, 2].map(() => postgres.getPgClient("housemate_test"));
  await Promise.all(clients.map((client) => client.connect()));
  const [operation, change, observer] = clients;
  const auth = "42000000-0042-4000-8000-000000000001";
  const write = `SELECT public.fn_create_income_eligible('${auth}',
    '00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000021',42,current_date,'Eligibility concurrency',NULL)`;
  async function waitBlocked(pid) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await observer.query(
        "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
        [pid],
      );
      if (result.rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Expected a real PostgreSQL lock wait");
  }
  try {
    await observer.query(`CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,email text);
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
      INSERT INTO auth.users VALUES('${auth}','eligible@example.test',now());
      UPDATE public.tb_users SET auth_user_id='${auth}' WHERE id='00000000-0000-4000-8000-000000000011'`);
    await Promise.all(
      clients.map((client) => client.query("SET statement_timeout='8s'")),
    );
    const opPid = (await operation.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;
    const changePid = (await change.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid;

    // Financial authorization wins: Auth modification waits until commit/rollback.
    for (const finish of ["COMMIT", "ROLLBACK"]) {
      await observer.query(
        `UPDATE auth.users SET email_confirmed_at=now() WHERE id='${auth}'`,
      );
      const before = Number(
        (await observer.query("SELECT count(*) AS n FROM public.tb_incomes"))
          .rows[0].n,
      );
      await operation.query("BEGIN; SET LOCAL ROLE service_role");
      await operation.query(write);
      await change.query("BEGIN");
      const pending = change.query(
        `UPDATE auth.users SET email_confirmed_at=NULL WHERE id='${auth}'`,
      );
      await waitBlocked(changePid);
      await operation.query(finish);
      await pending;
      await change.query("COMMIT");
      const after = Number(
        (await observer.query("SELECT count(*) AS n FROM public.tb_incomes"))
          .rows[0].n,
      );
      assert.equal(after - before, finish === "COMMIT" ? 1 : 0);
      console.log(
        `PASS financial-first Auth lock wait, ${finish}, exact financial row delta`,
      );
    }

    // Auth modification wins: commit rejects; rollback restores eligibility.
    for (const finish of ["COMMIT", "ROLLBACK"]) {
      await observer.query(
        `UPDATE auth.users SET email_confirmed_at=now() WHERE id='${auth}'`,
      );
      const before = Number(
        (await observer.query("SELECT count(*) AS n FROM public.tb_incomes"))
          .rows[0].n,
      );
      await change.query("BEGIN");
      await change.query(
        `UPDATE auth.users SET email_confirmed_at=NULL WHERE id='${auth}'`,
      );
      await operation.query("BEGIN; SET LOCAL ROLE service_role");
      const pending = operation.query(write).then(
        () => null,
        (error) => error,
      );
      await waitBlocked(opPid);
      await change.query(finish);
      const error = await pending;
      if (finish === "COMMIT") {
        assert.equal(error?.code, "42501");
        assert.equal(error.message, "Financial access is unavailable");
        await operation.query("ROLLBACK");
      } else {
        assert.equal(error, null);
        await operation.query("COMMIT");
      }
      const after = Number(
        (await observer.query("SELECT count(*) AS n FROM public.tb_incomes"))
          .rows[0].n,
      );
      assert.equal(after - before, finish === "COMMIT" ? 0 : 1);
      console.log(
        `PASS Auth-first real lock wait, ${finish}, denial/rollback behavior`,
      );
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.query("ROLLBACK")));
    await Promise.allSettled(clients.map((client) => client.end()));
  }
};
