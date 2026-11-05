"use strict";

// Real HTTP integration for the Web JWT path. This harness never starts or
// stops Supabase, never loads .env files, and refuses any non-loopback target.
// It deliberately does not alter the existing E2E_RECOVERY_BLOCKED guard.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createServerClient } = require("@supabase/ssr");
const { createClient } = require("@supabase/supabase-js");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "..");
const LOCAL_PROJECT =
  "C:\\Users\\user\\Documents\\Codex\\housemate-jwt-local-nomigrations-20261101";
const LOCAL_PROJECT_ID = "housemate-jwt-local-nomigrations-20261101";
const LOCAL_DOCKER_PROJECT_LABEL = LOCAL_PROJECT_ID.slice(0, 40);
const LOCAL_API_ORIGIN = "http://127.0.0.1:54321";
const LOCAL_DB_PORT = 54322;
const EXPECTED_PORTS = new Set([54321, 54322, 54323, 54324, 54327]);
const DEFAULT_SUPABASE_CLI_PATH =
  "C:\\Users\\user\\AppData\\Local\\Temp\\housemate-jwt-local-prep-20261101\\node_modules\\@supabase\\cli-windows-x64\\bin\\supabase.exe";
const DOCKER_CLI =
  "C:\\Users\\user\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe";
const REQUEST_MESSAGE = "Registra una operación de prueba";
const REQUEST_ID_PREFIX = "e2e-";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"]);
const TEST_ONLY_INTERPRETATION = {
  kind: "AMBIGUOUS_MOVEMENT",
  merchant: null,
  description: "JWT integration test only",
  totalAmount: "test-only",
  expenseDate: null,
  paidBySelf: null,
  paidByMemberName: null,
  categoryName: null,
  splitRequested: false,
  splitInstructions: null,
  amount: null,
  date: null,
  incomeDate: null,
  incomeDescription: null,
  correctionField: null,
  correctionValue: null,
  filters: null,
};

class HarnessFailure extends Error {
  constructor(code, phase = "test", safeDetail = null) {
    super(code);
    this.code = code;
    this.phase = phase;
    this.safeDetail = safeDetail;
  }
}

function requireCondition(condition, code, phase = "test") {
  if (!condition) throw new HarnessFailure(code, phase);
}

function safeChildEnvironment(extra = {}) {
  const env = {};
  for (const key of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "ComSpec",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function resolveSupabaseCli() {
  const explicitPath = process.env.HOUSEMATE_LOCAL_SUPABASE_CLI_PATH;
  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, "supabase.exe"));
  const candidates = [
    ...(explicitPath ? [explicitPath] : []),
    ...pathCandidates,
    DEFAULT_SUPABASE_CLI_PATH,
  ];

  return candidates.find(
    (candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate),
  );
}

function runCommand(file, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env ?? safeChildEnvironment(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ exitCode: null, spawnFailed: true, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      return next.length > 256_000 ? next.slice(-256_000) : next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      resolve({ exitCode: null, timedOut: true, stdout, stderr });
    }, options.timeoutMs ?? 15_000);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, spawnFailed: true, stdout, stderr });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function normalizedPath(value) {
  return path
    .resolve(value)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function parseConfigBoolean(configText, sectionName, keyName) {
  const lines = configText.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (section) {
      inSection = section[1] === sectionName;
      continue;
    }
    if (!inSection) continue;
    const match = new RegExp(
      `^\\s*${keyName}\\s*=\\s*(true|false)\\s*(?:#.*)?$`,
    ).exec(line);
    if (match) return match[1] === "true";
  }
  return null;
}

function parseTopLevelConfigString(configText, keyName) {
  for (const line of configText.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = new RegExp(`^\\s*${keyName}\\s*=\\s*"([^"\\r\\n]+)"`).exec(
      line,
    );
    if (match) return match[1];
  }
  return null;
}

function parseEnvironmentOutput(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  const pick = (...names) =>
    names.map((name) => values.get(name)).find(Boolean);
  return {
    apiUrl: pick("API_URL", "SUPABASE_URL"),
    anonKey: pick("ANON_KEY", "SUPABASE_ANON_KEY"),
    serviceRoleKey: pick("SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
    dbUrl: pick("DB_URL", "DATABASE_URL"),
  };
}

function assertLoopbackApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HarnessFailure("local_api_url_invalid", "preflight");
  }
  requireCondition(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "54321" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password,
    "local_api_not_exact_loopback",
    "preflight",
  );
  return url.origin;
}

function assertLoopbackDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HarnessFailure("local_database_url_invalid", "preflight");
  }
  requireCondition(
    (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      LOOPBACK_ADDRESSES.has(url.hostname) &&
      url.port === String(LOCAL_DB_PORT) &&
      decodeURIComponent(url.pathname.replace(/^\//, "")) === "postgres" &&
      decodeURIComponent(url.username) === "postgres",
    "local_database_not_exact_loopback",
    "preflight",
  );
  return url.toString();
}

async function verifyDockerAndPortBindings() {
  requireCondition(
    fs.existsSync(DOCKER_CLI),
    "docker_cli_missing",
    "preflight",
  );
  const info = await runCommand(
    DOCKER_CLI,
    ["info", "--format", "{{.ServerVersion}}"],
    {
      timeoutMs: 12_000,
    },
  );
  requireCondition(
    info.exitCode === 0,
    "docker_engine_unavailable",
    "preflight",
  );

  const listing = await runCommand(
    DOCKER_CLI,
    [
      "ps",
      "--all",
      "--format",
      '{{.ID}}|{{.Names}}|{{.State}}|{{.Label "com.supabase.cli.workdir"}}|{{.Label "com.supabase.cli.project"}}',
    ],
    { timeoutMs: 12_000 },
  );
  requireCondition(
    listing.exitCode === 0,
    "docker_container_inventory_unavailable",
    "preflight",
  );
  const matching = listing.stdout
    .split(/\r?\n/)
    .map((line) => line.split("|"))
    .filter(
      (parts) =>
        parts.length >= 5 &&
        parts[0] &&
        normalizedPath(parts[3]) === normalizedPath(LOCAL_PROJECT) &&
        parts[4] === LOCAL_DOCKER_PROJECT_LABEL,
    );
  requireCondition(
    matching.length > 0,
    "local_supabase_stack_not_identifiable",
    "preflight",
  );
  const statesByName = new Map(matching.map((parts) => [parts[1], parts[2]]));
  const requiredContainerNames = ["db", "auth", "rest", "kong"].map(
    (service) => `supabase_${service}_${LOCAL_DOCKER_PROJECT_LABEL}`,
  );
  requireCondition(
    requiredContainerNames.every(
      (name) => statesByName.get(name) === "running",
    ),
    "local_supabase_stack_not_fully_running",
    "preflight",
  );

  const bindings = [];
  for (const [id] of matching) {
    const inspected = await runCommand(
      DOCKER_CLI,
      ["inspect", id, "--format", "{{json .NetworkSettings.Ports}}"],
      { timeoutMs: 10_000 },
    );
    requireCondition(
      inspected.exitCode === 0,
      "docker_port_inspection_failed",
      "preflight",
    );
    let portBindings;
    try {
      portBindings = JSON.parse(inspected.stdout.trim());
    } catch {
      throw new HarnessFailure(
        "docker_port_inspection_unparseable",
        "preflight",
      );
    }
    for (const [containerPort, hostRows] of Object.entries(
      portBindings ?? {},
    )) {
      for (const binding of hostRows ?? []) {
        requireCondition(
          binding && LOOPBACK_ADDRESSES.has(binding.HostIp),
          "non_loopback_or_unknown_host_binding",
          "preflight",
        );
        const hostPort = Number(binding.HostPort);
        requireCondition(
          Number.isInteger(hostPort) && hostPort > 0,
          "host_port_unverifiable",
          "preflight",
        );
        bindings.push({ containerPort, hostIp: binding.HostIp, hostPort });
      }
    }
  }
  requireCondition(
    bindings.length > 0,
    "local_supabase_has_no_verified_port_bindings",
    "preflight",
  );
  const boundPorts = new Set(bindings.map((item) => item.hostPort));
  for (const expectedPort of EXPECTED_PORTS) {
    requireCondition(
      boundPorts.has(expectedPort),
      "expected_local_port_not_published",
      "preflight",
    );
  }

  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  requireCondition(
    fs.existsSync(powershell),
    "listener_inspector_unavailable",
    "preflight",
  );
  const portList = [...boundPorts].join(",");
  const command = `$ports=@(${portList}); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports } | Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress`;
  const listeners = await runCommand(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeoutMs: 30_000 },
  );
  requireCondition(
    listeners.exitCode === 0,
    "listener_inspection_failed",
    "preflight",
  );
  let rows = [];
  if (listeners.stdout.trim()) {
    try {
      const parsed = JSON.parse(listeners.stdout.trim());
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new HarnessFailure("listener_inspection_unparseable", "preflight");
    }
  }
  for (const row of rows) {
    requireCondition(
      LOOPBACK_ADDRESSES.has(row.LocalAddress) &&
        boundPorts.has(Number(row.LocalPort)),
      "non_loopback_or_unknown_host_listener",
      "preflight",
    );
  }
  for (const binding of bindings) {
    requireCondition(
      rows.some(
        (row) =>
          row.LocalAddress === binding.hostIp &&
          Number(row.LocalPort) === binding.hostPort,
      ),
      "published_port_listener_not_verified",
      "preflight",
    );
  }
  return bindings;
}

async function readLocalRuntimeEnvironment() {
  const configPath = path.join(LOCAL_PROJECT, "supabase", "config.toml");
  requireCondition(
    fs.existsSync(configPath),
    "local_project_config_missing",
    "preflight",
  );
  const config = fs.readFileSync(configPath, "utf8");
  requireCondition(
    parseTopLevelConfigString(config, "project_id") === LOCAL_PROJECT_ID,
    "unexpected_local_supabase_project_id",
    "preflight",
  );
  requireCondition(
    parseConfigBoolean(config, "db.migrations", "enabled") === false,
    "housemate_migrations_not_disabled",
    "preflight",
  );
  requireCondition(
    parseConfigBoolean(config, "db.seed", "enabled") === false,
    "housemate_seeds_not_disabled",
    "preflight",
  );
  requireCondition(
    !fs.existsSync(
      path.join(LOCAL_PROJECT, "supabase", ".temp", "project-ref"),
    ),
    "remote_supabase_link_metadata_present",
    "preflight",
  );
  const supabaseCli = resolveSupabaseCli();
  requireCondition(Boolean(supabaseCli), "supabase_cli_missing", "preflight");
  const version = await runCommand(supabaseCli, ["--version"], {
    timeoutMs: 10_000,
  });
  requireCondition(
    version.exitCode === 0 && version.stdout.includes("2.121.0"),
    "supabase_cli_version_unexpected",
    "preflight",
  );
  const status = await runCommand(
    supabaseCli,
    ["status", "--workdir", LOCAL_PROJECT, "-o", "env"],
    { timeoutMs: 20_000 },
  );
  requireCondition(
    status.exitCode === 0,
    "supabase_local_status_unavailable",
    "preflight",
  );
  const runtime = parseEnvironmentOutput(status.stdout);
  runtime.apiUrl = assertLoopbackApiUrl(runtime.apiUrl);
  runtime.dbUrl = assertLoopbackDatabaseUrl(runtime.dbUrl);
  requireCondition(
    typeof runtime.anonKey === "string" &&
      runtime.anonKey.length > 0 &&
      typeof runtime.serviceRoleKey === "string" &&
      runtime.serviceRoleKey.length > 0,
    "local_supabase_runtime_keys_missing",
    "preflight",
  );
  return runtime;
}

async function readOnlyQuery(client, sql, values = []) {
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query(sql, values);
    await client.query("ROLLBACK");
    return result;
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw new HarnessFailure("local_read_only_query_failed", "preflight");
  }
}

