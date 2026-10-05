const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const { createClient } = require("@supabase/supabase-js");

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

async function main() {
  const email = required("E2E_TEST_EMAIL").toLowerCase();
  const password = required("E2E_TEST_PASSWORD");
  const admin = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const existing = await findUser(admin, email);
  const result = existing
    ? await admin.auth.admin.updateUserById(existing.id, {
        password,
        email_confirm: true,
      })
    : await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
  if (result.error || !result.data.user) throw new Error("E2E provisioning could not prepare the Auth user.");
  console.log("E2E test user ready");
  console.log(`email: ${email}`);
  console.log(`userId: ${result.data.user.id}`);
  console.log("Provisioning through the authenticated onboarding flow is performed by npm run test:e2e:agent.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "E2E provisioning failed.");
  process.exitCode = 1;
});
