const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");

// Runs only through run-sql-tests.cjs against its disposable embedded PostgreSQL.
module.exports = async function whatsappAdmissionBarrier(postgres) {
  const [first, second, admin, inspect] = [0, 1, 2, 3].map(() =>
    postgres.getPgClient("housemate_test"),
  );
  await Promise.all([first, second, admin, inspect].map((client) => client.connect()));

  const userId = randomUUID();
  const authId = userId;
  const legacyUserId = randomUUID();
  const legacyAuthId = legacyUserId;
  const linkTargetId = randomUUID();
  const linkTargetAuthId = linkTargetId;
  const householdId = randomUUID();
  const linkId = randomUUID();
  const verifiedSender = `199955${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;
  const legacySender = `188855${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;
  const linkSender = `177755${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;
  const linkChallengeId = randomUUID();
  const linkIdempotencyKey = randomUUID();
  const linkCodeDigest = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const linkSenderDigest = createHash("sha256").update(linkSender).digest("hex");
  const prefix = `admission-barrier-${randomUUID()}`;
  const eventIds = new Set();
  const event = (suffix) => {
    const value = `${prefix}-${suffix}`;
    eventIds.add(value);
    return value;
  };
  const token = () => randomUUID();
  const json = async (client, sql, args = []) =>
    (await client.query(sql, args)).rows[0].result;
  const claim = (client, eventId, currentToken = token()) =>
    json(
      client,
      "SELECT public.fn_claim_whatsapp_event($1,$2,'123456',$3,$4) AS result",
      [eventId, verifiedSender, "a".repeat(64), currentToken],
    );
  const begin = (client, eventId, eventToken, epoch = 1) =>
    json(
      client,
      "SELECT public.fn_begin_whatsapp_event($1,$2,$3) AS result",
      [eventId, eventToken, epoch],
    );
  const pid = async (client) =>
    (await client.query("SELECT pg_catalog.pg_backend_pid() AS pid")).rows[0]
      .pid;

  async function waitForBlocker(blockedPid, blockerPid, label) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const waiting = await inspect.query(
        "SELECT $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS waiting",
        [blockedPid, blockerPid],
      );
      if (waiting.rows[0].waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${label} did not reach the advisory-lock barrier`);
  }

  let firstOpen = false;
  let secondOpen = false;
  let adminOpen = false;
  let stage = "fixture creation";
  let failure;
  try {
    for (const client of [first, second, admin, inspect])
      await client.query("SET statement_timeout='10s'");
    await first.query("SET ROLE service_role");
    await second.query("SET ROLE service_role");

    const initialGate = await json(
      admin,
      "SELECT public.fn_get_whatsapp_admission_status() AS result",
    );
    assert.equal(initialGate.mode, "OPEN");
    assert.equal(
      initialGate.databaseClear,
      true,
      `barrier concurrency harness requires a clean disposable WhatsApp ledger: ${JSON.stringify(initialGate.databaseBlockers)}`,
    );

    await inspect.query(
      "INSERT INTO public.tb_households(id,name) VALUES($1,'Admission barrier fixture')",
      [householdId],
    );
    for (const [id, auth, sender, label] of [
      [userId, authId, verifiedSender, "Verified barrier fixture"],
      [legacyUserId, legacyAuthId, legacySender, "Legacy barrier fixture"],
      [linkTargetId, linkTargetAuthId, linkSender, "Link-only barrier fixture"],
    ]) {
      await inspect.query(
        "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,pg_catalog.now())",
        [id, `${randomUUID()}@admission-barrier.example.test`],
      );
      await inspect.query(
        "INSERT INTO public.tb_users(id,auth_user_id,display_name,external_identifier) VALUES($1,$2,$3,$4)",
        [id, auth, label, id === legacyUserId ? sender : `supabase:${auth}`],
      );
      await inspect.query(
        "INSERT INTO public.tb_household_members(id,user_id,household_id,display_name,role,status) VALUES($1,$2,$3,$4,$5,'ACTIVE')",
        [randomUUID(), id, householdId, label, id === userId ? "OWNER" : "MEMBER"],
      );
    }
    await inspect.query(
      "INSERT INTO public.tb_whatsapp_links(id,user_id,sender,status,authorization_version,verified_at) VALUES($1,$2,$3,'ACTIVE',1,pg_catalog.now())",
      [linkId, userId, verifiedSender],
    );

    // Admission obtains the shared advisory gate first. The close must wait;
    // once the claim commits, close pauses that never-started reservation.
    stage = "claim-first close race";
    const claimFirstId = event("claim-first");
    const claimFirstToken = token();
    await first.query("BEGIN");
    firstOpen = true;
    const claimFirst = await claim(first, claimFirstId, claimFirstToken);
    assert.equal(claimFirst.status, "CLAIMED");
    const firstPid = await pid(first);
    const adminPid = await pid(admin);
    const closeAfterClaim = json(
      admin,
      "SELECT public.fn_start_whatsapp_drain() AS result",
    );
    await waitForBlocker(adminPid, firstPid, "close after claim");
    await first.query("COMMIT");
    firstOpen = false;
    const firstCloseResult = await closeAfterClaim;
    assert.equal(firstCloseResult.mode, "DRAINING");
    const firstReceipt = (
      await inspect.query(
        "SELECT processing_state,admission_generation,user_id,context_lease_id,event_token FROM public.tb_whatsapp_event_receipts WHERE external_event_id=$1",
        [claimFirstId],
      )
    ).rows[0];
    assert.equal(firstReceipt.processing_state, "PAUSED");
    assert.equal(Number(firstReceipt.admission_generation), 1);
    assert.equal(firstReceipt.user_id, userId);
    assert.equal(firstReceipt.context_lease_id, claimFirst.leaseId);
    assert.equal(firstReceipt.event_token, null);
    const releasedFirstContext = (
      await inspect.query(
        "SELECT processing_lease_id,processing_expires_at FROM public.tb_whatsapp_user_contexts WHERE user_id=$1",
        [userId],
      )
    ).rows[0];
    assert.equal(releasedFirstContext.processing_lease_id, null);
    assert.equal(releasedFirstContext.processing_expires_at, null);
    assert.equal(
      (await begin(first, claimFirstId, claimFirstToken, claimFirst.epoch)).status,
      "PAUSED",
    );

    // A claim after the committed close is serialized behind the gate and
    // becomes a tombstone without resolving the sender or acquiring a lease.
    const claimAfterCloseId = event("claim-after-close");
    const afterClose = await claim(second, claimAfterCloseId);
    assert.equal(afterClose.status, "PAUSED");
    const afterCloseReceipt = (
      await inspect.query(
        "SELECT processing_state,admission_generation,user_id,context_lease_id FROM public.tb_whatsapp_event_receipts WHERE external_event_id=$1",
        [claimAfterCloseId],
      )
    ).rows[0];
    assert.equal(afterCloseReceipt.processing_state, "PAUSED");
    assert.equal(Number(afterCloseReceipt.admission_generation), 1);
    assert.equal(afterCloseReceipt.user_id, null);
    assert.equal(afterCloseReceipt.context_lease_id, null);
    await json(admin, "SELECT public.fn_resume_whatsapp_admissions() AS result");

    // Conversely, a close that holds the gate first prevents a waiting claim
    // from being classified as admitted in the previous generation.
    stage = "close-first claim race";
    await admin.query("BEGIN");
    adminOpen = true;
    const closeFirst = await json(
      admin,
      "SELECT public.fn_start_whatsapp_drain() AS result",
    );
    assert.equal(closeFirst.mode, "DRAINING");
    const closeFirstPid = await pid(admin);
    const secondPid = await pid(second);
    const claimBehindCloseId = event("claim-behind-close");
    const claimBehindCloseToken = token();
    const waitingClaim = claim(second, claimBehindCloseId, claimBehindCloseToken);
    await waitForBlocker(secondPid, closeFirstPid, "claim behind close");
    await admin.query("COMMIT");
    adminOpen = false;
    assert.equal((await waitingClaim).status, "PAUSED");
    const behindClose = (
      await inspect.query(
        "SELECT processing_state,admission_generation,user_id,context_lease_id FROM public.tb_whatsapp_event_receipts WHERE external_event_id=$1",
        [claimBehindCloseId],
      )
    ).rows[0];
    assert.equal(behindClose.processing_state, "PAUSED");
    assert.equal(Number(behindClose.admission_generation), 2);
    assert.equal(behindClose.user_id, null);
    assert.equal(behindClose.context_lease_id, null);
    assert.equal(
      (await begin(second, claimBehindCloseId, claimBehindCloseToken)).status,
      "PAUSED",
    );
    await json(admin, "SELECT public.fn_resume_whatsapp_admissions() AS result");

    stage = "active worker, legacy lease, and outbound permit drain";
    const activeEventId = event("active-worker");
    const activeToken = token();
    const activeClaim = await claim(first, activeEventId, activeToken);
    assert.equal(activeClaim.status, "CLAIMED");
    assert.equal(
      (await begin(first, activeEventId, activeToken, activeClaim.epoch)).status,
      "STARTED",
    );

    const oldLeaseId = token();
    const oldLease = await json(
      second,
      "SELECT public.fn_acquire_whatsapp_context_lease($1,$2,120) AS result",
      [legacyUserId, oldLeaseId],
    );
    assert.equal(oldLease.status, "ADMITTED");

    // A pre-close SEND permit, a RUNNING event and a receiptless legacy lease
    // all remain explicit blockers. The drain cannot claim completion while
    // any of them is unresolved.
    const deliveryEventId = event("outbound-permit");
    const deliveryDigest = "b".repeat(64);
    assert.equal(
      (
        await json(
          first,
          "SELECT public.fn_complete_whatsapp_link_event($1,$2,'123456',$3,NULL,NULL) AS result",
          [deliveryEventId, verifiedSender, deliveryDigest],
        )
      ).status,
      "READY",
    );
    const deliveryToken = token();
    const sendPermit = await json(
      first,
      "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
      [deliveryEventId, verifiedSender, deliveryDigest, deliveryToken],
    );
    assert.equal(sendPermit.status, "SEND");

    const drain = await json(
      admin,
      "SELECT public.fn_start_whatsapp_drain() AS result",
    );
    assert.equal(drain.mode, "DRAINING");
    const secondSendPermit = await json(
      second,
      "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
      [deliveryEventId, verifiedSender, deliveryDigest, token()],
    );
    assert.equal(
      secondSendPermit.status,
      "BUSY",
      "a live pre-close send permit must not be granted twice during drain",
    );
    assert.equal(await json(first, "SELECT public.fn_renew_whatsapp_event($1,$2,$3) AS result", [
      activeEventId,
      activeToken,
      activeClaim.epoch,
    ]), false);
    assert.equal(
      await json(
        second,
        "SELECT public.fn_renew_whatsapp_context_lease($1,$2,$3,120) AS result",
        [legacyUserId, oldLeaseId, oldLease.epoch],
      ),
      false,
    );
    assert.equal(
      await json(
        second,
        "SELECT public.fn_assert_whatsapp_context_lease($1,$2,$3) AS result",
        [legacyUserId, oldLeaseId, oldLease.epoch],
      ),
      false,
      "legacy worker without a RUNNING receipt must be fenced during drain",
    );

    const blockedStatus = await json(
      admin,
      "SELECT public.fn_enter_whatsapp_link_only() AS result",
    );
    assert.equal(blockedStatus.status, "BLOCKED");
    assert.equal(Number(blockedStatus.databaseBlockers.running), 1);
    assert.equal(Number(blockedStatus.databaseBlockers.sending), 1);
    assert.ok(Number(blockedStatus.databaseBlockers.leases_active) >= 2);

    // Expiry is injected as fixture state, then the real reaper performs the
    // fencing transitions. No sleep is used to infer expiry or lock ordering.
    await inspect.query(
      "UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=pg_catalog.clock_timestamp()-interval '1 second' WHERE external_event_id=$1",
      [activeEventId],
    );
    await inspect.query(
      "UPDATE public.tb_whatsapp_event_receipts SET delivery_expires_at=pg_catalog.clock_timestamp()-interval '1 second' WHERE external_event_id=$1",
      [deliveryEventId],
    );
    await inspect.query(
      "UPDATE public.tb_whatsapp_user_contexts SET processing_expires_at=pg_catalog.clock_timestamp()-interval '1 second' WHERE user_id=$1",
      [legacyUserId],
    );
    await inspect.query(
      "UPDATE public.tb_whatsapp_user_contexts SET processing_expires_at=pg_catalog.clock_timestamp()-interval '1 second' WHERE user_id=$1",
      [userId],
    );
    const reaped = await json(
      admin,
      "SELECT public.fn_reap_whatsapp_drain() AS result",
    );
    assert.equal(reaped.status, "REAPED");
    const reapedActive = (
      await inspect.query(
        "SELECT processing_state,event_token,event_expires_at FROM public.tb_whatsapp_event_receipts WHERE external_event_id=$1",
        [activeEventId],
      )
    ).rows[0];
    assert.equal(reapedActive.processing_state, "UNCERTAIN");
    assert.equal(reapedActive.event_token, null);
    assert.equal(reapedActive.event_expires_at, null);
    const reapedDelivery = (
      await inspect.query(
        "SELECT delivery_state,delivery_token,delivery_expires_at FROM public.tb_whatsapp_event_receipts WHERE external_event_id=$1",
        [deliveryEventId],
      )
    ).rows[0];
    assert.equal(reapedDelivery.delivery_state, "UNKNOWN");
    assert.equal(reapedDelivery.delivery_token, null);
    assert.equal(reapedDelivery.delivery_expires_at, null);
    assert.equal(
      (
        await json(
          second,
          "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
          [deliveryEventId, verifiedSender, deliveryDigest, token()],
        )
      ).status,
      "UNKNOWN",
      "an expired SEND permit classified UNKNOWN must not be reissued",
    );
    assert.equal(
      await json(
        second,
        "SELECT public.fn_assert_whatsapp_context_lease($1,$2,$3) AS result",
        [legacyUserId, oldLeaseId, oldLease.epoch],
      ),
      false,
    );
    await assert.rejects(
      json(
        first,
        "SELECT public.fn_finish_whatsapp_event($1,$2,$3,'GENERIC_V1','fixture reply','{}'::jsonb) AS result",
        [activeEventId, activeToken, activeClaim.epoch],
      ),
      (error) => error.code === "40001",
    );
    await assert.rejects(
      json(
        first,
        "SELECT public.fn_finish_whatsapp_delivery($1,$2,$3,'ACCEPTED',200,NULL) AS result",
        [deliveryEventId, deliveryToken, sendPermit.epoch],
      ),
      (error) => error.code === "40001",
    );
    stage = "uncertain and unknown outcomes remain blockers";
    const unknownBlocked = await json(
      admin,
      "SELECT public.fn_enter_whatsapp_link_only() AS result",
    );
    assert.equal(unknownBlocked.status, "BLOCKED");
    assert.equal(Number(unknownBlocked.databaseBlockers.uncertain), 1);
    assert.equal(Number(unknownBlocked.databaseBlockers.unknown), 1);

    // These two unresolved receipts are synthetic fixtures in an ephemeral DB.
    // Production equivalents require human reconciliation and remain blockers.
    await inspect.query(
      "DELETE FROM public.tb_whatsapp_event_receipts WHERE external_event_id=ANY($1::text[])",
      [[activeEventId, deliveryEventId]],
    );
    await inspect.query(
      "DELETE FROM public.tb_processed_whatsapp_events WHERE external_event_id=ANY($1::text[])",
      [[activeEventId, deliveryEventId]],
    );
    stage = "link-only runtime behavior";
    const linkOnly = await json(
      admin,
      "SELECT public.fn_enter_whatsapp_link_only() AS result",
    );
    assert.equal(linkOnly.status, "LINK_ONLY");

    assert.equal(
      (await claim(second, event("link-only-message"))).status,
      "PAUSED",
    );
    assert.equal(
      (
        await json(
          second,
          "SELECT public.fn_acquire_whatsapp_context_lease($1,$2,120) AS result",
          [legacyUserId, token()],
        )
      ).status,
      "PAUSED",
    );
    assert.equal(
      (
        await json(
          second,
          "SELECT public.fn_admit_whatsapp_sender($1,$2,120) AS result",
          [legacySender, token()],
        )
      ).status,
      "PAUSED",
    );
    await assert.rejects(
      second.query(
        "INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES($1)",
        [event("legacy-direct-insert")],
      ),
      (error) => error.code === "42501",
    );

    const startLink = await json(
      second,
      "SELECT public.fn_start_whatsapp_link_challenge($1,$2,$3,$4,$5) AS result",
      [linkTargetAuthId, linkChallengeId, linkSender, linkCodeDigest, linkIdempotencyKey],
    );
    assert.equal(startLink.status, "PENDING");

    const linkEventId = event("link-only-control");
    const linkDigest = "c".repeat(64);
    assert.equal(
      (
        await json(
          second,
          "SELECT public.fn_complete_whatsapp_link_event($1,$2,'123456',$3,$4,$5) AS result",
          [linkEventId, linkSender, linkDigest, linkChallengeId, linkCodeDigest],
        )
      ).status,
      "READY",
    );
    assert.equal(
      (
        await json(
          second,
          "SELECT public.fn_complete_whatsapp_link_event($1,$2,'123456',$3,$4,$5) AS result",
          [linkEventId, linkSender, linkDigest, linkChallengeId, linkCodeDigest],
        )
      ).status,
      "READY",
      "link event redelivery must replay its receipt without consuming the challenge again",
    );
    const completedLink = await inspect.query(
      `SELECT c.status AS challenge_status,
              count(l.id) FILTER (WHERE l.status='ACTIVE') AS active_links,
              count(e.external_event_id) AS link_event_rows,
              max(b.attempts) AS sender_attempts
         FROM public.tb_whatsapp_link_challenges c
         LEFT JOIN public.tb_whatsapp_links l ON l.user_id=c.user_id AND l.sender=$2
         LEFT JOIN public.tb_whatsapp_link_events e ON e.external_event_id=$3
         LEFT JOIN public.tb_whatsapp_link_attempt_buckets b ON b.sender_digest=$4
        WHERE c.id=$1
        GROUP BY c.status`,
      [linkChallengeId, linkSender, linkEventId, linkSenderDigest],
    );
    assert.deepEqual(completedLink.rows[0], {
      challenge_status: "CONSUMED",
      active_links: "1",
      link_event_rows: "1",
      sender_attempts: 1,
    });
    const linkDeliveryToken = token();
    const linkPermit = await json(
      second,
      "SELECT public.fn_prepare_whatsapp_delivery($1,$2,'123456',$3,$4) AS result",
      [linkEventId, linkSender, linkDigest, linkDeliveryToken],
    );
    assert.equal(linkPermit.status, "SEND");
    assert.equal(
      (
        await json(
          second,
          "SELECT public.fn_finish_whatsapp_delivery($1,$2,$3,'ACCEPTED',200,NULL) AS result",
          [linkEventId, linkDeliveryToken, linkPermit.epoch],
        )
      ).status,
      "ACCEPTED",
    );
    await json(admin, "SELECT public.fn_resume_whatsapp_admissions() AS result");

    console.log(
      "PASS WhatsApp admission barrier serializes close/claim races, fences expired workers, permits idempotent link completion in link-only mode, and refuses stale outbound permits",
    );
  } catch (error) {
    failure = new Error(`${stage}: ${error.message}`, { cause: error });
  } finally {
    if (firstOpen) await first.query("ROLLBACK").catch(() => {});
    if (secondOpen) await second.query("ROLLBACK").catch(() => {});
    if (adminOpen) await admin.query("ROLLBACK").catch(() => {});
    try {
      await admin.query("SELECT public.fn_resume_whatsapp_admissions()");
      await inspect.query(
        "DELETE FROM public.tb_whatsapp_link_events WHERE external_event_id=ANY($1::text[])",
        [[...eventIds]],
      );
      await inspect.query(
        "DELETE FROM public.tb_whatsapp_event_receipts WHERE external_event_id=ANY($1::text[])",
        [[...eventIds]],
      );
      await inspect.query(
        "DELETE FROM public.tb_processed_whatsapp_events WHERE external_event_id=ANY($1::text[])",
        [[...eventIds]],
      );
      await inspect.query("DELETE FROM public.tb_whatsapp_user_contexts WHERE user_id=ANY($1::uuid[])", [
        [userId, legacyUserId, linkTargetId],
      ]);
      await inspect.query("DELETE FROM public.tb_whatsapp_link_attempt_buckets WHERE sender_digest=$1", [linkSenderDigest]);
      await inspect.query("DELETE FROM public.tb_whatsapp_link_challenges WHERE user_id=$1", [linkTargetId]);
      await inspect.query("DELETE FROM public.tb_whatsapp_links WHERE user_id=$1", [linkTargetId]);
      await inspect.query("DELETE FROM public.tb_whatsapp_links WHERE id=$1", [linkId]);
      await inspect.query("DELETE FROM public.tb_household_members WHERE household_id=$1", [householdId]);
      await inspect.query("DELETE FROM public.tb_users WHERE id=ANY($1::uuid[])", [
        [userId, legacyUserId, linkTargetId],
      ]);
      await inspect.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [
        [authId, legacyAuthId, linkTargetAuthId],
      ]);
      await inspect.query("DELETE FROM public.tb_households WHERE id=$1", [householdId]);
    } catch (error) {
      failure ??= new Error(`fixture cleanup: ${error.message}`, { cause: error });
    } finally {
      await Promise.all([first, second, admin, inspect].map((client) => client.end()));
    }
  }
  if (failure) throw failure;
};