async function verifyLocalServices(runtime, database) {
  const authHealth = await fetch(`${runtime.apiUrl}/auth/v1/health`, {
    method: "GET",
    headers: { apikey: runtime.anonKey },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  requireCondition(
    authHealth && authHealth.status >= 200 && authHealth.status < 400,
    "local_auth_unavailable",
    "preflight",
  );

  const restHealth = await fetch(`${runtime.apiUrl}/rest/v1/`, {
    method: "GET",
    headers: { apikey: runtime.anonKey },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  requireCondition(
    restHealth && restHealth.status >= 200 && restHealth.status < 400,
    "local_postgrest_unavailable",
    "preflight",
  );

  const check = await readOnlyQuery(
    database,
    `WITH web_fn AS (
       SELECT p.oid, p.proowner, p.prosecdef, p.proconfig, p.proacl
       FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure(
         'public.fn_create_web_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status)'
       )
     ), helper AS (
       SELECT p.oid, p.proowner, p.prosecdef, p.proconfig
       FROM pg_catalog.pg_proc p
       WHERE p.oid = pg_catalog.to_regprocedure('public.fn_require_web_financial_context(uuid,uuid)')
     ), draft_table AS (
       SELECT c.oid, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'tb_agent_category_drafts'
     ), legacy_draft_functions AS (
       SELECT p.oid, p.proowner, p.proacl
       FROM pg_catalog.pg_proc p
       WHERE p.oid IN (
         pg_catalog.to_regprocedure('public.fn_create_whatsapp_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status,uuid,uuid,bigint)'),
         pg_catalog.to_regprocedure('public.fn_update_whatsapp_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status,timestamptz,uuid,uuid,bigint)'),
         pg_catalog.to_regprocedure('public.fn_delete_whatsapp_agent_draft(uuid,uuid,uuid,text,timestamptz,uuid,uuid,bigint)')
       )
     ), whatsapp_draft_wrappers AS (
       SELECT p.oid, p.proowner, p.proacl
       FROM pg_catalog.pg_proc p
       WHERE p.oid IN (
         pg_catalog.to_regprocedure('public.fn_create_whatsapp_draft_event(text,uuid,bigint,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status)'),
         pg_catalog.to_regprocedure('public.fn_update_whatsapp_draft_event(text,uuid,bigint,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status,timestamptz)'),
         pg_catalog.to_regprocedure('public.fn_delete_whatsapp_draft_event(text,uuid,bigint,uuid,text,timestamptz)')
       )
     )
     SELECT
       pg_catalog.to_regclass('auth.users') IS NOT NULL AS auth_users_present,
       pg_catalog.to_regclass('public.tb_users') IS NOT NULL AS app_users_present,
       pg_catalog.to_regclass('public.tb_household_members') IS NOT NULL AS memberships_present,
       pg_catalog.to_regclass('public.tb_agent_category_drafts') IS NOT NULL AS drafts_present,
       (SELECT count(*) = 1 FROM web_fn) AS web_function_present,
       (SELECT pg_catalog.pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM web_fn) AS web_function_hardened,
       (SELECT pg_catalog.pg_get_functiondef(oid) FROM web_fn) AS web_definition,
       (SELECT pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE') FROM web_fn) AS authenticated_can_execute,
       (SELECT NOT pg_catalog.has_function_privilege('anon', oid, 'EXECUTE') FROM web_fn) AS anon_cannot_execute,
       (SELECT NOT pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE') FROM web_fn) AS service_role_cannot_execute,
       (SELECT NOT EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl, pg_catalog.acldefault('f',proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        ) FROM web_fn) AS public_cannot_execute,
       (SELECT pg_catalog.pg_get_userbyid(proowner) = 'postgres' AND prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM helper) AS helper_hardened,
       (SELECT pg_catalog.pg_get_functiondef(oid) FROM helper) AS helper_definition,
       (SELECT NOT pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT pg_catalog.has_function_privilege('anon', oid, 'EXECUTE') AND NOT pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE') FROM helper) AS helper_not_directly_executable,
       (SELECT relrowsecurity FROM draft_table) AS drafts_rls_enabled,
       (SELECT NOT relforcerowsecurity FROM draft_table) AS drafts_rls_not_forced,
       NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_policies
          WHERE schemaname = 'public' AND tablename = 'tb_agent_category_drafts'
       ) AS drafts_have_no_policies,
       NOT EXISTS (
         SELECT 1 FROM draft_table d
          WHERE pg_catalog.has_table_privilege('anon', d.oid, 'SELECT')
             OR pg_catalog.has_table_privilege('anon', d.oid, 'INSERT')
             OR pg_catalog.has_table_privilege('anon', d.oid, 'UPDATE')
             OR pg_catalog.has_table_privilege('anon', d.oid, 'DELETE')
             OR pg_catalog.has_table_privilege('anon', d.oid, 'TRUNCATE')
             OR pg_catalog.has_table_privilege('anon', d.oid, 'REFERENCES')
             OR pg_catalog.has_table_privilege('anon', d.oid, 'TRIGGER')
       ) AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = pg_catalog.to_regclass('public.tb_agent_category_drafts')
            AND a.attnum > 0 AND NOT a.attisdropped
            AND (
              pg_catalog.has_column_privilege('anon', a.attrelid, a.attnum, 'SELECT')
              OR pg_catalog.has_column_privilege('anon', a.attrelid, a.attnum, 'INSERT')
              OR pg_catalog.has_column_privilege('anon', a.attrelid, a.attnum, 'UPDATE')
              OR pg_catalog.has_column_privilege('anon', a.attrelid, a.attnum, 'REFERENCES')
            )
       ) AS anon_has_no_draft_privileges,
       NOT EXISTS (
         SELECT 1 FROM draft_table d
          WHERE pg_catalog.has_table_privilege('authenticated', d.oid, 'SELECT')
             OR pg_catalog.has_table_privilege('authenticated', d.oid, 'INSERT')
             OR pg_catalog.has_table_privilege('authenticated', d.oid, 'UPDATE')
             OR pg_catalog.has_table_privilege('authenticated', d.oid, 'DELETE')
             OR pg_catalog.has_table_privilege('authenticated', d.oid, 'TRUNCATE')
             OR pg_catalog.has_table_privilege('authenticated', d.oid, 'REFERENCES')
             OR pg_catalog.has_table_privilege('authenticated', d.oid, 'TRIGGER')
       ) AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = pg_catalog.to_regclass('public.tb_agent_category_drafts')
            AND a.attnum > 0 AND NOT a.attisdropped
            AND (
              pg_catalog.has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT')
              OR pg_catalog.has_column_privilege('authenticated', a.attrelid, a.attnum, 'INSERT')
              OR pg_catalog.has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE')
              OR pg_catalog.has_column_privilege('authenticated', a.attrelid, a.attnum, 'REFERENCES')
            )
       ) AS authenticated_has_no_draft_privileges,
       NOT EXISTS (
         SELECT 1 FROM draft_table d
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(d.relacl, pg_catalog.acldefault('r', d.relowner))
         ) a
         WHERE a.grantee = 0
       ) AS public_has_no_draft_table_privileges,
       NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute a
         CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl
          WHERE a.attrelid = pg_catalog.to_regclass('public.tb_agent_category_drafts')
            AND a.attnum > 0 AND NOT a.attisdropped
            AND acl.grantee = 0
       ) AS public_has_no_draft_column_privileges,
       (SELECT pg_catalog.has_table_privilege('service_role', oid, 'SELECT')
           AND pg_catalog.has_table_privilege('service_role', oid, 'INSERT')
           AND pg_catalog.has_table_privilege('service_role', oid, 'UPDATE')
           AND pg_catalog.has_table_privilege('service_role', oid, 'DELETE')
         FROM draft_table) AS service_role_has_draft_dml,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role' AND rolbypassrls
       ) AS service_role_bypasses_draft_rls,
       (SELECT count(*) = 3 AND count(DISTINCT oid) = 3
          FROM legacy_draft_functions) AS legacy_draft_rpcs_present,
       NOT EXISTS (
         SELECT 1 FROM legacy_draft_functions f
          WHERE pg_catalog.has_function_privilege('anon', f.oid, 'EXECUTE')
             OR pg_catalog.has_function_privilege('authenticated', f.oid, 'EXECUTE')
             OR NOT pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE')
       ) AS legacy_draft_rpc_effective_acl_correct,
       NOT EXISTS (
         SELECT 1 FROM legacy_draft_functions f
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))
         ) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS public_cannot_execute_legacy_draft_rpcs,
       (SELECT count(*) = 3 AND count(DISTINCT oid) = 3
          FROM whatsapp_draft_wrappers) AS whatsapp_draft_wrappers_present,
       NOT EXISTS (
         SELECT 1 FROM whatsapp_draft_wrappers f
          WHERE NOT pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE')
             OR pg_catalog.has_function_privilege('anon', f.oid, 'EXECUTE')
             OR pg_catalog.has_function_privilege('authenticated', f.oid, 'EXECUTE')
       ) AS whatsapp_draft_wrapper_acl_correct,
       NOT EXISTS (
         SELECT 1 FROM whatsapp_draft_wrappers f
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))
         ) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS public_cannot_execute_whatsapp_draft_wrappers`,
  );
  const row = check.rows[0];
  requireCondition(
    row &&
      row.auth_users_present &&
      row.app_users_present &&
      row.memberships_present &&
      row.drafts_present &&
      row.web_function_present &&
      row.web_function_hardened &&
      row.authenticated_can_execute &&
      row.anon_cannot_execute &&
      row.service_role_cannot_execute &&
      row.public_cannot_execute &&
      row.helper_hardened &&
      row.helper_not_directly_executable &&
      row.drafts_rls_enabled &&
      row.drafts_rls_not_forced &&
      row.drafts_have_no_policies &&
      row.anon_has_no_draft_privileges &&
      row.authenticated_has_no_draft_privileges &&
      row.public_has_no_draft_table_privileges &&
      row.public_has_no_draft_column_privileges &&
      row.service_role_has_draft_dml &&
      row.service_role_bypasses_draft_rls &&
      row.legacy_draft_rpcs_present &&
      row.legacy_draft_rpc_effective_acl_correct &&
      row.public_cannot_execute_legacy_draft_rpcs &&
      row.whatsapp_draft_wrappers_present &&
      row.whatsapp_draft_wrapper_acl_correct &&
      row.public_cannot_execute_whatsapp_draft_wrappers,
    "local_web_jwt_rpc_or_draft_acl_not_ready",
    "preflight",
  );
  requireCondition(
    typeof row.web_definition === "string" &&
      row.web_definition.includes("fn_require_web_financial_context") &&
      typeof row.helper_definition === "string" &&
      /auth\.uid\s*\(\s*\)/i.test(row.helper_definition) &&
      /auth\.role\s*\(\s*\)/i.test(row.helper_definition) &&
      /email_confirmed_at/i.test(row.helper_definition),
    "local_web_jwt_identity_guard_definition_unexpected",
    "preflight",
  );
}

function ensurePrivateSandbox(sandboxRoot) {
  const relative = path.relative(ROOT, sandboxRoot);
  requireCondition(
    relative.startsWith("..") && !path.isAbsolute(relative),
    "next_sandbox_inside_repository",
    "preflight",
  );
  requireCondition(
    fs.statSync(sandboxRoot).isDirectory(),
    "next_sandbox_not_created",
    "preflight",
  );
  const deniedNames = new Set([
    ".git",
    ".next",
    ".vercel",
    ".codex",
    ".agents",
    ".aws",
    ".vscode",
    "node_modules",
    "docs",
    "tests",
    "scripts",
    "test-results",
    "coverage",
    "tmp",
    "dist",
    "build",
    "out",
    ".turbo",
  ]);
  const deniedFile = (name) =>
    /^\.env(?:\.|$)/i.test(name) ||
    /\.(?:pem|key|p12|pfx|crt|cer)$/i.test(name) ||
    name === ".npmrc" ||
    name === ".pypirc";

  function copyDirectory(source, destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (deniedNames.has(entry.name) || deniedFile(entry.name)) continue;
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) copyDirectory(from, to);
      else if (entry.isFile()) fs.copyFileSync(from, to);
    }
  }

  for (const directory of [
    "app",
    "components",
    "infrastructure",
    "modules",
    "public",
  ]) {
    const source = path.join(ROOT, directory);
    if (fs.existsSync(source))
      copyDirectory(source, path.join(sandboxRoot, directory));
  }
  for (const file of [
    "package.json",
    "tsconfig.json",
    "next.config.ts",
    "next-env.d.ts",
  ]) {
    const source = path.join(ROOT, file);
    if (fs.existsSync(source))
      fs.copyFileSync(source, path.join(sandboxRoot, file));
  }

  const nodeModules = path.join(ROOT, "node_modules");
  requireCondition(
    fs.existsSync(nodeModules),
    "project_node_modules_missing",
    "preflight",
  );
  fs.symlinkSync(
    nodeModules,
    path.join(sandboxRoot, "node_modules"),
    "junction",
  );
}

function createNetworkGuardFile(filename) {
  const fixture = {
    status: "completed",
    output: [
      {
        type: "message",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(TEST_ONLY_INTERPRETATION),
          },
        ],
      },
    ],
  };
  const source = `"use strict";
const originalFetch = globalThis.fetch.bind(globalThis);
const allowedPorts = new Set((process.env.HOUSEMATE_JWT_LOCAL_PORTS || "").split(",").map(Number));
const openAiFixture = ${JSON.stringify(JSON.stringify(fixture))};
globalThis.fetch = async (input, init) => {
  let url;
  try { url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)); }
  catch { throw new Error("LOCAL_TEST_NETWORK_BLOCKED"); }
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
    if ((init && init.method || input && input.method || "GET").toUpperCase() !== "POST") throw new Error("LOCAL_TEST_NETWORK_BLOCKED");
    return new Response(openAiFixture, { status: 200, headers: { "content-type": "application/json" } });
  }
  if ((url.hostname === "127.0.0.1" || url.hostname === "::1") && allowedPorts.has(Number(url.port))) {
    return originalFetch(input, init);
  }
  throw new Error("LOCAL_TEST_NETWORK_BLOCKED");
};
`;
  fs.writeFileSync(filename, source, { encoding: "utf8", flag: "wx" });
}

