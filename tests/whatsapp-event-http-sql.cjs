const assert = require("node:assert/strict");
const path = require("node:path");
const { createHmac, randomUUID } = require("node:crypto");
const {
  createLoader,
  incomingPayload,
} = require("./phase-4-whatsapp-functional.cjs");

// Real HMAC route, channel and repositories, actual disposable PostgreSQL RPCs.
// Agent decisions/authenticated Meta delivery are controlled local doubles.
module.exports = async function eventHttpSql(postgres) {
  const root = path.resolve(__dirname, "..");
  const db = postgres.getPgClient("housemate_test"),
    inspect = postgres.getPgClient("housemate_test");
  await Promise.all([db.connect(), inspect.connect()]);
  const user = "47000000-0046-4000-8000-000000000001",
    hh = "47000000-0046-4000-8000-000000000099",
    sender = "19990004701",
    emitter = "123456";
  const originalFetch = global.fetch,
    originalInfo = console.info;
  const keys = [
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
  ];
  const oldEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  let agentCalls = 0,
    sends = 0,
    dropRpc = null,
    mode = "read",
    proposal,
    provider = "success",
    revokeBeforeDelivery = false;
  const logs = [];
  const rpc = async (name, args) => {
    assert.match(name, /^fn_[a-z_]+$/);
    assert.ok(
      [
        "fn_claim_whatsapp_event",
        "fn_begin_whatsapp_event",
        "fn_assert_whatsapp_event",
        "fn_bind_whatsapp_event_context",
        "fn_renew_whatsapp_event",
        "fn_finish_whatsapp_event",
        "fn_fail_whatsapp_event",
        "fn_prepare_whatsapp_delivery",
        "fn_finish_whatsapp_delivery",
        "fn_complete_whatsapp_link_event",
        "fn_transition_whatsapp_event_context",
        "fn_assert_whatsapp_active_context",
        "fn_release_whatsapp_context_lease",
        "fn_confirm_whatsapp_income_event",
      ].includes(name),
    );
    try {
      if (name === "fn_prepare_whatsapp_delivery" && revokeBeforeDelivery) {
        revokeBeforeDelivery = false;
        await db.query("SELECT public.fn_revoke_whatsapp_link($1,$2,1)", [
          user,
          user,
        ]);
      }
      const entries = Object.entries(args);
      entries.forEach(([key]) => assert.match(key, /^p_[a-z_]+$/));
      const values = entries.map(([key, value]) =>
        ["p_reply_guard", "p_payload", "p_items", "p_distributions"].includes(
          key,
        ) && value !== null
          ? JSON.stringify(value)
          : value,
      );
      const sql = `SELECT to_jsonb(public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(",")})) AS result`;
      const value = (await db.query(sql, values)).rows[0].result;
      if (dropRpc === name) {
        dropRpc = null;
        return { data: null, error: { code: "08006" } };
      }
      return { data: value, error: null };
    } catch (error) {
      return {
        data: null,
        error: { code: error.code, message: error.message },
      };
    }
  };
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.singleRow = false;
    }
    select() {
      return this;
    }
    eq(key, value) {
      this.filters.push({ key, value });
      return this;
    }
    in(key, value) {
      this.filters.push({ key, value, array: true });
      return this;
    }
    order() {
      return this;
    }
    maybeSingle() {
      this.singleRow = true;
      return this.execute();
    }
    single() {
      this.singleRow = true;
      return this.execute();
    }
    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }
    async execute() {
      assert.ok(
        [
          "tb_household_members",
          "tb_households",
          "tb_whatsapp_user_contexts",
        ].includes(this.table),
      );
      const values = [];
      const where = this.filters
        .map((f) => {
          assert.match(f.key, /^[a-z_]+$/);
          values.push(f.value);
          return `${f.key} ${f.array ? `= ANY($${values.length})` : `=$${values.length}`}`;
        })
        .join(" AND ");
      try {
        const rows = (
          await db.query(
            `SELECT to_jsonb(t) AS row FROM public.${this.table} t${where ? ` WHERE ${where}` : ""}`,
            values,
          )
        ).rows.map((x) => x.row);
        return { data: this.singleRow ? (rows[0] ?? null) : rows, error: null };
      } catch (error) {
        return { data: null, error: { code: error.code } };
      }
    }
  }
  const client = { rpc, from: (table) => new Query(table) };
  let load;
  const fakeAgent = {
    async processAgentMessage(context) {
      agentCalls++;
      await context.whatsappExecution.assertCurrent();
      if (mode === "confirm") {
        const repository = load(
          path.join(root, "modules/agent/pending-proposal.repository.ts"),
        );
        const confirmed = await repository.confirmPendingIncome({
          proposalId: proposal.id,
          householdId: hh,
          conversationKey: `whatsapp:${emitter}:${sender}`,
          actorMemberId: user,
          source: "WHATSAPP",
          expectedUpdatedAt: proposal.updated_at,
          income: {
            createdBy: user,
            memberId: user,
            amount: 42,
            incomeDate: "2026-10-29",
            description: "HTTP SQL fixture",
            categoryId: null,
          },
          whatsappLease: context.whatsappExecution,
        });
        return {
          type: "CONFIRMED",
          proposalId: proposal.id,
          status: "CONFIRMED",
          incomeId: confirmed.incomeId,
          income: {},
        };
      }
      return {
        type: "UNSUPPORTED",
        message: "Respuesta persistida de prueba.",
      };
    },
  };
  try {
    await inspect.query(
      "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'event-http@example.test',now())",
      [user],
    );
    await inspect.query(
      "INSERT INTO public.tb_users(id,auth_user_id,external_identifier,display_name) VALUES($1,$1,$2,'Event HTTP fixture')",
      [user, `supabase:${user}`],
    );
    await inspect.query(
      "INSERT INTO public.tb_households(id,name) VALUES($1,'Event HTTP fixture')",
      [hh],
    );
    await inspect.query(
      "INSERT INTO public.tb_household_members(id,user_id,household_id,display_name,role,status) VALUES($1,$1,$2,'Fixture','OWNER','ACTIVE')",
      [user, hh],
    );
    await inspect.query(
      "INSERT INTO public.tb_whatsapp_links(id,user_id,sender,status,authorization_version,verified_at) VALUES($1,$1,$2,'ACTIVE',1,now())",
      [user, sender],
    );
    await db.query("SET ROLE service_role");
    load = createLoader(
      new Map([
        [
          path.join(root, "infrastructure/database/client.ts"),
          { getSupabaseAdminClient: () => client },
        ],
        [path.join(root, "modules/agent/conversation.service.ts"), fakeAgent],
        [
          path.join(root, "modules/agent/agent.service.ts"),
          { findActiveProposalId: async () => proposal?.id ?? null },
        ],
      ]),
    );
    const route = load(path.join(root, "app/api/webhooks/whatsapp/route.ts"));
    process.env.WHATSAPP_APP_SECRET = "local-event-hmac";
    process.env.WHATSAPP_ACCESS_TOKEN = "local-event-token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = emitter;
    console.info = (...args) => logs.push(args);
    global.fetch = async () => {
      sends++;
      if (provider === "timeout")
        throw new DOMException("private-timeout", "TimeoutError");
      return { ok: true, status: 200 };
    };
    const post = async (event, text = "Hola") => {
      const body = JSON.stringify(
        incomingPayload(event, text, sender, emitter),
      );
      return route.POST(
        new Request("http://localhost/api/webhooks/whatsapp", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": `sha256=${createHmac("sha256", "local-event-hmac").update(body).digest("hex")}`,
          },
        }),
      );
    };
    const eventReceipt = async (event) =>
      (
        await inspect.query(
          "SELECT to_jsonb(r) AS row FROM public.tb_whatsapp_event_receipts r WHERE external_event_id=$1",
          [event],
        )
      ).rows[0].row;

    dropRpc = "fn_begin_whatsapp_event";
    assert.equal((await post("http-begin-response-lost")).status, 500);
    assert.equal(agentCalls, 0);
    assert.equal(sends, 0);
    assert.equal(
      (await eventReceipt("http-begin-response-lost")).processing_state,
      "UNCERTAIN",
    );
    assert.equal((await post("http-begin-response-lost")).status, 200);
    assert.equal(agentCalls, 0);
    assert.equal(sends, 0);

    delete process.env.WHATSAPP_ACCESS_TOKEN;
    assert.equal((await post("http-retryable")).status, 500);
    assert.equal(
      (await eventReceipt("http-retryable")).delivery_state,
      "RETRYABLE",
    );
    assert.equal(sends, 0);
    assert.equal(agentCalls, 1);
    process.env.WHATSAPP_ACCESS_TOKEN = "local-event-token";
    assert.equal((await post("http-retryable")).status, 200);
    assert.equal(agentCalls, 1);
    assert.equal(sends, 1);
    assert.equal(
      (await eventReceipt("http-retryable")).delivery_state,
      "ACCEPTED",
    );

    provider = "timeout";
    assert.equal((await post("http-unknown")).status, 500);
    const afterTimeout = { agentCalls, sends };
    provider = "success";
    assert.equal(
      (await eventReceipt("http-unknown")).delivery_state,
      "UNKNOWN",
    );
    assert.equal((await post("http-unknown")).status, 200);
    assert.deepEqual({ agentCalls, sends }, afterTimeout);

    dropRpc = "fn_finish_whatsapp_event";
    assert.equal((await post("http-finish-lost")).status, 500);
    const afterLostAgent = agentCalls,
      afterLostSends = sends;
    assert.equal(
      (await eventReceipt("http-finish-lost")).delivery_state,
      "READY",
    );
    assert.equal((await post("http-finish-lost")).status, 200);
    assert.equal(agentCalls, afterLostAgent);
    assert.equal(sends, afterLostSends + 1);

    const id = randomUUID();
    proposal = (
      await inspect.query(
        "INSERT INTO public.tb_pending_proposals(id,household_id,conversation_key,actor_member_id,source,operation_type,payload,status) VALUES($1,$2,$3,$4,'WHATSAPP','CREATE_INCOME',$5,'AWAITING_CONFIRMATION') RETURNING to_jsonb(tb_pending_proposals) AS row",
        [
          id,
          hh,
          `whatsapp:${emitter}:${sender}`,
          user,
          JSON.stringify({ actorMemberId: user, source: "WHATSAPP" }),
        ],
      )
    ).rows[0].row;
    mode = "confirm";
    dropRpc = "fn_confirm_whatsapp_income_event";
    assert.equal((await post("http-financial-commit-lost", "sí")).status, 200);
    const financial = await eventReceipt("http-financial-commit-lost");
    assert.equal(financial.business_result.status, "CREATED");
    assert.equal(financial.delivery_state, "ACCEPTED");
    assert.equal(
      (
        await inspect.query(
          "SELECT count(*)::int AS n FROM public.tb_incomes WHERE created_by=$1",
          [user],
        )
      ).rows[0].n,
      1,
    );
    const afterFinancial = { agentCalls, sends };
    assert.equal((await post("http-financial-commit-lost", "sí")).status, 200);
    assert.deepEqual({ agentCalls, sends }, afterFinancial);

    mode = "read";
    revokeBeforeDelivery = true;
    const beforeRevokeSends = sends;
    assert.equal((await post("http-revoked-delivery")).status, 200);
    assert.equal(
      (await eventReceipt("http-revoked-delivery")).delivery_state,
      "BLOCKED",
    );
    assert.equal(sends, beforeRevokeSends);
    assert.equal(
      (await eventReceipt("http-revoked-delivery")).reply_text,
      null,
    );
    assert.ok(!JSON.stringify(logs).includes("local-event-token"));
    assert.ok(!JSON.stringify(logs).includes(sender));
  } finally {
    global.fetch = originalFetch;
    console.info = originalInfo;
    for (const key of keys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    await Promise.all([db.end(), inspect.end()]);
  }
  console.log(
    "PASS real webhook/repository SQL: saved reply recovery, lost SQL confirmation, UNKNOWN timeout, and revocation before delivery",
  );
};
