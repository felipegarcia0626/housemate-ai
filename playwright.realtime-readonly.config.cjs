const { loadEnvConfig } = require("@next/env");
const { defineConfig } = require("@playwright/test");

const originalNodeEnv = process.env.NODE_ENV;
try {
  if (originalNodeEnv === "test") process.env.NODE_ENV = "development";
  loadEnvConfig(__dirname, true);
} finally {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Realtime subscription E2E requires ${name}.`);
  return value;
}

function rejectKnownAdministrativeKey(key) {
  const configuredAdministrativeKeys = [
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ].map((value) => value?.trim()).filter(Boolean);
  if (configuredAdministrativeKeys.includes(key) || key.startsWith("sb_secret_")) {
    throw new Error("Realtime subscription E2E requires a confirmed public Supabase key.");
  }

  const segments = key.split(".");
  if (segments.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
      if (payload?.role === "service_role") {
        throw new Error("Realtime subscription E2E requires a confirmed public Supabase key.");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Realtime subscription E2E requires a confirmed public Supabase key.") throw error;
    }
  }
}

const supabaseUrl = required("E2E_SUPABASE_URL");
const allowedProjectRef = required("E2E_ALLOWED_SUPABASE_PROJECT_REF").toLowerCase();
const anonKey = required("E2E_SUPABASE_ANON_KEY");
rejectKnownAdministrativeKey(anonKey);
for (const name of [
  "E2E_TEST_EMAIL", "E2E_TEST_PASSWORD",
  "E2E_NOTIFICATION_B_EMAIL", "E2E_NOTIFICATION_B_PASSWORD",
]) required(name);

let supabase;
try {
  supabase = new URL(supabaseUrl);
} catch {
  throw new Error("E2E_SUPABASE_URL must be a valid HTTPS Supabase project URL.");
}
const suffix = ".supabase.co";
const projectRef = supabase.hostname.toLowerCase().endsWith(suffix)
  ? supabase.hostname.slice(0, -suffix.length).toLowerCase()
  : "";
if (
  supabase.protocol !== "https:" || supabase.username || supabase.password ||
  (supabase.pathname !== "/" && supabase.pathname !== "") || supabase.search || supabase.hash ||
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectRef) ||
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(allowedProjectRef) ||
  projectRef !== allowedProjectRef
) {
  throw new Error("Realtime subscription E2E destination does not match the explicit allowed project ref.");
}

const port = 3210;
const baseURL = `http://127.0.0.1:${port}`;
const webServerEnvironment = {
  NODE_ENV: "test",
  NEXT_TELEMETRY_DISABLED: "1",
  SUPABASE_URL: supabaseUrl,
  SUPABASE_ANON_KEY: anonKey,
  SUPABASE_SERVICE_ROLE_KEY: "",
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
  E2E_WRITE_ENABLED: "0",
  E2E_SUPABASE_URL: "",
  E2E_SUPABASE_ANON_KEY: "",
  E2E_SUPABASE_SERVICE_ROLE_KEY: "",
  E2E_ALLOWED_SUPABASE_PROJECT_REF: "",
  E2E_HOUSEHOLD_ID: "",
  E2E_ALLOWED_HOUSEHOLD_ID: "",
  E2E_MEMBER_ID: "",
  E2E_TEST_EMAIL: "",
  E2E_TEST_PASSWORD: "",
  E2E_NOTIFICATION_B_EMAIL: "",
  E2E_NOTIFICATION_B_PASSWORD: "",
  E2E_AGENT_HOUSEHOLD_ID: "",
  DATABASE_URL: "",
  PGPASSWORD: "",
  OPENAI_API_KEY: "",
  WHATSAPP_ACCESS_TOKEN: "",
  HOUSEMATE_MVP_HOUSEHOLD_ID: "00000000-0000-4000-8000-000000000099",
  HOUSEMATE_MVP_MEMBER_ID: "00000000-0000-4000-8000-000000000099",
};
for (const name of Object.keys(process.env)) {
  if (/^(E2E_|OPENAI_|WHATSAPP_)/.test(name) && !(name in webServerEnvironment)) {
    webServerEnvironment[name] = "";
  }
}

module.exports = defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/notifications-realtime-subscription.spec.cjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 25_000 },
  reporter: "list",
  outputDir: "test-results/realtime-subscription-readonly",
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: false,
    env: webServerEnvironment,
  },
});