async function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", () =>
      reject(new HarnessFailure("next_loopback_port_unavailable", "preflight")),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() =>
          reject(
            new HarnessFailure("next_loopback_port_unavailable", "preflight"),
          ),
        );
        return;
      }
      const port = address.port;
      server.close((error) =>
        error
          ? reject(
              new HarnessFailure("next_loopback_port_unavailable", "preflight"),
            )
          : resolve(port),
      );
    });
  });
}

function quoteNodeOption(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function redactNextOutput(value, runtime) {
  let text = String(value);
  for (const secret of [runtime.anonKey, runtime.serviceRoleKey]) {
    if (secret) text = text.split(secret).join("<redacted-key>");
  }
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "<redacted-jwt>",
    )
    .replace(/https?:\/\/[^\s"'`]+/gi, "<url>")
    .replace(/C:\\Users\\[^\\/\s"'`]+/gi, "C:\\Users\\<user>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, "<uuid>");
}

function nextLogSummary(logs) {
  const lines = logs.split(/\r?\n/);
  let marker = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (
      /error|failed|cannot|could not|unable|invalid|exception|\bEPERM\b|\bEACCES\b|\bEADDRINUSE\b|⨯/i.test(
        lines[index],
      )
    ) {
      marker = index;
      break;
    }
  }
  if (marker < 0) return "no_error_marker";
  return lines
    .slice(Math.max(0, marker - 1), Math.min(lines.length, marker + 9))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 900);
}

async function startNext(sandboxRoot, port, runtime, guardPath) {
  const nextBin = path.join(
    ROOT,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  requireCondition(fs.existsSync(nextBin), "next_cli_missing", "preflight");
  const env = safeChildEnvironment({
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: runtime.apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: runtime.anonKey,
    SUPABASE_URL: runtime.apiUrl,
    SUPABASE_ANON_KEY: runtime.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: runtime.serviceRoleKey,
    OPENAI_API_KEY: "local-test-stub-not-a-credential",
    HOUSEMATE_JWT_LOCAL_PORTS: `${port},54321`,
    NODE_OPTIONS: `--require ${quoteNodeOption(guardPath)}`,
  });
  const child = spawn(
    process.execPath,
    [
      nextBin,
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: sandboxRoot,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  const append = (chunk) => {
    logs = (logs + redactNextOutput(chunk.toString("utf8"), runtime)).slice(
      -200_000,
    );
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, getLogs: () => logs };
}

function classifyNextStartupFailure(logs, exitCode) {
  const categories = [
    [/EADDRINUSE|address already in use/i, "next_port_conflict"],
    [/MODULE_NOT_FOUND|Cannot find module/i, "next_dependency_missing"],
    [
      /Failed to load next\.config|Invalid next\.config/i,
      "next_config_invalid",
    ],
    [/SyntaxError|Failed to compile|Type error/i, "next_source_compile_failed"],
    [/LOCAL_TEST_NETWORK_BLOCKED/i, "next_network_guard_blocked_startup"],
    [
      /EPERM|EACCES|Access is denied|Permission denied/i,
      "next_filesystem_access_denied",
    ],
  ];
  const category =
    categories.find(([pattern]) => pattern.test(logs))?.[1] ??
    "next_server_exited_before_ready";
  return `${category}_exit_${Number.isInteger(exitCode) ? exitCode : "unknown"}`;
}

async function waitForAgentRoute(child, port, getLogs) {
  const deadline = Date.now() + 60_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new HarnessFailure(
        classifyNextStartupFailure(getLogs(), child.exitCode),
        "test",
        nextLogSummary(getLogs()),
      );
    const response = await fetch(`http://127.0.0.1:${port}/api/agent`, {
      method: "GET",
      signal: AbortSignal.timeout(1_500),
    }).catch(() => null);
    if (response?.status === 405) return;
    if (response) lastStatus = response.status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new HarnessFailure(
    `next_agent_route_not_ready_${lastStatus ?? "no_response"}`,
    "test",
    nextLogSummary(getLogs()),
  );
}

async function stopNext(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {}
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const taskkill = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "taskkill.exe",
  );
  if (fs.existsSync(taskkill)) {
    await runCommand(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      timeoutMs: 8_000,
    });
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new HarnessFailure("next_process_tree_not_stopped", "cleanup");
  }
}

async function removeTestSandbox(sandboxRoot) {
  const expectedParent = normalizedPath(os.tmpdir());
  const basename = path.basename(sandboxRoot);
  requireCondition(
    normalizedPath(path.dirname(sandboxRoot)) === expectedParent &&
      /^housemate-web-jwt-route-[a-z0-9]+$/i.test(basename),
    "sandbox_cleanup_target_unexpected",
    "cleanup",
  );

  const nodeModules = path.join(sandboxRoot, "node_modules");
  if (fs.existsSync(nodeModules)) {
    const stat = fs.lstatSync(nodeModules);
    requireCondition(
      stat.isSymbolicLink() &&
        normalizedPath(fs.realpathSync(nodeModules)) ===
          normalizedPath(path.join(ROOT, "node_modules")),
      "sandbox_node_modules_junction_unexpected",
      "cleanup",
    );
    fs.unlinkSync(nodeModules);
  }

  function hasUnexpectedLink(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) return true;
      if (stat.isDirectory() && hasUnexpectedLink(entryPath)) return true;
    }
    return false;
  }
  requireCondition(
    !hasUnexpectedLink(sandboxRoot),
    "sandbox_contains_unexpected_link",
    "cleanup",
  );

  let nodeCleanupFailed = false;
  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {
    nodeCleanupFailed = true;
  }
  if (!nodeCleanupFailed && !fs.existsSync(sandboxRoot)) return;

  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
  const target = path.resolve(sandboxRoot);
  const parent = path.resolve(os.tmpdir());
  const command = `$target=${psQuote(target)}; $parent=${psQuote(parent)}; $full=[IO.Path]::GetFullPath($target).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar); if([IO.Path]::GetDirectoryName($full) -ine $parent -or [IO.Path]::GetFileName($full) -notmatch '^housemate-web-jwt-route-[a-z0-9]+$'){exit 21}; Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop; if(Test-Path -LiteralPath $full){exit 22}`;
  const fallback = await runCommand(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeoutMs: 30_000 },
  );
  requireCondition(
    fallback.exitCode === 0 && !fs.existsSync(sandboxRoot),
    "sandbox_cleanup_failed",
    "cleanup",
  );
}

