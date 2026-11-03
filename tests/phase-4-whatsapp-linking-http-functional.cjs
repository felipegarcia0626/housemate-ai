const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

function loadBackend(rpc, identity) {
  class AuthError extends Error {
    constructor(code) {
      super("private auth detail");
      this.code = code;
    }
  }
  const auth = {
    SupabaseAuthError: AuthError,
    getAuthenticatedAuthUser: async () => {
      const value = identity();
      if (typeof value === "string") throw new AuthError(value);
      return value;
    },
  };
  const cache = new Map();
  function load(file) {
    const resolved = path.resolve(file);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const loadedModule = { exports: {} };
    cache.set(resolved, loadedModule);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    function localRequire(name) {
      if (name === "@/infrastructure/database/client")
        return { getSupabaseAdminClient: () => ({ rpc }) };
      if (name === "@/infrastructure/auth/supabase-server.client") return auth;
      if (name.startsWith("@/"))
        return load(path.join(root, name.slice(2) + ".ts"));
      if (name.startsWith("."))
        return load(path.resolve(path.dirname(resolved), name + ".ts"));
      return require(name);
    }
    new Function("require", "module", "exports", output)(
      localRequire,
      loadedModule,
      loadedModule.exports,
    );
    return loadedModule.exports;
  }
  return {
    route: load(path.join(root, "app/api/auth/whatsapp/link/route.ts")),
  };
}
const userA = "46000000-0000-4000-8000-000000000001";
const userB = "46000000-0000-4000-8000-000000000002";
const eligible = (id) => ({
  id,
  email: "linking@example.test",
  emailConfirmedAt: "2026-01-01T00:00:00Z",
});
const request = (method, body) =>
  new Request("http://localhost/api/auth/whatsapp/link", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
async function read(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response.json();
}

async function main() {
  let current = eligible(userA),
    injected = null;
  const records = new Map(),
    calls = [];
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (injected) return injected(name, args);
    const own = [...records.values()]
      .filter((r) => r.owner === args.p_auth_user_id)
      .at(-1);
    if (name === "fn_get_whatsapp_link_state")
      return {
        data: {
          link: null,
          challenge: own
            ? {
                id: own.id,
                status: own.status,
                expiresAt: own.expiresAt,
                attemptsRemaining: 5,
              }
            : null,
        },
        error: null,
      };
    if (name === "fn_start_whatsapp_link_challenge") {
      if (records.has(args.p_challenge_id))
        return { data: { status: "IDEMPOTENCY_CONFLICT" }, error: null };
      const record = {
        id: args.p_challenge_id,
        owner: args.p_auth_user_id,
        status: "PENDING",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        digest: args.p_code_digest,
        sender: args.p_sender,
      };
      records.set(record.id, record);
      return {
        data: {
          status: "PENDING",
          challengeId: record.id,
          expiresAt: record.expiresAt,
        },
        error: null,
      };
    }
    assert.equal(name, "fn_cancel_whatsapp_link_challenge");
    const record = records.get(args.p_challenge_id);
    if (!record || record.owner !== args.p_auth_user_id)
      return { data: { status: "NOT_FOUND" }, error: null };
    if (record.status === "PENDING") record.status = "CANCELLED";
    return {
      data: { status: record.status, challengeId: record.id },
      error: null,
    };
  };
  const { route } = loadBackend(rpc, () => current);
  const logs = [],
    originalConsole = {},
    originalFetch = global.fetch;
  for (const key of ["info", "log", "warn", "error"]) {
    originalConsole[key] = console[key];
    console[key] = (...args) => logs.push(args);
  }
  global.fetch = async () => {
    throw new Error("Unexpected external request");
  };
  try {
    for (const identity of [
      "UNAUTHENTICATED",
      "AUTH_PROVIDER_ERROR",
      { ...eligible(userA), emailConfirmedAt: null },
      { ...eligible(userA), email: null },
    ]) {
      current = identity;
      const expected =
        typeof identity === "string"
          ? identity === "UNAUTHENTICATED"
            ? 401
            : 500
          : 403;
      const before = calls.length;
      await read(await route.GET(), expected);
      await read(
        await route.POST(
          request("POST", {
            phoneNumber: "+1 999 000 0401",
            idempotencyKey: randomUUID(),
          }),
        ),
        expected,
      );
      await read(
        await route.DELETE(request("DELETE", { challengeId: randomUUID() })),
        expected,
      );
      assert.equal(calls.length, before);
    }
    current = eligible(userA);
    const key = randomUUID();
    const input = { phoneNumber: " +1 (999) 000-0401 ", idempotencyKey: key };
    const initial = (await read(await route.POST(request("POST", input)), 201))
      .data;
    const secret = initial.verificationMessage.split(" ").at(-1);
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(secret, "base64url").length, 32);
    assert.equal(
      records.get(key).digest,
      createHash("sha256").update(secret).digest("hex"),
    );
    assert.equal(records.get(key).sender, "19990000401");
    assert.ok(!JSON.stringify([...records.values()]).includes(secret));
    const writes = calls.filter(
      (c) => c.name === "fn_start_whatsapp_link_challenge",
    ).length;
    const retry = (await read(await route.POST(request("POST", input)), 409))
      .data;
    assert.deepEqual(retry, { status: "RESTART_REQUIRED", challengeId: key });
    assert.equal(
      calls.filter((c) => c.name === "fn_start_whatsapp_link_challenge").length,
      writes,
    );
    const status = await read(await route.GET(), 200);
    assert.equal(status.data.challenge.id, key);
    assert.ok(!JSON.stringify(status).includes(secret));
    current = eligible(userB);
    assert.equal((await read(await route.GET(), 200)).data.challenge, null);
    await read(
      await route.DELETE(request("DELETE", { challengeId: key })),
      404,
    );
    assert.equal(records.get(key).status, "PENDING");
    current = eligible(userA);
    await read(
      await route.DELETE(request("DELETE", { challengeId: key })),
      200,
    );
    await read(
      await route.DELETE(request("DELETE", { challengeId: key })),
      200,
    );
    assert.equal(records.get(key).status, "CANCELLED");
    for (const value of [
      "19990000401",
      "+012345678",
      "+123",
      "+1234567890123456",
      "+1.9990000401",
      "+1 999 ext 0401",
      null,
      {},
      ["+19990000401"],
    ]) {
      const before = calls.length;
      await read(
        await route.POST(
          request("POST", { phoneNumber: value, idempotencyKey: randomUUID() }),
        ),
        400,
      );
      assert.equal(calls.length, before);
    }
    for (const body of [
      { ...input, userId: userB },
      { ...input, idempotencyKey: "invalid" },
      { phoneNumber: input.phoneNumber },
    ])
      await read(await route.POST(request("POST", body)), 400);
    await read(
      await route.POST(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
      ),
      400,
    );
    await read(
      await route.POST(
        new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
      400,
    );
    const concurrentKey = randomUUID();
    const concurrent = await Promise.all([
      route.POST(request("POST", { ...input, idempotencyKey: concurrentKey })),
      route.POST(request("POST", { ...input, idempotencyKey: concurrentKey })),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
    assert.equal(
      (await concurrent.find((r) => r.status === 409).json()).data.status,
      "RESTART_REQUIRED",
    );
    for (const result of [
      "RATE_LIMITED",
      "UNAVAILABLE",
      "ALREADY_LINKED",
      "EXPIRED",
      "CONSUMED",
    ]) {
      injected = async (name, args) =>
        name === "fn_get_whatsapp_link_state"
          ? { data: { link: null, challenge: null } }
          : {
              data: {
                status: result,
                challengeId: args.p_challenge_id,
                expiresAt: new Date().toISOString(),
                secret: "private",
              },
            };
      const body = await read(
        await route.POST(
          request("POST", { ...input, idempotencyKey: randomUUID() }),
        ),
        result === "RATE_LIMITED" ? 429 : 409,
      );
      assert.ok(!JSON.stringify(body).includes("private"));
      assert.ok(!JSON.stringify(body).includes("verificationMessage"));
    }
    for (const error of [
      { code: "42501", message: "WhatsApp linking is unavailable" },
      { code: "42501", message: "private SQL" },
      { code: "XX000", message: "private SQL" },
    ]) {
      injected = async () => ({ data: null, error });
      const body = await read(
        await route.GET(),
        error.message === "WhatsApp linking is unavailable" ? 403 : 500,
      );
      assert.ok(!JSON.stringify(body).includes("private"));
    }
    for (const malformed of [
      { link: null },
      {
        link: { id: userA, authorizationVersion: -1, verifiedAt: "bad" },
        challenge: null,
      },
    ]) {
      injected = async () => ({ data: malformed });
      await read(await route.GET(), 500);
    }
    injected = async () => ({
      data: {
        link: {
          id: userA,
          authorizationVersion: 1,
          verifiedAt: "2026-01-01T00:00:00Z",
          sender: "private",
          secret,
        },
        challenge: null,
        secret,
      },
    });
    const projected = await read(await route.GET(), 200);
    assert.deepEqual(projected.data, {
      link: {
        id: userA,
        authorizationVersion: 1,
        verifiedAt: "2026-01-01T00:00:00Z",
      },
      challenge: null,
    });
    injected = async (name) =>
      name === "fn_get_whatsapp_link_state"
        ? { data: { link: null, challenge: null } }
        : {
            data: {
              status: "PENDING",
              challengeId: "wrong",
              expiresAt: new Date().toISOString(),
            },
          };
    await read(
      await route.POST(
        request("POST", { ...input, idempotencyKey: randomUUID() }),
      ),
      503,
    );
    await read(
      await route.DELETE(request("DELETE", { challengeId: key })),
      500,
    );
    await read(
      await route.DELETE(
        request("DELETE", { challengeId: key, userId: userB }),
      ),
      400,
    );
    await read(
      await route.POST(
        request("POST", { ...input, phoneNumber: "x".repeat(4097) }),
      ),
      400,
    );
    injected = async (name) =>
      name === "fn_get_whatsapp_link_state"
        ? { data: { link: null, challenge: null } }
        : Promise.reject(new Error("private transport failure"));
    const unknown = await read(
      await route.POST(
        request("POST", { ...input, idempotencyKey: randomUUID() }),
      ),
      503,
    );
    assert.equal(unknown.error.code, "CHALLENGE_OUTCOME_UNKNOWN");
    assert.ok(!JSON.stringify(unknown).includes("private transport"));
    assert.equal(logs.length, 0, "No request, phone or secret logging");
    assert.ok(
      calls.every((c) =>
        [
          "fn_get_whatsapp_link_state",
          "fn_start_whatsapp_link_challenge",
          "fn_cancel_whatsapp_link_challenge",
        ].includes(c.name),
      ),
    );
  } finally {
    global.fetch = originalFetch;
    for (const key of Object.keys(originalConsole))
      console[key] = originalConsole[key];
  }
  console.log(
    "PASS WhatsApp linking HTTP authentication, isolation, digest, one-time disclosure, retries and sanitized errors",
  );
}

module.exports = { loadBackend, request, read, eligible };
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
