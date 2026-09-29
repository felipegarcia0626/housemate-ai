const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const { defineConfig } = require("@playwright/test");
const { readE2EContext } = require("./tests/e2e/fixtures.cjs");

const context = readE2EContext();
const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const webServerEnvironment = {
  ...process.env,
  SUPABASE_URL: context.supabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: context.serviceRoleKey,
  HOUSEMATE_MVP_HOUSEHOLD_ID: context.householdId,
  HOUSEMATE_MVP_MEMBER_ID: context.memberId,
};
delete webServerEnvironment.HOUSEMATE_MVP_CONVERSATION_KEY;

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "test-results",
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
    env: {
      ...webServerEnvironment,
    },
  },
});
