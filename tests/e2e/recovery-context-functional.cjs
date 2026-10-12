const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
let clientConstructions = 0;
const filesystemCalls = [];

Module._load = function (name, ...args) {
  if (name === "@supabase/supabase-js") {
    return {
      createClient() {
        clientConstructions += 1;
        throw new Error("ADMIN_CLIENT_CONSTRUCTION_FORBIDDEN");
      },
    };
  }
  if (name === "node:fs/promises") {
    return Object.fromEntries(
      ["mkdir", "writeFile", "rm"].map((method) => [method, async (...values) => {
        filesystemCalls.push([method, ...values]);
        throw new Error("FILESYSTEM_MUTATION_FORBIDDEN");
      }]),
    );
  }
  return originalLoad.call(this, name, ...args);
};

let fixtures;
try {
  fixtures = require("./fixtures.cjs");
} finally {
  Module._load = originalLoad;
}

const { assertRecoverableE2EOperation, recordReturnedResourceIds, requireAdministrativeRecovery } = fixtures;
const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "00000000-0000-4000-8000-000000000104";

for (const operation of ["agent", "notifications", "unknown"]) {
  assert.throws(() => assertRecoverableE2EOperation(operation), /E2E_RECOVERY_BLOCKED/);
}

const references = [];
recordReturnedResourceIds({ data: { proposalId: firstId.toUpperCase(), expenseId: secondId } }, references);
recordReturnedResourceIds({ data: { proposalId: firstId } }, references);
assert.deepEqual(references, [
  { table: "tb_pending_proposals", id: firstId },
  { table: "tb_expenses", id: secondId },
]);
assert.throws(() => requireAdministrativeRecovery(references), /No automatic deletion attempted/);
assert.throws(() => requireAdministrativeRecovery([], true), /unidentified resources/);
assert.doesNotThrow(() => requireAdministrativeRecovery([]));

const partialReferences = [];
assert.throws(
  () => recordReturnedResourceIds({ data: { proposalId: "invalid", expenseId: firstId } }, partialReferences),
  /proposalId must be a valid UUID/,
);
assert.deepEqual(partialReferences, [{ table: "tb_expenses", id: firstId }]);
assert.equal(clientConstructions, 0, "pure recovery contracts must not create an administrative client");
assert.deepEqual(filesystemCalls, [], "pure recovery contracts must not mutate local files");

console.log("PASS E2E recovery reference contracts (local only)");
