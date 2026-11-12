const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

// Receives only the disposable embedded PostgreSQL instance, never a remote URL.
module.exports = async function whatsappLinkingConcurrency(postgres) {
  const clients = [0, 1, 2].map(() => postgres.getPgClient("housemate_test"));
  await Promise.all(clients.map((client) => client.connect()));
  const [first, second, observer] = clients;
  const id = (n) => `43000000-0043-4000-8000-${String(n).padStart(12, "0")}`;
  const digest = (n) => n.toString(16).padStart(64, "0");
  const start = (client, user, challenge, sender, key = challenge) =>
    client
      .query(
        "SELECT public.fn_start_whatsapp_link_challenge($1,$2,$3,$4,$5) AS result",
        [id(user), id(challenge), sender, digest(challenge), id(key)],
      )
      .then(({ rows }) => rows[0].result);
  const complete = (client, challenge, sender, event) =>
    client
      .query(
        "SELECT public.fn_complete_whatsapp_link_challenge($1,$2,$3,$4) AS result",
        [id(challenge), sender, digest(challenge), event],
      )
      .then(({ rows }) => rows[0].result);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const completeEvent = (client, challenge, sender, event) =>
    client
      .query(
        "SELECT public.fn_complete_whatsapp_link_event($1,$2,'123456',$3,$4,$5) AS result",
        [event, sender, hash(`link-message:${event}`), id(challenge), digest(challenge)],
      )
      .then(({ rows }) => rows[0].result);
  const claim = (client, event, sender, eventToken) =>
    client
      .query(
        "SELECT public.fn_claim_whatsapp_event($1,$2,'123456',$3,$4) AS result",
        [event, sender, "a".repeat(64), eventToken],
      )
      .then(({ rows }) => rows[0].result);
  async function state() {
    const snapshot = {};
    for (const [key, table, order] of [
      ["links", "tb_whatsapp_links", "id"],
      ["retirements", "tb_whatsapp_legacy_identity_retirements", "user_id"],
      ["challenges", "tb_whatsapp_link_challenges", "id"],
      ["buckets", "tb_whatsapp_link_attempt_buckets", "sender_digest"],
      ["events", "tb_whatsapp_link_events", "external_event_id"],
      ["reservations", "tb_processed_whatsapp_events", "external_event_id"],
      ["contexts", "tb_whatsapp_user_contexts", "user_id"],
      ["proposals", "tb_pending_proposals", "id"],
      ["drafts", "tb_agent_category_drafts", "id"],
      ["expenses", "tb_expenses", "id"],
      ["incomes", "tb_incomes", "id"],
      ["distributions", "tb_expense_distributions", "id"],
    ]) {
      snapshot[key] = (
        await observer.query(
          `SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY ${order}`,
        )
      ).rows.map(({ row }) => row);
    }
    return snapshot;
  }
  function addedRows(before, after, newKeys, key = "id") {
    assert.deepEqual(
      after.filter((row) => !newKeys.includes(row[key])),
      before,
      "Pre-existing rows changed unexpectedly",
    );
    assert.deepEqual(
      after
        .filter((row) => newKeys.includes(row[key]))
        .map((row) => row[key])
        .sort(),
      [...newKeys].sort(),
    );
    assert.equal(after.length, before.length + newKeys.length);
  }
  function challengeTransition(before, after, challenge, expectedStatus) {
    const original = before.challenges.find((row) => row.id === id(challenge));
    const current = after.challenges.find((row) => row.id === id(challenge));
    assert.ok(original);
    assert.ok(current);
    assert.equal(current.status, expectedStatus);
    assert.deepEqual(
      {
        ...current,
        status: original.status,
        resolved_at: original.resolved_at,
      },
      original,
      "Challenge fields or attempt count changed unexpectedly",
    );
    if (expectedStatus === "CONSUMED") {
      assert.ok(current.resolved_at);
      assert.ok(
        Date.parse(current.resolved_at) < Date.parse(current.expires_at),
      );
    } else {
      assert.equal(current.resolved_at, original.resolved_at);
    }
    assert.deepEqual(
      after.challenges.filter((row) => row.id !== id(challenge)),
      before.challenges.filter((row) => row.id !== id(challenge)),
      "Another challenge was changed",
    );
  }
  function activeLink(before, after, user, sender, result) {
    const links = after.links.filter(
      (row) =>
        row.status === "ACTIVE" &&
        (row.user_id === id(user) || row.sender === sender),
    );
    assert.equal(links.length, 1);
    const link = links[0];
    assert.equal(link.id, result.linkId);
    assert.equal(link.user_id, id(user));
    assert.equal(link.sender, sender);
    assert.equal(link.status, "ACTIVE");
    assert.equal(link.authorization_version, 1);
    assert.equal(link.revoked_at, null);
    assert.ok(Number.isFinite(Date.parse(link.verified_at)));
    assert.ok(Date.parse(link.created_at) >= Date.parse(link.verified_at));
    addedRows(before.links, after.links, [result.linkId]);
  }
  function counter(before, after, sender, increment) {
    const key = hash(sender);
    const original = before.buckets.find((row) => row.sender_digest === key);
    const current = after.buckets.find((row) => row.sender_digest === key);
    assert.ok(current);
    assert.equal(current.attempts, (original?.attempts ?? 0) + increment);
    if (original)
      assert.equal(current.window_started_at, original.window_started_at);
    else assert.ok(Number.isFinite(Date.parse(current.window_started_at)));
    assert.deepEqual(
      after.buckets.filter((row) => row.sender_digest !== key),
      before.buckets.filter((row) => row.sender_digest !== key),
    );
  }
  function events(before, after, expected) {
    const eventIds = expected.map(({ event }) => event);
    addedRows(before.events, after.events, eventIds, "external_event_id");
    addedRows(
      before.reservations,
      after.reservations,
      eventIds,
      "external_event_id",
    );
    for (const { event, challenge, sender, result } of expected) {
      const entry = after.events.find((row) => row.external_event_id === event);
      assert.deepEqual(entry.result, result);
      assert.equal(
        entry.request_digest,
        hash(`${id(challenge)}:${sender}:${digest(challenge)}`),
      );
      assert.ok(Number.isFinite(Date.parse(entry.created_at)));
      const reservation = after.reservations.find(
        (row) => row.external_event_id === event,
      );
      assert.ok(reservation.id);
      assert.ok(Number.isFinite(Date.parse(reservation.processed_at)));
    }
  }
  async function blocked(client) {
    const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid;
    return async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { rows } = await observer.query(
          "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
          [pid],
        );
        if (rows[0].blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Expected PostgreSQL linking lock wait");
    };
  }
  try {
    await observer.query(`CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,email text);
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz`);
    for (let n = 1; n <= 10; n += 1) {
      await observer.query(
        "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'link-race@example.test',now())",
        [id(n)],
      );
      await observer.query(
        "INSERT INTO public.tb_users(id,auth_user_id,display_name,external_identifier) VALUES($1,$1,'Link race',$2)",
        [id(n), `supabase:${id(n)}`],
      );
    }
    await Promise.all(
      clients.map((c) => c.query("SET statement_timeout='10s'")),
    );
    await first.query("SET ROLE service_role");
    await second.query("SET ROLE service_role");
    const waitSecond = await blocked(second);

    // Concurrent new requests for one account: exactly one pending challenge.
    const beforeStart = await state();
    await first.query("BEGIN");
    const started = await start(first, 1, 11, "19990000101");
    assert.equal(started.status, "PENDING");
    let pending = start(second, 1, 12, "19990000101");
    await waitSecond();
    await first.query("COMMIT");
    assert.equal((await pending).status, "RATE_LIMITED");
    const afterStart = await state();
    addedRows(beforeStart.challenges, afterStart.challenges, [id(11)]);
    const startedRow = afterStart.challenges.find((row) => row.id === id(11));
    assert.equal(startedRow.user_id, id(1));
    assert.equal(startedRow.expected_sender, "19990000101");
    assert.equal(startedRow.code_digest, digest(11));
    assert.equal(startedRow.idempotency_key, id(11));
    assert.equal(startedRow.status, "PENDING");
    assert.equal(startedRow.attempts, 0);
    assert.equal(startedRow.resolved_at, null);
    assert.equal(
      Date.parse(startedRow.expires_at) - Date.parse(startedRow.created_at),
      600_000,
    );
    assert.equal(
      Date.parse(started.expiresAt),
      Date.parse(startedRow.expires_at),
    );
    assert.equal(started.challengeId, id(11));
    assert.equal(
      afterStart.challenges.some((row) => row.id === id(12)),
      false,
    );
    for (const key of ["links", "buckets", "events", "reservations"]) {
      assert.deepEqual(afterStart[key], beforeStart[key]);
    }

    // Two completions of one challenge (including event redelivery).
    for (const sameEvent of [false, true]) {
      const user = sameEvent ? 3 : 2;
      const challenge = sameEvent ? 13 : 14;
      const sender = sameEvent ? "19990000103" : "19990000102";
      await start(first, user, challenge, sender);
      if (sameEvent) await start(first, 8, 19, "19990000108");
      const beforeVerify = await state();
      await first.query("BEGIN");
      const winner = await complete(
        first,
        challenge,
        sender,
        `race-${challenge}`,
      );
      pending = complete(
        second,
        challenge,
        sender,
        sameEvent ? `race-${challenge}` : `race-${challenge}-other`,
      );
      await waitSecond();
      await first.query("COMMIT");
      const loser = await pending;
      if (sameEvent) assert.deepEqual(loser, winner);
      else assert.equal(loser.status, "INVALID");
      assert.equal(winner.status, "LINKED");
      const afterVerify = await state();
      activeLink(beforeVerify, afterVerify, user, sender, winner);
      challengeTransition(beforeVerify, afterVerify, challenge, "CONSUMED");
      assert.equal(
        afterVerify.links.find((row) => row.id === winner.linkId).verified_at,
        afterVerify.challenges.find((row) => row.id === id(challenge))
          .resolved_at,
      );
      counter(beforeVerify, afterVerify, sender, sameEvent ? 1 : 2);
      const expectedEvents = [
        { event: `race-${challenge}`, challenge, sender, result: winner },
      ];
      if (!sameEvent)
        expectedEvents.push({
          event: `race-${challenge}-other`,
          challenge,
          sender,
          result: loser,
        });
      events(beforeVerify, afterVerify, expectedEvents);
      // Replay after both concurrent requests must leave every persisted row intact,
      // including another user's pending challenge and all counters/reservations.
      assert.deepEqual(
        await complete(second, challenge, sender, `race-${challenge}`),
        winner,
      );
      assert.deepEqual(await state(), afterVerify);
    }

    // Distinct users may request one sender, but only one can activate it.
    await start(first, 4, 15, "19990000104");
    await start(second, 5, 16, "19990000104");
    const beforeCompetition = await state();
    await first.query("BEGIN");
    const senderWinner = await complete(
      first,
      15,
      "19990000104",
      "race-sender-first",
    );
    assert.equal(senderWinner.status, "LINKED");
    pending = complete(second, 16, "19990000104", "race-sender-second");
    await waitSecond();
    await first.query("COMMIT");
    const senderLoser = await pending;
    assert.equal(senderLoser.status, "UNAVAILABLE");
    const afterCompetition = await state();
    activeLink(
      beforeCompetition,
      afterCompetition,
      4,
      "19990000104",
      senderWinner,
    );
    challengeTransition(beforeCompetition, afterCompetition, 15, "CONSUMED");
    assert.deepEqual(
      afterCompetition.challenges.find((row) => row.id === id(16)),
      beforeCompetition.challenges.find((row) => row.id === id(16)),
      "UNAVAILABLE must preserve the losing challenge, including PENDING status",
    );
    assert.equal(
      afterCompetition.challenges.find((row) => row.id === id(16)).status,
      "PENDING",
    );
    assert.equal(
      afterCompetition.links.some((row) => row.user_id === id(5)),
      false,
    );
    counter(beforeCompetition, afterCompetition, "19990000104", 2);
    events(beforeCompetition, afterCompetition, [
      {
        event: "race-sender-first",
        challenge: 15,
        sender: "19990000104",
        result: senderWinner,
      },
      {
        event: "race-sender-second",
        challenge: 16,
        sender: "19990000104",
        result: senderLoser,
      },
    ]);
    assert.deepEqual(
      await complete(second, 16, "19990000104", "race-sender-second"),
      senderLoser,
    );
    assert.deepEqual(await state(), afterCompetition);

    // A database failure must roll back event reservation and challenge consumption.
    await start(first, 6, 17, "19990000106");
    const beforeFailure = await state();
    await observer.query(`CREATE FUNCTION public.link_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected local linking failure' USING ERRCODE='P0001'; END; $$;
      CREATE TRIGGER link_test_fail BEFORE INSERT ON public.tb_whatsapp_links
      FOR EACH ROW EXECUTE FUNCTION public.link_test_fail()`);
    await assert.rejects(
      complete(first, 17, "19990000106", "race-retry"),
      (error) =>
        error.code === "P0001" &&
        error.message === "Injected local linking failure",
    );
    assert.deepEqual(await state(), beforeFailure);
    assert.equal(
      Number(
        (
          await observer.query(
            "SELECT count(*) AS n FROM public.tb_processed_whatsapp_events WHERE external_event_id='race-retry'",
          )
        ).rows[0].n,
      ),
      0,
    );
    await observer.query(
      "DROP TRIGGER link_test_fail ON public.tb_whatsapp_links; DROP FUNCTION public.link_test_fail()",
    );
    const retried = await complete(first, 17, "19990000106", "race-retry");
    assert.equal(retried.status, "LINKED");
    const afterRetry = await state();
    activeLink(beforeFailure, afterRetry, 6, "19990000106", retried);
    challengeTransition(beforeFailure, afterRetry, 17, "CONSUMED");
    counter(beforeFailure, afterRetry, "19990000106", 1);
    events(beforeFailure, afterRetry, [
      {
        event: "race-retry",
        challenge: 17,
        sender: "19990000106",
        result: retried,
      },
    ]);

    // Rolling back the first verifier lets the blocked verifier win once.
    await start(first, 7, 18, "19990000107");
    const beforeRollback = await state();
    await first.query("BEGIN");
    const rolledBack = await complete(
      first,
      18,
      "19990000107",
      "race-rollback",
    );
    pending = complete(second, 18, "19990000107", "race-rollback");
    await waitSecond();
    await first.query("ROLLBACK");
    const rollbackWinner = await pending;
    assert.equal(rollbackWinner.status, "LINKED");
    assert.notEqual(rollbackWinner.linkId, rolledBack.linkId);
    const afterRollback = await state();
    activeLink(beforeRollback, afterRollback, 7, "19990000107", rollbackWinner);
    challengeTransition(beforeRollback, afterRollback, 18, "CONSUMED");
    counter(beforeRollback, afterRollback, "19990000107", 1);
    events(beforeRollback, afterRollback, [
      {
        event: "race-rollback",
        challenge: 18,
        sender: "19990000107",
        result: rollbackWinner,
      },
    ]);

    const { rows } = await observer.query(
      `SELECT
      (SELECT count(*) FROM public.tb_whatsapp_link_challenges WHERE user_id=$1 AND status='PENDING') AS pending,
      (SELECT count(*) FROM public.tb_whatsapp_links WHERE sender='19990000104' AND status='ACTIVE') AS active`,
      [id(1)],
    );
    assert.equal(Number(rows[0].pending), 1);
    assert.equal(Number(rows[0].active), 1);
    const finalState = await state();
    for (const key of [
      "contexts",
      "proposals",
      "drafts",
      "expenses",
      "incomes",
      "distributions",
    ]) {
      assert.deepEqual(
        finalState[key],
        beforeStart[key],
        "Linking must preserve contextual and financial rows",
      );
    }
    // Activation holds the same gate until COMMIT; revocation waits and then wins.
    const beforeActivation = await state();
    await first.query("BEGIN");
    const activated = await complete(
      first,
      11,
      "19990000101",
      "race-activate-revoke",
    );
    assert.equal(activated.status, "LINKED");
    pending = second.query(
      "SELECT public.fn_revoke_whatsapp_link($1,$2,1) AS result",
      [id(1), activated.linkId],
    );
    await waitSecond();
    await first.query("COMMIT");
    assert.equal((await pending).rows[0].result.status, "REVOKED");
    const afterActivation = await state();
    const revoked = afterActivation.links.find(
      (row) => row.id === activated.linkId,
    );
    assert.equal(revoked.status, "REVOKED");
    assert.equal(revoked.authorization_version, 2);
    assert.ok(revoked.revoked_at);
    activeLink(
      beforeActivation,
      {
        ...afterActivation,
        links: afterActivation.links.map((row) =>
          row.id === activated.linkId
            ? {
                ...row,
                status: "ACTIVE",
                authorization_version: 1,
                revoked_at: null,
              }
            : row,
        ),
      },
      1,
      "19990000101",
      activated,
    );
    challengeTransition(beforeActivation, afterActivation, 11, "CONSUMED");
    counter(beforeActivation, afterActivation, "19990000101", 1);
    events(beforeActivation, afterActivation, [
      {
        event: "race-activate-revoke",
        challenge: 11,
        sender: "19990000101",
        result: activated,
      },
    ]);
    assert.deepEqual(
      await complete(second, 11, "19990000101", "race-activate-revoke"),
      activated,
    );
    assert.deepEqual(
      await state(),
      afterActivation,
      "Historical LINKED replay must not restore a revoked link",
    );
    for (const key of [
      "contexts",
      "proposals",
      "drafts",
      "expenses",
      "incomes",
      "distributions",
    ])
      assert.deepEqual(afterActivation[key], beforeActivation[key]);

    // A claim that linearizes before verification records LEGACY, but the lease
    // must fail its next SQL authorization check after P is permanently retired.
    const legacyP9 = "19990000109";
    const verifiedQ9 = "19990000119";
    const beforeLegacyClaim = await state();
    await observer.query(
      "UPDATE public.tb_users SET external_identifier=$2 WHERE id=$1",
      [id(9), legacyP9],
    );
    assert.equal((await start(first, 9, 91, verifiedQ9)).status, "PENDING");
    const preTransitionEvent = "legacy-transition-claim-before-link";
    const preTransitionToken = id(901);
    await first.query("BEGIN");
    const legacyClaim = await claim(
      first,
      preTransitionEvent,
      legacyP9,
      preTransitionToken,
    );
    assert.equal(legacyClaim.status, "CLAIMED");
    assert.equal(legacyClaim.userId, id(9));
    const linkingAfterClaim = completeEvent(
      second,
      91,
      verifiedQ9,
      "legacy-transition-link-after-claim",
    );
    await waitSecond();
    await first.query("COMMIT");
    assert.equal((await linkingAfterClaim).status, "READY");
    const claimedReceipt = (
      await observer.query(
        "SELECT identity_snapshot, processing_state FROM public.tb_whatsapp_event_receipts WHERE external_event_id=$1",
        [preTransitionEvent],
      )
    ).rows[0];
    assert.equal(claimedReceipt.identity_snapshot.origin, "LEGACY");
    assert.equal(claimedReceipt.processing_state, "RESERVED");
    assert.equal(
      (
        await observer.query(
          "SELECT public.fn_resolve_whatsapp_sender($1) AS result",
          [legacyP9],
        )
      ).rows[0].result.status,
      "UNAVAILABLE",
    );
    await assert.rejects(
      first.query(
        "SELECT public.fn_assert_whatsapp_event($1,$2,$3)",
        [preTransitionEvent, preTransitionToken, legacyClaim.epoch],
      ),
      (error) => error.code === "40001",
    );
    assert.equal(
      (
        await observer.query(
          "SELECT count(*) AS n FROM public.tb_whatsapp_legacy_identity_retirements WHERE user_id=$1",
          [id(9)],
        )
      ).rows[0].n,
      "1",
    );
    const linkReplay = await completeEvent(
      second,
      91,
      verifiedQ9,
      "legacy-transition-link-after-claim",
    );
    assert.equal(linkReplay.status, "READY");
    assert.equal(
      (
        await observer.query(
          "SELECT count(*) AS n FROM public.tb_whatsapp_links WHERE user_id=$1 AND sender=$2",
          [id(9), verifiedQ9],
        )
      ).rows[0].n,
      "1",
      "Link-event redelivery must not create a second verified link",
    );
    assert.notDeepEqual(
      await state(),
      beforeLegacyClaim,
      "The successful claim/link transition should persist its receipt, link and retirement marker",
    );

    // If finalization obtains the gate first, a waiting claim on P sees the
    // committed retirement marker rather than admitting a fresh LEGACY lease.
    const legacyP10 = "19990000110";
    const verifiedQ10 = "19990000120";
    await observer.query(
      "UPDATE public.tb_users SET external_identifier=$2 WHERE id=$1",
      [id(10), legacyP10],
    );
    assert.equal((await start(first, 10, 92, verifiedQ10)).status, "PENDING");
    await first.query("BEGIN");
    assert.equal(
      (
        await completeEvent(
          first,
          92,
          verifiedQ10,
          "legacy-transition-link-before-claim",
        )
      ).status,
      "READY",
    );
    const waitingLegacyClaim = claim(
      second,
      "legacy-transition-claim-after-link",
      legacyP10,
      id(902),
    );
    await waitSecond();
    await first.query("COMMIT");
    assert.equal((await waitingLegacyClaim).status, "UNAVAILABLE");
    assert.equal(
      Number(
        (
          await observer.query(
            "SELECT count(*) AS n FROM public.tb_whatsapp_event_receipts WHERE external_event_id='legacy-transition-claim-after-link'",
          )
        ).rows[0].n,
      ),
      0,
      "A blocked claim must not reserve a receipt after retirement commits",
    );

    // Revocation and claim use the same transaction gate. A claim waiting on Q
    // must observe revocation; P remains retired independently of Q's status.
    const q9State = await first.query(
      "SELECT public.fn_get_whatsapp_link_state($1) AS result",
      [id(9)],
    );
    const q9LinkId = q9State.rows[0].result.link.id;
    await first.query("BEGIN");
    assert.equal(
      (
        await first.query(
          "SELECT public.fn_revoke_whatsapp_link($1,$2,1) AS result",
          [id(9), q9LinkId],
        )
      ).rows[0].result.status,
      "REVOKED",
    );
    const waitingRevokedClaim = claim(
      second,
      "legacy-transition-claim-after-revoke",
      verifiedQ9,
      id(903),
    );
    await waitSecond();
    await first.query("COMMIT");
    assert.equal((await waitingRevokedClaim).status, "UNAVAILABLE");
    assert.equal(
      (
        await observer.query(
          "SELECT public.fn_resolve_whatsapp_sender($1) AS result",
          [legacyP9],
        )
      ).rows[0].result.status,
      "UNAVAILABLE",
    );
    assert.equal(
      (
        await observer.query(
          "SELECT public.fn_resolve_whatsapp_sender($1) AS result",
          [verifiedQ9],
        )
      ).rows[0].result.status,
      "UNAVAILABLE",
    );
    console.log(
      "PASS WhatsApp linking real-session races, legacy retirement, event replay, rollback and database retry",
    );
  } finally {
    await Promise.allSettled(clients.map((client) => client.query("ROLLBACK")));
    await Promise.allSettled(clients.map((client) => client.end()));
  }
};
