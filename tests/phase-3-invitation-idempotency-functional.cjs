const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const householdId = "a0000000-0000-4000-8000-000000000001";
const invitationId = "a0000000-0000-4000-8000-000000000002";
const key = "a0000000-0000-4000-8000-000000000003";
let authUserId = "a0000000-0000-4000-8000-000000000004";
let active = true;
let randomCalls = 0;
let behavior;
const calls = [];
class SupabaseAuthError extends Error { constructor(code) { super(code); this.code = code; } }

function load(relativePath, cache = new Map()) {
  const file = path.resolve(root, relativePath);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = (name) => {
    if (name === "next/server") return { NextResponse: { json: (body, options) => Response.json(body, options) } };
    if (name === "node:crypto") return { ...crypto, randomBytes: (size) => { randomCalls++; return crypto.randomBytes(size); } };
    if (name === "@/infrastructure/auth/supabase-server.client") return {
      SupabaseAuthError,
      getAuthenticatedAuthUser: async () => {
        if (!authUserId) throw new SupabaseAuthError("UNAUTHENTICATED");
        return { id: authUserId, email: "actor@example.test" };
      },
    };
    if (name === "@/modules/context/authenticated-context.repository") return {
      findApplicationUserByAuthUserId: async () => ({ id: "actor-application-id" }),
      findActiveMembershipsByUserId: async () => active ? [{ householdId, memberId: "actor-member-id" }] : [],
    };
    if (name === "@/infrastructure/database/client") return {
      getSupabaseAdminClient: () => ({ rpc: async (rpc, parameters) => {
        calls.push({ rpc, parameters });
        return behavior(parameters);
      } }),
    };
    if (name.startsWith("@/")) return load(`${name.slice(2)}.ts`, cache);
    if (name.startsWith(".")) return load(path.relative(root, path.resolve(path.dirname(file), `${name}.ts`)), cache);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  vm.runInNewContext(output, { module, exports: module.exports, require: localRequire, URL, Response, Date }, { filename: file });
  return module.exports;
}

async function main() {
  const { POST } = load("app/api/auth/households/[householdId]/invitations/route.ts");
  const post = (body) => POST(new Request(`http://localhost/api/auth/households/${householdId}/invitations`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ householdId }) });
  behavior = (parameters) => ({ data: parameters.p_token_hash === null
    ? { outcome: "NEEDS_CREATION" }
    : { outcome: "CREATED", status: "PENDING", invitationId }, error: null });
  const created = await post({ email: "  Recipient@Example.Test ", idempotencyKey: key });
  assert.equal(created.status, 201);
  const createdData = (await created.json()).data;
  assert.equal(createdData.outcome, "CREATED");
  assert.equal(createdData.invitationId, invitationId);
  assert.ok(createdData.inviteUrl);
  assert.deepEqual(Object.keys(createdData).sort(), ["inviteUrl", "invitationId", "outcome", "status"].sort());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parameters.p_token_hash, null);
  assert.equal(calls[1].parameters.p_auth_user_id, authUserId);
  assert.equal(calls[1].parameters.p_invitee_email_normalized, "recipient@example.test");
  assert.equal(calls[1].parameters.p_idempotency_key, key);
  assert.equal(crypto.createHash("sha256").update(new URL(createdData.inviteUrl).pathname.split("/").at(-1)).digest("hex"), calls[1].parameters.p_token_hash);

  const beforeRecovery = randomCalls;
  behavior = () => ({ data: { outcome: "RECOVERED", status: "PENDING", invitationId, token_hash: "must-not-escape" }, error: null });
  const recovered = await post({ email: "recipient@example.test", idempotencyKey: key });
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).data, { outcome: "RECOVERED", status: "PENDING", invitationId });
  assert.equal(randomCalls, beforeRecovery, "recovery must not generate a replacement token");
  behavior = (parameters) => ({ data: parameters.p_token_hash === null ? { outcome: "NEEDS_CREATION" }
    : { outcome: "RECOVERED", status: "PENDING", invitationId }, error: null });
  const concurrentRecovery = await post({ email: "recipient@example.test", idempotencyKey: key });
  assert.equal(concurrentRecovery.status, 200);
  assert.deepEqual((await concurrentRecovery.json()).data, { outcome: "RECOVERED", status: "PENDING", invitationId },
    "a race loser must not expose its unused token or hash");

  behavior = () => ({ data: { outcome: "CREATED", status: "PENDING", invitationId }, error: null });
  const legacy = await post({ email: "recipient@example.test" });
  assert.equal(legacy.status, 201);
  assert.ok((await legacy.json()).data.inviteUrl);
  assert.equal(calls.at(-1).parameters.p_idempotency_key, null);

  behavior = () => ({ data: null, error: { code: "P0004", message: "private SQL secret" } });
  const conflict = await post({ email: "different@example.test", idempotencyKey: key });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: { code: "CONFLICT", message: "Ya existe una invitación activa para ese correo." } });
  console.log("PASS invitation idempotency HTTP contract (controlled RPC fake)");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
