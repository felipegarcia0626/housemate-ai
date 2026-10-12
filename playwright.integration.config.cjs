// Playwright runs globalSetup BEFORE collecting specs. Reject integration here,
// before dotenv, server startup or the expense fixture can perform any work.
const { assertRecoverableE2EOperation } = require("./tests/e2e/fixtures.cjs");
assertRecoverableE2EOperation("integration");

const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const { defineConfig } = require("@playwright/test");
const { assertWriteE2EContext } = require("./tests/e2e/fixtures.cjs");

const context = assertWriteE2EContext();
const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const webServerEnvironment = {
  ...process.env,
  SUPABASE_URL: context.supabaseUrl,
  SUPABASE_ANON_KEY: context.anonKey,
  SUPABASE_SERVICE_ROLE_KEY: context.serviceRoleKey,
  NEXT_PUBLIC_SUPABASE_URL: context.supabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: context.anonKey,
  HOUSEMATE_MVP_HOUSEHOLD_ID: context.householdId,
  HOUSEMATE_MVP_MEMBER_ID: context.memberId,
};
delete webServerEnvironment.HOUSEMATE_MVP_CONVERSATION_KEY;
for (const name of [
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_ANON_KEY",
  "E2E_SUPABASE_SERVICE_ROLE_KEY",
  "E2E_WRITE_ENABLED",
  "E2E_ALLOW_AUTH_USER_CREATE",
  "E2E_ALLOWED_SUPABASE_PROJECT_REF",
  "E2E_HOUSEHOLD_ID",
  "E2E_ALLOWED_HOUSEHOLD_ID",
  "E2E_MEMBER_ID",
  "E2E_TEST_EMAIL",
  "E2E_TEST_PASSWORD",
  "E2E_NOTIFICATION_B_EMAIL",
  "E2E_NOTIFICATION_B_PASSWORD",
]) {
  delete webServerEnvironment[name];
}

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "test-results/integration",
  globalSetup: "./tests/e2e/global-setup.cjs",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
    env: webServerEnvironment,
  },
});
