const { defineConfig } = require("@playwright/test");

const port = 3200;
const baseURL = `http://127.0.0.1:${port}`;
const safeEnvironment = {
  NODE_ENV: "test", // Next does not load .env.local in test mode.
  NEXT_TELEMETRY_DISABLED: "1",
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_ANON_KEY: "playwright-readonly",
  SUPABASE_SERVICE_ROLE_KEY: "playwright-readonly",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "playwright-readonly",
  E2E_SUPABASE_URL: "http://127.0.0.1:9",
  E2E_SUPABASE_ANON_KEY: "playwright-readonly",
  E2E_SUPABASE_SERVICE_ROLE_KEY: "playwright-readonly",
  E2E_WRITE_ENABLED: "0",
  HOUSEMATE_MVP_HOUSEHOLD_ID: "00000000-0000-4000-8000-000000000099",
  HOUSEMATE_MVP_MEMBER_ID: "00000000-0000-4000-8000-000000000099",
  HOUSEMATE_MVP_CONVERSATION_KEY: "e2e-readonly",
};

for (const name of [
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_ANON_KEY",
  "E2E_SUPABASE_SERVICE_ROLE_KEY",
  "E2E_ALLOWED_SUPABASE_PROJECT_REF",
  "E2E_HOUSEHOLD_ID",
  "E2E_ALLOWED_HOUSEHOLD_ID",
  "E2E_MEMBER_ID",
  "E2E_TEST_EMAIL",
  "E2E_TEST_PASSWORD",
  "E2E_NOTIFICATION_B_EMAIL",
  "E2E_NOTIFICATION_B_PASSWORD",
]) {
  // Playwright merges process.env before webServer.env: deletion is insufficient.
  safeEnvironment[name] = "";
}
for (const name of Object.keys(process.env)) {
  if (/^(E2E_|OPENAI_|WHATSAPP_)|^(DATABASE_URL|PGPASSWORD)$/.test(name) && !(name in safeEnvironment)) {
    safeEnvironment[name] = "";
  }
}
safeEnvironment.E2E_ALLOW_AUTH_USER_CREATE = "0";

module.exports = defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/expenses.editor.spec.cjs", "**/notifications.mocked.spec.cjs"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "test-results/readonly",
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
    env: safeEnvironment,
  },
});
