const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const serviceFile = path.join(root, "modules", "onboarding", "provisioning.service.ts");
const authFile = path.join(root, "infrastructure", "auth", "supabase-server.client.ts");
const databaseFile = path.join(root, "infrastructure", "database", "client.ts");
const authUserId = "60000000-0000-4000-8000-000000000001";

function loadService({ authUser = { id: authUserId }, rpcResult, rpcError } = {}) {
  const cache = new Map();
  function load(filename) {
    const resolved = path.resolve(filename);
    if (resolved === authFile) {
      class SupabaseAuthError extends Error {}
      return { SupabaseAuthError, getAuthenticatedAuthUser: async () => {
        if (!authUser) throw new SupabaseAuthError("unauthenticated");
        return authUser;
      } };
    }
    if (resolved === databaseFile) {
      return { getSupabaseAdminClient: () => ({ rpc: async (name, args) => {
        calls.push({ name, args });
        return { data: rpcResult, error: rpcError ?? null };
      } }) };
    }
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const loadedModule = { exports: {} };
    cache.set(resolved, loadedModule);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: resolved,
    }).outputText;
    const localRequire = (specifier) => {
      if (specifier.startsWith("@/")) return load(path.join(root, `${specifier.slice(2)}.ts`));
      if (specifier.startsWith(".")) return load(path.resolve(path.dirname(resolved), `${specifier}.ts`));
      return require(specifier);
    };
    new Function("require", "module", "exports", output)(localRequire, loadedModule, loadedModule.exports);
    return loadedModule.exports;
  }
  const calls = [];
  return { service: load(serviceFile), calls };
}

(async () => {
  const completed = loadService({ rpcResult: {
    status: "PROVISIONING_COMPLETED", userId: "u", householdId: "h", memberId: "m",
  } });
  const result = await completed.service.provisionAuthenticatedUser({ displayName: " Ana ", householdName: " Casa " });
  assert.equal(result.status, "PROVISIONING_COMPLETED");
  assert.equal(completed.calls[0].name, "fn_provision_authenticated_user");
  assert.equal(completed.calls[0].args.p_auth_user_id, authUserId);
  assert.equal(completed.calls[0].args.p_display_name, "Ana");
  assert.equal(completed.calls[0].args.p_household_name, "Casa");

  const already = loadService({ rpcResult: {
    status: "ALREADY_PROVISIONED", userId: "u", householdId: "h", memberId: "m",
  } });
  assert.equal((await already.service.provisionAuthenticatedUser({ displayName: "Ana", householdName: "Casa" })).status, "ALREADY_PROVISIONED");
  await assert.rejects(() => completed.service.provisionAuthenticatedUser({ displayName: " ", householdName: "Casa" }), /displayName is invalid/);
  await assert.rejects(() => loadService({ authUser: null }).service.provisionAuthenticatedUser({ displayName: "Ana", householdName: "Casa" }), /unauthenticated/i);
  console.log("PASS authenticated provisioning validates identity, input, RPC contract, and idempotent status");
})();