function createMemoryCookieAdapter() {
  const values = new Map();
  return {
    values,
    cookies: {
      getAll() {
        return [...values.entries()].map(([name, value]) => ({ name, value }));
      },
      setAll(items) {
        for (const item of items) {
          if (item.options?.maxAge === 0) values.delete(item.name);
          else values.set(item.name, item.value);
        }
      },
    },
  };
}

async function createSession(runtime, email, password) {
  const jar = createMemoryCookieAdapter();
  const client = createServerClient(runtime.apiUrl, runtime.anonKey, {
    cookies: jar.cookies,
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  requireCondition(
    !error && data.session && data.user,
    "local_auth_session_creation_failed",
  );
  requireCondition(jar.values.size > 0, "supabase_session_cookie_not_created");
  return {
    userId: data.user.id,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    cookiePairs: [...jar.values.entries()],
  };
}

function cookieHeader(session, selectedHouseholdId, corrupt = false) {
  const pairs = session
    ? session.cookiePairs.map(([name, value]) => [
        name,
        corrupt ? "invalid-session-cookie" : value,
      ])
    : [];
  if (selectedHouseholdId) {
    pairs.push(["housemate_selected_household", selectedHouseholdId]);
  }
  return pairs.map(([name, value]) => `${name}=${value}`).join("; ");
}

async function postAgent(port, cookie, requestId) {
  const headers = {
    "content-type": "application/json",
    "x-e2e-request-id": `${REQUEST_ID_PREFIX}${requestId}`,
  };
  if (cookie) headers.cookie = cookie;
  return fetch(`http://127.0.0.1:${port}/api/agent`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: REQUEST_MESSAGE }),
    signal: AbortSignal.timeout(15_000),
  });
}

async function readResponse(response) {
  try {
    return await response.json();
  } catch {
    throw new HarnessFailure("agent_route_response_invalid_json");
  }
}

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed;
    } catch {}
  }
  return null;
}

function requireRpcSuccess(result, code) {
  requireCondition(!result.error && result.data, code);
  return objectValue(result.data);
}

async function callProvision(admin, fixture, displayName, householdName) {
  const result = await admin.rpc("fn_provision_authenticated_user", {
    p_auth_user_id: fixture.authUserId,
    p_display_name: displayName,
    p_household_name: householdName,
  });
  const data = requireRpcSuccess(result, "test_user_provisioning_failed");
  requireCondition(
    data &&
      data.status === "PROVISIONING_COMPLETED" &&
      data.userId &&
      data.householdId &&
      data.memberId,
    "test_user_provisioning_result_invalid",
  );
  fixture.appUserId = data.userId;
  fixture.households.push(data.householdId);
  fixture.members.push(data.memberId);
  writeManifest();
}

