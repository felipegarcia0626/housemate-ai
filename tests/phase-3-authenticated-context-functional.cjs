const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const serviceModule = path.join(
  root,
  "modules",
  "context",
  "authenticated-context.service.ts",
);
const authModule = path.join(
  root,
  "infrastructure",
  "auth",
  "supabase-server.client.ts",
);
const repositoryModule = path.join(
  root,
  "modules",
  "context",
  "authenticated-context.repository.ts",
);

const authUserId = "50000000-0000-4000-8000-000000000001";
const userId = "50000000-0000-4000-8000-000000000002";
const householdA = "50000000-0000-4000-8000-000000000003";
const householdB = "50000000-0000-4000-8000-000000000004";
const memberA = "50000000-0000-4000-8000-000000000005";
const memberB = "50000000-0000-4000-8000-000000000006";

function resolveTypeScriptModule(specifier, parentFile) {
  if (specifier.startsWith("@/")) {
    return path.join(root, `${specifier.slice(2)}.ts`);
  }
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(parentFile), `${specifier}.ts`);
  }
  return null;
}

function loadTypeScriptModuleFactory({
  authUser,
  applicationUser,
  memberships,
  useRealAuth = false,
  realAuthResponse,
  useRealRepository = false,
  repositoryResponse,
}) {
  const moduleCache = new Map();

  function loadTypeScriptModule(filename) {
    const resolved = path.resolve(filename);

    if (resolved === authModule && !useRealAuth) {
      return {
        SupabaseAuthError: class SupabaseAuthError extends Error {},
        getAuthenticatedAuthUser: async () => authUser,
      };
    }
    if (resolved === repositoryModule && !useRealRepository) {
      return {
        AuthenticatedContextRepositoryError: class AuthenticatedContextRepositoryError extends Error {},
        findApplicationUserByAuthUserId: async () => applicationUser,
        findActiveMembershipsByUserId: async () => memberships,
      };
    }
    if (moduleCache.has(resolved)) {
      return moduleCache.get(resolved).exports;
    }

    const loadedModule = { exports: {} };
    moduleCache.set(resolved, loadedModule);
    const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
      fileName: resolved,
    }).outputText;

    const localRequire = (specifier) => {
      if (useRealAuth && specifier === "@supabase/ssr") {
        return {
          createServerClient: () => ({
            auth: {
              getUser: async () => realAuthResponse,
            },
          }),
        };
      }
      if (useRealAuth && specifier === "next/headers") {
        return {
          cookies: async () => ({
            getAll: () => [],
            set: () => undefined,
          }),
        };
      }
      if (
        useRealRepository &&
        specifier === "@/infrastructure/database/client"
      ) {
        return {
          getSupabaseAdminClient: () => ({
            from: (table) => {
              const result =
                typeof repositoryResponse === "function"
                  ? repositoryResponse(table)
                  : repositoryResponse;
              const query = {
                select() {
                  return query;
                },
                eq() {
                  return query;
                },
                maybeSingle: async () => result,
                then(resolve, reject) {
                  return Promise.resolve(result).then(resolve, reject);
                },
              };
              return query;
            },
          }),
        };
      }
      const typescriptModule = resolveTypeScriptModule(specifier, resolved);
      return typescriptModule
        ? loadTypeScriptModule(typescriptModule)
        : require(specifier);
    };

    new Function("require", "module", "exports", output)(
      localRequire,
      loadedModule,
      loadedModule.exports,
    );
    return loadedModule.exports;
  }

  return loadTypeScriptModule;
}

async function expectError(resolve, expectedCode) {
  await assert.rejects(resolve, (error) => {
    assert.equal(error.code, expectedCode);
    return true;
  });
}

