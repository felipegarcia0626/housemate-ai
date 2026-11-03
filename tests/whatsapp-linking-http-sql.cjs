const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const {
  loadBackend,
  request,
  read,
  eligible,
} = require("./phase-4-whatsapp-linking-http-functional.cjs");

// Receives only the runner's disposable local database, never a connection URL.
module.exports = async function linkingHttpSql(postgres) {
  const admin = postgres.getPgClient("housemate_test"),
    backend = postgres.getPgClient("housemate_test");
  await Promise.all([admin.connect(), backend.connect()]);
  const a = "46000000-0000-4000-8000-000000000001",
    b = "46000000-0000-4000-8000-000000000002";
  let current = eligible(a);
  let dropCreationResponse = false;
  try {
    await admin.query(`
      DO $$
      BEGIN
        IF to_regclass('auth.users') IS NULL THEN
          IF to_regnamespace('auth') IS NULL THEN
            EXECUTE 'CREATE SCHEMA auth';
          END IF;
          EXECUTE 'CREATE TABLE auth.users (
            id UUID PRIMARY KEY,
            email TEXT,
            email_confirmed_at TIMESTAMPTZ
          )';
        END IF;
      END
      $$
    `);
    for (const id of [a, b]) {
      await admin.query(
        "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'http-linking@example.test',now())",
        [id],
      );
      await admin.query(
        "INSERT INTO public.tb_users(id,auth_user_id,external_identifier,display_name) VALUES($1,$1,$2,'HTTP linking fixture')",
        [id, `supabase:${id}`],
      );
    }
    await backend.query("SET ROLE service_role");
    const rpc = async (name, args) => {
      assert.ok(
        [
          "fn_get_whatsapp_link_state",
          "fn_start_whatsapp_link_challenge",
          "fn_cancel_whatsapp_link_challenge",
        ].includes(name),
      );
      const keys = Object.keys(args);
      try {
        const { rows } = await backend.query(
          `SELECT public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}`).join(",")}) AS result`,
          Object.values(args),
        );
        if (
          dropCreationResponse &&
          name === "fn_start_whatsapp_link_challenge"
        ) {
          dropCreationResponse = false;
          throw new Error("Synthetic response lost after SQL COMMIT");
        }
        return { data: rows[0].result, error: null };
      } catch (error) {
        return {
          data: null,
          error: { code: error.code, message: error.message },
        };
      }
    };
    const { route } = loadBackend(rpc, () => current);
    const key = randomUUID(),
      input = { phoneNumber: "+1 (999) 000-0501", idempotencyKey: key };
    const created = (await read(await route.POST(request("POST", input)), 201))
      .data;
    const secret = created.verificationMessage.split(" ").at(-1);
    const persisted = (
      await admin.query(
        "SELECT * FROM public.tb_whatsapp_link_challenges WHERE id=$1",
        [key],
      )
    ).rows[0];
    assert.equal(persisted.user_id, a);
    assert.equal(
      persisted.code_digest,
      createHash("sha256").update(secret).digest("hex"),
    );
    assert.equal(persisted.expected_sender, "19990000501");
    assert.ok(!JSON.stringify(persisted).includes(secret));
    // Lost HTTP response: retry cannot disclose a new secret or alter persistence.
    assert.equal(
      (await read(await route.POST(request("POST", input)), 409)).data.status,
      "RESTART_REQUIRED",
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT * FROM public.tb_whatsapp_link_challenges WHERE id=$1",
          [key],
        )
      ).rows[0],
      persisted,
    );
    current = eligible(b);
    assert.equal((await read(await route.GET(), 200)).data.challenge, null);
    assert.equal(
      (await read(await route.POST(request("POST", input)), 409)).data.status,
      "UNAVAILABLE",
    );
    await read(
      await route.DELETE(request("DELETE", { challengeId: key })),
      404,
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT * FROM public.tb_whatsapp_link_challenges WHERE id=$1",
          [key],
        )
      ).rows[0],
      persisted,
    );
    const lostKey = randomUUID(),
      lostInput = { phoneNumber: "+19990000502", idempotencyKey: lostKey };
    dropCreationResponse = true;
    const lost = await read(await route.POST(request("POST", lostInput)), 503);
    assert.equal(lost.error.code, "CHALLENGE_OUTCOME_UNKNOWN");
    const lostRow = (
      await admin.query(
        "SELECT * FROM public.tb_whatsapp_link_challenges WHERE id=$1",
        [lostKey],
      )
    ).rows[0];
    assert.equal(lostRow.status, "PENDING");
    assert.equal(lostRow.user_id, b);
    assert.equal(
      (await read(await route.POST(request("POST", lostInput)), 409)).data
        .status,
      "RESTART_REQUIRED",
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT * FROM public.tb_whatsapp_link_challenges WHERE id=$1",
          [lostKey],
        )
      ).rows[0],
      lostRow,
    );
    current = eligible(a);
    assert.equal(
      (
        await read(
          await route.DELETE(request("DELETE", { challengeId: key })),
          200,
        )
      ).data.status,
      "CANCELLED",
    );
    await read(
      await route.DELETE(request("DELETE", { challengeId: key })),
      200,
    );
    const next = randomUUID();
    assert.equal(
      (
        await read(
          await route.POST(request("POST", { ...input, idempotencyKey: next })),
          429,
        )
      ).data.status,
      "RATE_LIMITED",
    );
    await admin.query(
      "UPDATE public.tb_whatsapp_link_challenges SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE id=$1",
      [key],
    );
    await read(
      await route.POST(request("POST", { ...input, idempotencyKey: next })),
      201,
    );
    await admin.query(
      "UPDATE public.tb_whatsapp_link_challenges SET created_at=created_at-interval '20 minutes',expires_at=expires_at-interval '20 minutes' WHERE id=$1",
      [key],
    );
    await admin.query(
      "UPDATE public.tb_whatsapp_link_challenges SET created_at=created_at-interval '11 minutes',expires_at=expires_at-interval '11 minutes' WHERE id=$1",
      [next],
    );
    const beforeExpiry = (
      await admin.query(
        "SELECT * FROM public.tb_whatsapp_link_challenges WHERE id=$1",
        [next],
      )
    ).rows[0];
    assert.equal(
      (await read(await route.GET(), 200)).data.challenge.status,
      "EXPIRED",
    );
    assert.equal(
      (
        await read(
          await route.POST(request("POST", { ...input, idempotencyKey: next })),
          409,
        )
      ).data.status,
      "RESTART_REQUIRED",
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT * FROM public.tb_whatsapp_link_challenges WHERE id=$1",
          [next],
        )
      ).rows[0],
      beforeExpiry,
    );
    assert.equal(
      (
        await read(
          await route.DELETE(request("DELETE", { challengeId: next })),
          200,
        )
      ).data.status,
      "EXPIRED",
    );
    await admin.query(
      "UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1",
      [a],
    );
    // Even a stale authenticated identity cannot bypass SQL's current Auth check.
    await read(await route.GET(), 403);
    await read(
      await route.POST(
        request("POST", { ...input, idempotencyKey: randomUUID() }),
      ),
      403,
    );
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*) AS n FROM public.tb_whatsapp_link_challenges WHERE user_id=$1",
            [a],
          )
        ).rows[0].n,
      ),
      2,
    );
    assert.equal(
      Number(
        (
          await admin.query(
            "SELECT count(*) AS n FROM public.tb_whatsapp_links WHERE user_id IN ($1,$2)",
            [a, b],
          )
        ).rows[0].n,
      ),
      0,
    );
    console.log(
      "PASS HTTP to real SQL linking: digest-only persistence, lost response, ownership, limits, expiry, cancellation and current Auth",
    );
  } finally {
    await Promise.allSettled([admin.end(), backend.end()]);
  }
};
