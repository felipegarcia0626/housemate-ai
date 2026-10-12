const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const {
  assertWriteE2EContext,
  createE2EClient,
  assertRecoverableE2EOperation,
} = require("./fixtures.cjs");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`E2E provisioning requires ${name}`);
  return value;
}

async function findUser(admin, email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error("E2E provisioning could not list Auth users.");
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user;
    if (data.users.length < 100) return null;
  }
  throw new Error("E2E provisioning could not locate the dedicated user.");
}

async function createE2EAuthUser(context, email, password) {
  assertRecoverableE2EOperation("unknown");
  const admin = createE2EClient(context);
  const result = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (result.error || !result.data.user) throw new Error("E2E provisioning could not prepare the Auth user.");
  return result.data.user;
}

async function main() {
  const writeContext = assertWriteE2EContext();
  const email = required("E2E_TEST_EMAIL").toLowerCase();
  const creationEnabled = process.env.E2E_ALLOW_AUTH_USER_CREATE === "1";
  const admin = createE2EClient(writeContext);
  const existing = await findUser(admin, email);
  if (existing) {
    console.log("E2E Auth user already exists; no persistent user update performed.");
    return;
  }
  if (!creationEnabled) {
    throw new Error(
      "E2E Auth user creation is disabled; an administrator must explicitly enable creation for the isolated project.",
    );
  }
  assertRecoverableE2EOperation("unknown");
  const password = required("E2E_TEST_PASSWORD");
  const createdUser = await createE2EAuthUser(writeContext, email, password);
  console.log("E2E test user ready");
  console.log(`email: ${email}`);
  console.log(`userId: ${createdUser.id}`);
  console.log("Provisioning through the authenticated onboarding flow is performed by npm run test:e2e:agent.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "E2E provisioning failed.");
    process.exitCode = 1;
  });
}

module.exports = { findUser, createE2EAuthUser, main };