async function main() {
  const applicationUser = { id: userId, authUserId };
  const oneMembership = [{ householdId: householdA, memberId: memberA }];

  const load = loadTypeScriptModuleFactory({
    authUser: null,
    applicationUser: null,
    memberships: [],
  });
  const { resolveAuthenticatedContext } = load(serviceModule);

  const {
    AuthSessionMissingError,
    AuthApiError,
  } = require("@supabase/supabase-js");
  const previousSupabaseUrl = process.env.SUPABASE_URL;
  const previousSupabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY ??= "test-anon-key";

  const expectRealAuthError = async (getUserResult, expectedCode) => {
    const authLoad = loadTypeScriptModuleFactory({
      applicationUser: null,
      authUser: null,
      memberships: [],
      realAuthResponse: getUserResult,
      useRealAuth: true,
    });
    const { getAuthenticatedAuthUser } = authLoad(authModule);
    await expectError(getAuthenticatedAuthUser, expectedCode);
  };

  await expectRealAuthError(
    {
      data: { user: null },
      error: new AuthSessionMissingError(),
    },
    "UNAUTHENTICATED",
  );
  console.log("PASS AuthSessionMissingError is classified as unauthenticated");

  await expectRealAuthError(
    {
      data: { user: null },
      error: new AuthApiError("token expired", 401, "invalid_token"),
    },
    "UNAUTHENTICATED",
  );
  console.log("PASS expired or invalid auth tokens are unauthenticated");

  await expectRealAuthError(
    {
      data: { user: null },
      error: new AuthApiError("provider unavailable", 500, "server_error"),
    },
    "AUTH_PROVIDER_ERROR",
  );
  console.log("PASS provider errors remain provider errors");

  const realAuthLoad = loadTypeScriptModuleFactory({
    applicationUser,
    authUser: null,
    memberships: oneMembership,
    realAuthResponse: {
      data: { user: { id: authUserId } },
      error: null,
    },
    useRealAuth: true,
  });
  const { getAuthenticatedAuthUser } = realAuthLoad(authModule);
  const { resolveAuthenticatedContext: resolveWithRealAuth } =
    realAuthLoad(serviceModule);
  const resolvedWithRealAuth = await resolveWithRealAuth({
    getAuthenticatedAuthUser,
    findApplicationUserByAuthUserId: async () => applicationUser,
    findActiveMembershipsByUserId: async () => oneMembership,
  });
  assert.equal(resolvedWithRealAuth.authUserId, authUserId);
  assert.equal(resolvedWithRealAuth.householdId, householdA);
  console.log(
    "PASS valid Supabase user reaches application context resolution",
  );

  const persistenceLoad = loadTypeScriptModuleFactory({
    applicationUser,
    authUser: null,
    memberships: oneMembership,
    repositoryResponse: {
      data: null,
      error: { message: "database unavailable" },
    },
    useRealRepository: true,
  });
  const persistenceRepository = persistenceLoad(repositoryModule);
  const { resolveAuthenticatedContext: resolveWithRealRepository } =
    persistenceLoad(serviceModule);
  await expectError(
    () =>
      resolveWithRealRepository({
        getAuthenticatedAuthUser: async () => ({ id: authUserId }),
        findApplicationUserByAuthUserId:
          persistenceRepository.findApplicationUserByAuthUserId,
        findActiveMembershipsByUserId:
          persistenceRepository.findActiveMembershipsByUserId,
      }),
    "PERSISTENCE_ERROR",
  );
  console.log(
    "PASS real application persistence errors map to PERSISTENCE_ERROR",
  );

  const membershipRepositoryResponse = (table) =>
    table === "tb_users"
      ? {
          data: { id: userId, auth_user_id: authUserId },
          error: null,
        }
      : {
          data: null,
          error: { message: "database unavailable" },
        };
  const membershipPersistenceLoad = loadTypeScriptModuleFactory({
    applicationUser,
    authUser: null,
    memberships: oneMembership,
    repositoryResponse: membershipRepositoryResponse,
    useRealRepository: true,
  });
  const membershipPersistenceRepository =
    membershipPersistenceLoad(repositoryModule);
  const { resolveAuthenticatedContext: resolveWithMembershipRepository } =
    membershipPersistenceLoad(serviceModule);
  await expectError(
    () =>
      resolveWithMembershipRepository({
        getAuthenticatedAuthUser: async () => ({ id: authUserId }),
        findApplicationUserByAuthUserId:
          membershipPersistenceRepository.findApplicationUserByAuthUserId,
        findActiveMembershipsByUserId:
          membershipPersistenceRepository.findActiveMembershipsByUserId,
      }),
    "PERSISTENCE_ERROR",
  );
  console.log("PASS membership persistence errors are not treated as empty");

  await expectError(
    () =>
      resolveAuthenticatedContext({
        getAuthenticatedAuthUser: async () => null,
        findApplicationUserByAuthUserId: async () => null,
        findActiveMembershipsByUserId: async () => [],
      }),
    "UNAUTHENTICATED",
  );
  console.log("PASS unauthenticated users are rejected");

  await expectError(
    () =>
      resolveAuthenticatedContext({
        getAuthenticatedAuthUser: async () => ({ id: authUserId }),
        findApplicationUserByAuthUserId: async (receivedAuthUserId) => {
          assert.equal(receivedAuthUserId, authUserId);
          return null;
        },
        findActiveMembershipsByUserId: async () => [],
      }),
    "APPLICATION_USER_NOT_FOUND",
  );
  console.log("PASS Auth user without tb_users linkage is rejected");

  const resolved = await resolveAuthenticatedContext({
    getAuthenticatedAuthUser: async () => ({ id: authUserId }),
    findApplicationUserByAuthUserId: async () => applicationUser,
    findActiveMembershipsByUserId: async (receivedUserId) => {
      assert.equal(receivedUserId, userId);
      return oneMembership;
    },
  });
  assert.deepEqual(resolved, {
    authUserId,
    userId,
    householdId: householdA,
    memberId: memberA,
    source: "web",
  });
  assert.equal(Object.isFrozen(resolved), true);
  resolved.householdId = householdB;
  assert.equal(resolved.householdId, householdA);
  console.log(
    "PASS one membership resolves an immutable authenticated context",
  );

  await expectError(
    () =>
      resolveAuthenticatedContext({
        getAuthenticatedAuthUser: async () => ({ id: authUserId }),
        findApplicationUserByAuthUserId: async () => applicationUser,
        findActiveMembershipsByUserId: async () => [],
      }),
    "NO_ACTIVE_MEMBERSHIP",
  );
  console.log("PASS users without memberships are rejected");

  const selected = await resolveAuthenticatedContext({
    getAuthenticatedAuthUser: async () => ({ id: authUserId }),
    findApplicationUserByAuthUserId: async () => applicationUser,
    findActiveMembershipsByUserId: async () => [
      ...oneMembership,
      { householdId: householdB, memberId: memberB },
    ],
    getSelectedHouseholdId: async () => householdB,
  });
  assert.equal(selected.householdId, householdB);
  assert.equal(selected.memberId, memberB);
  console.log("PASS valid household selection resolves matching member");

  await assert.rejects(
    () =>
      resolveAuthenticatedContext({
        getAuthenticatedAuthUser: async () => ({ id: authUserId }),
        findApplicationUserByAuthUserId: async () => applicationUser,
        findActiveMembershipsByUserId: async () => [
          ...oneMembership,
          { householdId: householdB, memberId: memberB },
        ],
      }),
    (error) => {
      assert.equal(error.code, "HOUSEHOLD_SELECTION_REQUIRED");
      assert.equal(error.membershipCount, 2);
      return true;
    },
  );
  console.log("PASS multiple memberships require explicit household selection");

  let receivedAuthUserId;
  const externalHouseholdId = "50000000-0000-4000-8000-000000000099";
  const externalAttempt = await resolveAuthenticatedContext({
    householdId: externalHouseholdId,
    getAuthenticatedAuthUser: async () => ({ id: authUserId }),
    findApplicationUserByAuthUserId: async (received) => {
      receivedAuthUserId = received;
      return applicationUser;
    },
    findActiveMembershipsByUserId: async () => oneMembership,
  });
  assert.equal(receivedAuthUserId, authUserId);
  assert.notEqual(externalAttempt.householdId, externalHouseholdId);
  assert.equal(externalAttempt.householdId, householdA);
  console.log(
    "PASS external household input cannot select authenticated context",
  );

  if (previousSupabaseUrl === undefined) {
    delete process.env.SUPABASE_URL;
  } else {
    process.env.SUPABASE_URL = previousSupabaseUrl;
  }
  if (previousSupabaseAnonKey === undefined) {
    delete process.env.SUPABASE_ANON_KEY;
  } else {
    process.env.SUPABASE_ANON_KEY = previousSupabaseAnonKey;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