async function createNoMembershipApplicationUser(database, fixture) {
  const result = await database.query(
    `INSERT INTO public.tb_users (display_name, external_identifier, auth_user_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      `Local JWT ${manifest.runId} no membership`,
      `supabase:${fixture.authUserId}`,
      fixture.authUserId,
    ],
  );
  requireCondition(
    result.rows.length === 1 && result.rows[0].id,
    "no_membership_application_user_setup_failed",
  );
  fixture.appUserId = result.rows[0].id;
  writeManifest();
}

async function callCreateHousehold(admin, fixture, householdName) {
  const idempotencyKey = crypto.randomUUID();
  manifest.idempotencyKeys.push({
    authUserId: fixture.authUserId,
    key: idempotencyKey,
  });
  writeManifest();
  const result = await admin.rpc("fn_create_household_for_authenticated_user", {
    p_auth_user_id: fixture.authUserId,
    p_household_name: householdName,
    p_idempotency_key: idempotencyKey,
  });
  const data = requireRpcSuccess(
    result,
    "second_test_household_creation_failed",
  );
  requireCondition(
    data && data.householdId && data.memberId,
    "second_test_household_result_invalid",
  );
  fixture.households.push(data.householdId);
  fixture.members.push(data.memberId);
  writeManifest();
}

async function makeTestUser(admin, label, confirmed = true) {
  const email = `jwt-route-${manifest.runId}-${label.toLowerCase()}@example.invalid`;
  const password = crypto.randomBytes(32).toString("base64url");
  const fixture = {
    label,
    email,
    password,
    authUserId: null,
    appUserId: null,
    households: [],
    members: [],
  };
  fixtures.push(fixture);
  manifest.authEmails.push(email);
  writeManifest();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: confirmed,
  });
  requireCondition(!error && data.user?.id, "test_auth_user_creation_failed");
  fixture.authUserId = data.user.id;
  manifest.authUserIds.push(data.user.id);
  writeManifest();
  return fixture;
}

async function addSecondaryHousehold(admin, fixture, label) {
  await callCreateHousehold(
    admin,
    fixture,
    `Local JWT ${manifest.runId} ${label}`,
  );
}

async function draftCount(database, households, members) {
  const result = await readOnlyQuery(
    database,
    `SELECT count(*)::integer AS count
       FROM public.tb_agent_category_drafts
      WHERE household_id = ANY($1::uuid[])
        AND actor_member_id = ANY($2::uuid[])`,
    [households, members],
  );
  return Number(result.rows[0].count);
}

async function assertNoDraftChange(
  database,
  before,
  households,
  members,
  code,
) {
  const after = await draftCount(database, households, members);
  requireCondition(after === before, code);
}

function makeAuthenticatedPostgrestClient(runtime, session) {
  const client = createClient(runtime.apiUrl, runtime.anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return client.auth
    .setSession({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
    })
    .then(({ error }) => {
      requireCondition(!error, "postgrest_test_session_setup_failed");
      return client;
    });
}

function rpcDraftArguments(householdId, memberId, id, conversationKey) {
  return {
    p_id: id,
    p_household_id: householdId,
    p_actor_member_id: memberId,
    p_conversation_key: conversationKey,
    p_operation_type: null,
    p_payload: {
      amount: "test-only",
      date: null,
      dateProvided: false,
      merchant: null,
      description: "JWT test only",
      paidBySelf: null,
      paidByMemberName: null,
      categoryName: null,
      splitRequested: false,
      splitInstructions: null,
    },
    p_status: "AWAITING_OPERATION",
  };
}

async function verifyPositiveDraft(database, user, householdId, memberId) {
  const conversationKey = `web:${householdId}:${memberId}`;
  const result = await readOnlyQuery(
    database,
    `SELECT d.id, d.household_id, d.actor_member_id, d.conversation_key,
            d.source, d.operation_type, d.status, u.auth_user_id
       FROM public.tb_agent_category_drafts d
       JOIN public.tb_household_members m
         ON m.id = d.actor_member_id AND m.household_id = d.household_id
       JOIN public.tb_users u ON u.id = m.user_id
      WHERE d.household_id = $1 AND d.actor_member_id = $2
        AND d.conversation_key = $3
      LIMIT 2`,
    [householdId, memberId, conversationKey],
  );
  requireCondition(
    result.rows.length === 1,
    "positive_draft_not_persisted_once",
  );
  const draft = result.rows[0];
  requireCondition(
    draft.auth_user_id === user.authUserId &&
      draft.household_id === householdId &&
      draft.actor_member_id === memberId &&
      draft.conversation_key === conversationKey &&
      draft.source === "WEB" &&
      draft.operation_type === null &&
      draft.status === "AWAITING_OPERATION",
    "positive_draft_not_attributed_to_authenticated_user",
  );
  return { conversationKey, draftId: draft.id };
}

async function routeNegativeCase(database, port, test) {
  const before = await draftCount(database, test.households, test.members);
  const response = await postAgent(port, test.cookie, crypto.randomUUID());
  const body = await readResponse(response);
  if (response.status !== test.status || body.error?.code !== test.code) {
    const actualCode =
      typeof body.error?.code === "string"
        ? body.error.code.replace(/[^A-Z0-9_]/g, "").slice(0, 64)
        : "NO_ERROR_CODE";
    throw new HarnessFailure(
      `http_negative_${test.name}_contract_mismatch`,
      "test",
      `expected_status=${test.status} expected_code=${test.code} received_status=${response.status} received_code=${actualCode}`,
    );
  }
  await assertNoDraftChange(
    database,
    before,
    test.households,
    test.members,
    `http_negative_${test.name}_created_draft`,
  );
}

async function directRpcNegativeCase(database, client, test) {
  const before = await draftCount(database, test.households, test.members);
  const draftId = crypto.randomUUID();
  manifest.directRpcAttemptIds.push(draftId);
  writeManifest();
  const result = await client.rpc(
    "fn_create_web_agent_draft",
    rpcDraftArguments(
      test.householdId,
      test.memberId,
      draftId,
      `jwt-route-negative:${manifest.runId}:${test.name}`,
    ),
  );
  requireCondition(
    Boolean(result.error),
    `direct_rpc_${test.name}_was_not_rejected`,
  );
  await assertNoDraftChange(
    database,
    before,
    test.households,
    test.members,
    `direct_rpc_${test.name}_created_draft`,
  );
}

function writeManifest() {
  if (!manifestPath) return;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function findAuthUsersByEmail(admin, emails) {
  const target = new Set(emails);
  const found = new Map();
  let page = 1;
  for (; page <= 100 && target.size > 0; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    requireCondition(
      !error && Array.isArray(data.users),
      "auth_user_cleanup_inventory_failed",
      "cleanup",
    );
    for (const user of data.users) {
      if (user.email && target.has(user.email)) {
        found.set(user.email, user);
        target.delete(user.email);
      }
    }
    if (data.users.length < 1000) break;
  }
  if (page > 100 && target.size > 0) {
    throw new HarnessFailure(
      "auth_user_cleanup_inventory_incomplete",
      "cleanup",
    );
  }
  return [...found.values()];
}

async function cleanupFixtures(admin, database) {
  if (!fixtures.length) return;
  const emails = manifest.authEmails;
  const authIds = new Set(manifest.authUserIds);
  const authUsers = await findAuthUsersByEmail(admin, emails);
  for (const user of authUsers) authIds.add(user.id);
  const authIdList = [...authIds];

  await database.query("BEGIN");
  let householdIds = new Set(fixtures.flatMap((fixture) => fixture.households));
  let memberIds = new Set(fixtures.flatMap((fixture) => fixture.members));
  let appUserIds = new Set(
    fixtures.map((fixture) => fixture.appUserId).filter(Boolean),
  );
  try {
    const users = await database.query(
      "SELECT id FROM public.tb_users WHERE auth_user_id = ANY($1::uuid[])",
      [authIdList],
    );
    for (const row of users.rows) appUserIds.add(row.id);
    const memberships = await database.query(
      `SELECT id, household_id FROM public.tb_household_members
        WHERE user_id = ANY($1::uuid[])`,
      [[...appUserIds]],
    );
    for (const row of memberships.rows) {
      memberIds.add(row.id);
      householdIds.add(row.household_id);
    }

    await database.query(
      `DELETE FROM public.tb_agent_category_drafts
        WHERE household_id = ANY($1::uuid[])
          AND actor_member_id = ANY($2::uuid[])
          AND source = 'WEB'`,
      [[...householdIds], [...memberIds]],
    );
    await database.query(
      `DELETE FROM public.tb_household_creation_idempotency
        WHERE auth_user_id = ANY($1::uuid[])`,
      [authIdList],
    );
    await database.query(
      "DELETE FROM public.tb_household_members WHERE user_id = ANY($1::uuid[])",
      [[...appUserIds]],
    );
    await database.query(
      "DELETE FROM public.tb_households WHERE id = ANY($1::uuid[])",
      [[...householdIds]],
    );
    await database.query(
      "DELETE FROM public.tb_users WHERE auth_user_id = ANY($1::uuid[])",
      [authIdList],
    );
    await database.query("COMMIT");
  } catch {
    try {
      await database.query("ROLLBACK");
    } catch {}
    throw new HarnessFailure("fixture_database_cleanup_failed", "cleanup");
  }

  const remaining = await database.query(
    `SELECT
       (SELECT count(*) FROM public.tb_users WHERE auth_user_id = ANY($1::uuid[])) AS users,
       (SELECT count(*) FROM public.tb_household_members WHERE id = ANY($2::uuid[])) AS memberships,
       (SELECT count(*) FROM public.tb_households WHERE id = ANY($3::uuid[])) AS households,
       (SELECT count(*) FROM public.tb_agent_category_drafts WHERE household_id = ANY($3::uuid[]) AND actor_member_id = ANY($2::uuid[])) AS drafts,
       (SELECT count(*) FROM public.tb_household_creation_idempotency WHERE auth_user_id = ANY($1::uuid[])) AS idempotency`,
    [authIdList, [...memberIds], [...householdIds]],
  );
  requireCondition(
    Object.values(remaining.rows[0]).every((value) => Number(value) === 0),
    "fixture_database_cleanup_verification_failed",
    "cleanup",
  );

  for (const user of authUsers) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    requireCondition(!error, "auth_fixture_user_delete_failed", "cleanup");
  }
  const stillPresent = await findAuthUsersByEmail(admin, emails);
  requireCondition(
    stillPresent.length === 0,
    "auth_fixture_cleanup_verification_failed",
    "cleanup",
  );
}

const fixtures = [];
let manifestPath = null;
let manifest = {
  version: 1,
  runId: crypto.randomUUID(),
  authEmails: [],
  authUserIds: [],
  idempotencyKeys: [],
  directRpcAttemptIds: [],
};

async function main() {
  let database = null;
  let admin = null;
  let nextChild = null;
  let sandboxRoot = null;
  let passCount = 0;
  let cleanupDone = false;
  let failureCode = null;
  let cleanupFailure = false;
  try {
    await verifyDockerAndPortBindings();
    const runtime = await readLocalRuntimeEnvironment();

    const pgModule = require("pg");
    requireCondition(
      pgModule.Client === Client,
      "local_postgres_driver_unavailable",
      "preflight",
    );
    database = new Client({
      connectionString: runtime.dbUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 8_000,
      statement_timeout: 8_000,
    });
    await database.connect().catch(() => {
      throw new HarnessFailure("local_postgres_unavailable", "preflight");
    });
    await verifyLocalServices(runtime, database);
    console.log(
      "PASS preflight local Supabase, 0049 draft ACL/RLS, and loopback ports",
    );
    passCount += 1;

    admin = createClient(runtime.apiUrl, runtime.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
    const anon = createClient(runtime.apiUrl, runtime.anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
    const anonDraftRead = await anon
      .from("tb_agent_category_drafts")
      .select("id")
      .limit(1);
    requireCondition(
      Boolean(anonDraftRead.error),
      "anon_direct_draft_read_was_allowed",
      "preflight",
    );

    const tempParent = fs.realpathSync(os.tmpdir());
    sandboxRoot = fs.mkdtempSync(
      path.join(tempParent, "housemate-web-jwt-route-"),
    );
    const relative = path.relative(ROOT, sandboxRoot);
    requireCondition(
      relative.startsWith("..") && !path.isAbsolute(relative),
      "next_sandbox_inside_repository",
      "preflight",
    );
    manifestPath = path.join(sandboxRoot, "fixture-manifest.json");
    writeManifest();
    ensurePrivateSandbox(sandboxRoot);
    const guardPath = path.join(sandboxRoot, "local-network-guard.cjs");
    createNetworkGuardFile(guardPath);
    const nextPort = await findFreeLoopbackPort();
    const next = await startNext(sandboxRoot, nextPort, runtime, guardPath);
    nextChild = next.child;
    await waitForAgentRoute(nextChild, nextPort, next.getLogs);
    console.log(
      "PASS actual Next.js HTTP POST /api/agent route is ready on loopback",
    );
    passCount += 1;

    const userA = await makeTestUser(admin, "A");
    await callProvision(
      admin,
      userA,
      `JWT A ${manifest.runId}`,
      `JWT A home ${manifest.runId}`,
    );
    await addSecondaryHousehold(admin, userA, "A second home");

    const userB = await makeTestUser(admin, "B");
    await callProvision(
      admin,
      userB,
      `JWT B ${manifest.runId}`,
      `JWT B home ${manifest.runId}`,
    );
    await addSecondaryHousehold(admin, userB, "B second home");

    const userC = await makeTestUser(admin, "NO-MEMBERSHIP");
    await createNoMembershipApplicationUser(database, userC);

    const userD = await makeTestUser(admin, "UNCONFIRMED");
    await callProvision(
      admin,
      userD,
      `JWT unconfirmed ${manifest.runId}`,
      `JWT unconfirmed home ${manifest.runId}`,
    );

    for (const fixture of [userA, userB, userC, userD]) {
      const session = await createSession(
        runtime,
        fixture.email,
        fixture.password,
      );
      requireCondition(
        session.userId === fixture.authUserId,
        "auth_session_identity_mismatch",
      );
      fixture.session = session;
    }
    const unconfirmedUpdate = await database.query(
      `UPDATE auth.users
          SET email_confirmed_at = NULL
        WHERE id = $1 AND email = $2
        RETURNING id`,
      [userD.authUserId, userD.email],
    );
    requireCondition(
      unconfirmedUpdate.rows.length === 1 &&
        unconfirmedUpdate.rows[0].id === userD.authUserId,
      "unconfirmed_fixture_setup_failed",
    );

    const contextCounts = await readOnlyQuery(
      database,
      `SELECT u.auth_user_id, count(*) FILTER (WHERE m.status = 'ACTIVE')::integer AS active_count
         FROM public.tb_users u
         LEFT JOIN public.tb_household_members m ON m.user_id = u.id
        WHERE u.auth_user_id = ANY($1::uuid[])
        GROUP BY u.auth_user_id`,
      [
        [
          userA.authUserId,
          userB.authUserId,
          userC.authUserId,
          userD.authUserId,
        ],
      ],
    );
    const counts = new Map(
      contextCounts.rows.map((row) => [
        row.auth_user_id,
        Number(row.active_count),
      ]),
    );
    requireCondition(
      counts.get(userA.authUserId) === 2 &&
        counts.get(userB.authUserId) === 2 &&
        counts.get(userC.authUserId) === 0 &&
        counts.get(userD.authUserId) === 1,
      "test_membership_fixtures_not_as_expected",
    );

    const initialDraftCount = await draftCount(
      database,
      fixtures.flatMap((fixture) => fixture.households),
      fixtures.flatMap((fixture) => fixture.members),
    );
    requireCondition(
      initialDraftCount === 0,
      "test_fixture_has_preexisting_drafts",
    );

    const positiveResponse = await postAgent(
      nextPort,
      cookieHeader(userA.session, userA.households[0]),
      crypto.randomUUID(),
    );
    const positiveBody = await readResponse(positiveResponse);
    requireCondition(
      positiveResponse.status === 200 &&
        positiveBody.data?.type === "CLARIFICATION_REQUIRED" &&
        Array.isArray(positiveBody.data.missingFields) &&
        positiveBody.data.missingFields.includes("operation"),
      "positive_route_contract_mismatch",
    );
    const positiveDraft = await verifyPositiveDraft(
      database,
      userA,
      userA.households[0],
      userA.members[0],
    );
    manifest.directRpcAttemptIds.push(positiveDraft.draftId);
    writeManifest();
    const serviceRoleDraftRead = await admin
      .from("tb_agent_category_drafts")
      .select("id")
      .eq("id", positiveDraft.draftId)
      .maybeSingle();
    requireCondition(
      !serviceRoleDraftRead.error &&
        serviceRoleDraftRead.data?.id === positiveDraft.draftId,
      "service_role_direct_draft_read_failed",
    );
    console.log(
      "PASS confirmed Auth cookie reached PostgREST and created one authorized WEB draft",
    );
    passCount += 1;

    const allHouseholds = fixtures.flatMap((fixture) => fixture.households);
    const allMembers = fixtures.flatMap((fixture) => fixture.members);
    const negativeRoutes = [
      { name: "no-cookie", cookie: "", status: 401, code: "UNAUTHENTICATED" },
      {
        name: "invalid-cookie",
        cookie: cookieHeader(userA.session, userA.households[0], true),
        status: 401,
        code: "UNAUTHENTICATED",
      },
      {
        name: "unconfirmed-email",
        cookie: cookieHeader(userD.session, userD.households[0]),
        status: 403,
        code: "ACCOUNT_NOT_ELIGIBLE",
      },
      {
        name: "no-active-membership",
        cookie: cookieHeader(userC.session),
        status: 403,
        code: "NO_ACTIVE_MEMBERSHIP",
      },
      {
        name: "user-a-selects-household-b",
        cookie: cookieHeader(userA.session, userB.households[0]),
        status: 409,
        code: "HOUSEHOLD_SELECTION_REQUIRED",
      },
      {
        name: "user-b-selects-household-a",
        cookie: cookieHeader(userB.session, userA.households[0]),
        status: 409,
        code: "HOUSEHOLD_SELECTION_REQUIRED",
      },
    ];
    for (const test of negativeRoutes) {
      await routeNegativeCase(database, nextPort, {
        ...test,
        households: allHouseholds,
        members: allMembers,
      });
      console.log(
        `PASS HTTP negative ${test.name}: ${test.status} ${test.code}, no draft created`,
      );
      passCount += 1;
    }

    const userAClient = await makeAuthenticatedPostgrestClient(
      runtime,
      userA.session,
    );
    const userBClient = await makeAuthenticatedPostgrestClient(
      runtime,
      userB.session,
    );
    const authenticatedDraftRead = await userAClient
      .from("tb_agent_category_drafts")
      .select("id")
      .limit(1);
    requireCondition(
      Boolean(authenticatedDraftRead.error),
      "authenticated_direct_draft_read_was_allowed",
      "preflight",
    );
    for (const test of [
      {
        name: "user-a-household-b",
        client: userAClient,
        householdId: userB.households[0],
        memberId: userB.members[0],
      },
      {
        name: "user-b-household-a",
        client: userBClient,
        householdId: userA.households[0],
        memberId: userA.members[0],
      },
    ]) {
      await directRpcNegativeCase(database, test.client, {
        ...test,
        households: allHouseholds,
        members: allMembers,
      });
      console.log(
        `PASS PostgREST negative ${test.name}: foreign household rejected, no draft created`,
      );
      passCount += 1;
    }

    const serviceRoleBefore = await draftCount(
      database,
      allHouseholds,
      allMembers,
    );
    const serviceRoleAttemptId = crypto.randomUUID();
    manifest.directRpcAttemptIds.push(serviceRoleAttemptId);
    writeManifest();
    const serviceRoleAttempt = await admin.rpc(
      "fn_create_web_agent_draft",
      rpcDraftArguments(
        userA.households[0],
        userA.members[0],
        serviceRoleAttemptId,
        `jwt-route-negative:${manifest.runId}:service-role`,
      ),
    );
    requireCondition(
      Boolean(serviceRoleAttempt.error),
      "service_role_was_able_to_execute_web_rpc",
    );
    await assertNoDraftChange(
      database,
      serviceRoleBefore,
      allHouseholds,
      allMembers,
      "service_role_attempt_created_draft",
    );
    console.log("PASS service_role cannot execute the authenticated Web RPC");
    passCount += 1;

    const anonBefore = await draftCount(database, allHouseholds, allMembers);
    const anonAttempt = await anon.rpc(
      "fn_create_web_agent_draft",
      rpcDraftArguments(
        userA.households[0],
        userA.members[0],
        crypto.randomUUID(),
        `jwt-route-negative:${manifest.runId}:anon`,
      ),
    );
    requireCondition(
      Boolean(anonAttempt.error),
      "anon_was_able_to_execute_web_rpc",
    );
    await assertNoDraftChange(
      database,
      anonBefore,
      allHouseholds,
      allMembers,
      "anon_attempt_created_draft",
    );
    console.log("PASS anon cannot execute the authenticated Web RPC");
    passCount += 1;

    const finalDraft = await verifyPositiveDraft(
      database,
      userA,
      userA.households[0],
      userA.members[0],
    );
    requireCondition(
      finalDraft.draftId === positiveDraft.draftId,
      "negative_tests_changed_positive_draft",
    );
    console.log(
      "PASS negative cases preserved the sole positive test-owned draft",
    );
    passCount += 1;
  } catch (error) {
    const phase = error instanceof HarnessFailure ? error.phase : "test";
    const code =
      error instanceof HarnessFailure
        ? error.code
        : "unexpected_harness_failure";
    console.log(`${phase === "preflight" ? "BLOCKED" : "FAIL"} ${code}`);
    if (error instanceof HarnessFailure && error.safeDetail) {
      console.log(`NEXT_DETAIL ${error.safeDetail}`);
    }
    failureCode = code;
    process.exitCode = phase === "preflight" ? 2 : 1;
  } finally {
    try {
      await stopNext(nextChild);
    } catch {
      cleanupFailure = true;
    }
    if (admin && database && fixtures.length) {
      try {
        await cleanupFixtures(admin, database);
        cleanupDone = true;
      } catch {
        cleanupFailure = true;
      }
    } else if (fixtures.length) {
      cleanupFailure = true;
    }
    if (database) {
      try {
        await database.end();
      } catch {
        cleanupFailure = true;
      }
    }
    if (sandboxRoot && !cleanupFailure && (!fixtures.length || cleanupDone)) {
      try {
        await removeTestSandbox(sandboxRoot);
      } catch {
        cleanupFailure = true;
      }
    }
    if (cleanupFailure) {
      console.log(
        `CLEANUP INCOMPLETE manifest=${sandboxRoot ? path.basename(sandboxRoot) : "unavailable"}`,
      );
      process.exitCode = 1;
    } else if (fixtures.length) {
      console.log(
        "PASS test-owned Auth users, memberships, households, and drafts cleaned and verified",
      );
      passCount += 1;
    }
  }

  if (cleanupFailure) return;
  if (process.exitCode === 2) console.log("RESULT BLOCKED cases=0");
  else if (process.exitCode === 1)
    console.log(
      `RESULT FAIL code=${failureCode ?? "unknown"} cases=${passCount}`,
    );
  else console.log(`RESULT PASS cases=${passCount}`);
}

main().catch(() => {
  console.log("FAIL unexpected_harness_failure");
  process.exitCode = 1;
});
