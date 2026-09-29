const { defineConfig } = require("@playwright/test");

const port = 3000;
const baseURL = `http://localhost:${port}`;
const safeHouseholdId = "00000000-0000-4000-8000-000000000099";
const safeMemberId = "00000000-0000-4000-8000-000000000099";

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "test-results/mock",
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
    reuseExistingServer: true,
    env: {
      ...process.env,
      // Browser API calls are intercepted by the mock-only tests. These
      // values prevent Next.js from inheriting a real MVP/Supabase context.
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_SERVICE_ROLE_KEY: "playwright-mock-only",
      HOUSEMATE_MVP_HOUSEHOLD_ID: safeHouseholdId,
      HOUSEMATE_MVP_MEMBER_ID: safeMemberId,
      HOUSEMATE_MVP_CONVERSATION_KEY: "e2e-mock-only",
    },
  },
});
