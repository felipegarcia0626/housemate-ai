// Disposable embedded PostgreSQL only. Never loads .env or accepts a remote URL.
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const root = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function describeCleanupError(stage, error) {
  const description = {
    stage,
    code: error?.code ?? "UNKNOWN",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  };
  if (["postgres.process_tree.capture", "databaseDir.remove"].includes(stage) && error?.processTreeCapture) {
    description.diagnostics = error.processTreeCapture;
  }
  return description;
}

async function removeExactDatabaseDirectory(databaseDir, ensurePostgresTreeExited) {
  const retryableErrors = new Set(["EBUSY", "ENOTEMPTY"]);
  const maxAttempts = 10;
  const delayMs = 200;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await ensurePostgresTreeExited();
    try {
      await fs.rm(databaseDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retryableErrors.has(error.code) || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function quotePowerShellString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createProcessTreeCaptureError(reason, command, args, details = {}) {
  const operation = details.operation ?? "PostgreSQL process tree capture";
  const error = new Error(`${operation} failed (${reason}).`);
  error.name = "ProcessTreeCaptureError";
  error.code = details.code ?? "UNKNOWN";
  error.processTreeCapture = {
    operation,
    reason,
    command: { executable: command, args },
    timeoutMs: details.timeoutMs ?? null,
    elapsedMs: details.elapsedMs ?? null,
    killed: details.killed ?? null,
    originalCode: details.originalCode ?? null,
    signal: details.signal ?? null,
    message: details.originalMessage ?? null,
    stdout: details.stdout ?? "",
    stderr: details.stderr ?? "",
    exitCode: details.exitCode ?? null,
    stack: details.originalStack ?? null,
    lifecycleEvents: details.lifecycleEvents ?? [],
  };
  return error;
}

async function getPostgresProcessTreeIds(childProcess, databaseDir) {
  if (!childProcess?.pid) throw new Error("Embedded PostgreSQL child PID is unavailable.");
  if (process.platform !== "win32") return [childProcess.pid];

  const script = `
$ErrorActionPreference = 'Stop'
$rootPid = ${Number(childProcess.pid)}
$databaseDir = ${quotePowerShellString(databaseDir)}
$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
$root = $processes | Where-Object { [int]$_.ProcessId -eq $rootPid }
if ($null -eq $root -or $root.Name -ne 'postgres.exe' -or [string]::IsNullOrEmpty($root.CommandLine) -or $root.CommandLine.IndexOf($databaseDir, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
  [Console]::Error.WriteLine('Could not verify the PostgreSQL root process for this temporary database directory.')
  exit 3
}
$ids = [System.Collections.Generic.List[int]]::new()
[void]$ids.Add($rootPid)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($candidate in $processes) {
    if ($ids.Contains([int]$candidate.ParentProcessId) -and -not $ids.Contains([int]$candidate.ProcessId)) {
      [void]$ids.Add([int]$candidate.ProcessId)
      $changed = $true
    }
  }
}
[Console]::WriteLine([string]::Join(',', [string[]]($ids | Sort-Object -Unique)))
`;
  const command = "powershell.exe";
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const PROCESS_TREE_CAPTURE_TIMEOUT_MS = 15_000;
  const timeoutMs = PROCESS_TREE_CAPTURE_TIMEOUT_MS;
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  let result;
  try {
    result = await execFileAsync(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024,
    });
  } catch (error) {
    const exitCode = typeof error?.code === "number" ? error.code : null;
    const reason = exitCode !== null
      ? (exitCode === 3 ? "root_process_mismatch" : "powershell_query_failed")
      : "powershell_execution_failed";
    throw createProcessTreeCaptureError(reason, command, args, {
      code: error?.code,
      originalCode: error?.code,
      timeoutMs,
      elapsedMs: elapsedMs(),
      killed: error?.killed,
      stdout: error?.stdout,
      stderr: error?.stderr,
      exitCode,
      signal: error?.signal,
      originalMessage: error?.message ?? String(error),
      originalStack: error?.stack,
    });
  }

  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const durationMs = elapsedMs();
  const output = stdout.trim();
  if (!output) {
    throw createProcessTreeCaptureError("empty_output", command, args, {
      timeoutMs, elapsedMs: durationMs, stdout, stderr,
    });
  }

  const values = output.split(",");
  const ids = values.map((value) => Number(value.trim()));
  if (values.some((value) => !value.trim() || !Number.isSafeInteger(Number(value.trim())) || Number(value.trim()) <= 0)) {
    throw createProcessTreeCaptureError("invalid_output", command, args, {
      timeoutMs, elapsedMs: durationMs, stdout, stderr,
    });
  }
  if (!ids.includes(childProcess.pid)) {
    throw createProcessTreeCaptureError("root_pid_missing", command, args, {
      timeoutMs, elapsedMs: durationMs, stdout, stderr,
    });
  }
  return ids;
}

async function findActiveProcessIds(processIds) {
  if (processIds.length === 0) return [];
  if (process.platform !== "win32") {
    return processIds.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        if (error.code === "EPERM") return true;
        throw error;
      }
    });
  }

  const ids = processIds.join(",");
  const script = `
$ErrorActionPreference = 'Stop'
$processIds = @(${ids})
$active = [System.Collections.Generic.List[int]]::new()
foreach ($processId in $processIds) {
  try {
    foreach ($process in @(Get-Process -Id ([int]$processId) -ErrorAction Stop)) {
      [void]$active.Add([int]$process.Id)
    }
  } catch {
    if ($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound) {
      throw
    }
  }
}
$activeIds = @($active | Sort-Object -Unique)
[Console]::WriteLine([string]::Join(',', [string[]]$activeIds))
`;
  const command = "powershell.exe";
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const timeoutMs = 10_000;
  const startedAt = process.hrtime.bigint();
  const lifecycleEvents = [];
  let child = null;
  const recordLifecycleEvent = (event, details = {}) => {
    lifecycleEvents.push({
      elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      pid: child?.pid ?? null,
      event,
      timeoutMs,
      ...details,
    });
  };
  const commandPromise = execFileAsync(command, args, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024,
  });
  child = commandPromise.child ?? null;
  if (child) {
    child.once("spawn", () => recordLifecycleEvent("spawn"));
    child.once("error", (error) => recordLifecycleEvent("error", {
      code: error?.code ?? null,
      message: error?.message ?? String(error),
    }));
    child.once("exit", (code, signal) => recordLifecycleEvent("exit", { code, signal }));
    child.once("close", (code, signal) => recordLifecycleEvent("close", { code, signal }));
  } else {
    recordLifecycleEvent("child_unavailable");
  }

  let result;
  try {
    result = await commandPromise;
  } catch (error) {
    const exitCode = typeof error?.code === "number" ? error.code : null;
    throw createProcessTreeCaptureError(
      exitCode === null ? "powershell_execution_failed" : "powershell_query_failed",
      command,
      args,
      {
        operation: "Pre-removal PostgreSQL process verification",
        code: error?.code,
        originalCode: error?.code,
        timeoutMs,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        killed: error?.killed,
        stdout: error?.stdout,
        stderr: error?.stderr,
        exitCode,
        signal: error?.signal,
        originalMessage: error?.message ?? String(error),
        originalStack: error?.stack,
        lifecycleEvents,
      },
    );
  }
  const stdout = String(result.stdout ?? "");
  return stdout.trim() ? stdout.trim().split(",").map(Number) : [];
}

async function ensurePostgresTreeExited(processIds) {
  const deadline = Date.now() + 5000;
  let active = processIds;
  do {
    active = await findActiveProcessIds(processIds);
    if (active.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`PostgreSQL process tree is still active (PIDs: ${active.join(",")}); temporary directory was not removed.`);
}

async function main() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const databaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "housemate-invitation-local-"));
  const postgres = new EmbeddedPostgres({ databaseDir, port: await freePort(), user: "postgres",
    password: "local-test-only", authMethod: "password", persistent: true, onLog: () => {}, onError: () => {} });
  const clients = [];
  let primaryError = null;
  const connect = async () => {
    const client = postgres.getPgClient("housemate_test");
    clients.push(client);
    await client.connect();
    await client.query("SET statement_timeout = '10s'");
    return client;
  };
  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("housemate_test");
    const controller = await connect();
    await controller.query("CREATE ROLE service_role NOLOGIN; CREATE PUBLICATION supabase_realtime");
    const directory = path.join(root, "database/migrations");
    const migrations = (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of migrations) {
      if (file === "0030_household_membership_lifecycle.sql") {
        await controller.query(await fs.readFile(path.join(root, "tests/fixtures/0030_household_legacy_fixture.sql"), "utf8"));
      }
      await controller.query(await fs.readFile(path.join(directory, file), "utf8"));
    }
    const fixture = await fs.readFile(path.join(root, "tests/fixtures/0038_invitation_idempotency_fixture.sql"), "utf8");
    const sql = await fs.readFile(path.join(root, "tests/phase-3-invitation-idempotency.sql"), "utf8");
    await controller.query(sql.replace("\\ir fixtures/0038_invitation_idempotency_fixture.sql", fixture));
    console.log("PASS invitation SQL creation, recovery, isolation, conflicts, expiry retention and transaction rollback");

    await controller.query(fixture);
    const first = await connect();
    const second = await connect();
    await first.query("SET application_name = 'invitation-race-a'");
    await second.query("SET application_name = 'invitation-race-b'");
    await controller.query("BEGIN; SELECT id FROM public.tb_users WHERE id='d2000000-0000-4000-8000-000000000001' FOR UPDATE");
    const statement = "SELECT public.fn_create_household_invitation($1::uuid,$2::uuid,$3,$4,now()+interval '7 days',$5::uuid) AS result";
    const parameters = ["d1000000-0000-4000-8000-000000000001", "d3000000-0000-4000-8000-000000000001",
      "recipient-idempotency@example.test", "race-first-private-hash", "d5000000-0000-4000-8000-000000000009"];
    const pending = [first.query(statement, parameters), second.query(statement, [...parameters.slice(0, 3), "race-second-private-hash", parameters[4]])];
    const settled = Promise.allSettled(pending);
    try {
      const deadline = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const result = await controller.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name IN ('invitation-race-a','invitation-race-b') AND wait_event_type='Lock'");
        waiting = result.rows[0].count;
        if (waiting === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, 2, "both database sessions must actually contend before releasing the lock");
    } finally {
      await controller.query("ROLLBACK");
    }
    const results = await settled;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const outcomes = results.map((result) => result.value.rows[0].result);
    assert.deepEqual(outcomes.map((result) => result.outcome).sort(), ["CREATED", "RECOVERED"]);
    assert.equal(outcomes[0].invitationId, outcomes[1].invitationId);
    const counts = await controller.query("SELECT (SELECT count(*)::int FROM public.tb_household_invitations WHERE id=$1::uuid) AS invitations, (SELECT count(*)::int FROM public.tb_notifications WHERE source_entity_id=$1::uuid AND type='HOUSEHOLD_INVITATION_RECEIVED') AS notifications", [outcomes[0].invitationId]);
    assert.deepEqual(counts.rows[0], { invitations: 1, notifications: 1 });
    console.log("PASS real concurrent PostgreSQL requests persist exactly one invitation and one notification");
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  for (const [index, client] of clients.entries()) {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      cleanupErrors.push(describeCleanupError(`client[${index}].rollback`, error));
    }
    try {
      await client.end();
    } catch (error) {
      cleanupErrors.push(describeCleanupError(`client[${index}].end`, error));
    }
  }

  // embedded-postgres.stop() waits for its root ChildProcess, but on Windows it
  // launches taskkill without awaiting that process and then may delete the
  // directory while PostgreSQL descendants still hold files. Keep the cluster
  // persistent from the library's perspective and remove only our exact temp
  // directory after verifying the full process tree has exited.
  const postgresProcess = postgres.process;
  let postgresProcessIds = [];
  let processTreeVerified = !postgresProcess?.pid;
  if (postgresProcess?.pid) {
    try {
      postgresProcessIds = await getPostgresProcessTreeIds(postgresProcess, databaseDir);
      processTreeVerified = true;
    } catch (error) {
      cleanupErrors.push(describeCleanupError("postgres.process_tree.capture", error));
    }
  }
  try {
    await postgres.stop();
  } catch (error) {
    cleanupErrors.push(describeCleanupError("postgres.stop", error));
  }
  if (processTreeVerified) {
    try {
      await removeExactDatabaseDirectory(databaseDir, () => ensurePostgresTreeExited(postgresProcessIds));
    } catch (cleanupError) {
      cleanupErrors.push(describeCleanupError("databaseDir.remove", cleanupError));
    }
  } else {
    cleanupErrors.push({
      stage: "databaseDir.remove.skipped",
      code: "PROCESS_TREE_NOT_VERIFIED",
      message: "The PostgreSQL process tree could not be verified; its temporary directory was left untouched.",
      stack: null,
    });
  }

  if (cleanupErrors.length > 0) {
    const cleanupMessage = cleanupErrors
      .map(({ stage, code, message, stack, diagnostics }) => {
        const diagnosticText = diagnostics
          ? `\noperation: ${diagnostics.operation}\nreason: ${diagnostics.reason}\ncommand: ${JSON.stringify(diagnostics.command)}\nelapsedMs: ${diagnostics.elapsedMs ?? "unavailable"}\ntimeoutMs: ${diagnostics.timeoutMs ?? "unavailable"}\nkilled: ${diagnostics.killed ?? "unavailable"}\noriginalCode: ${diagnostics.originalCode ?? "unavailable"}\nexitCode: ${diagnostics.exitCode ?? "unavailable"}\nsignal: ${diagnostics.signal ?? "unavailable"}\nmessage: ${diagnostics.message ?? "unavailable"}\nstdout: ${diagnostics.stdout}\nstderr: ${diagnostics.stderr}\nlifecycleEvents: ${JSON.stringify(diagnostics.lifecycleEvents ?? [])}${diagnostics.stack ? `\noriginalStack:\n${diagnostics.stack}` : ""}`
          : "";
        return `${stage} (${code}): ${message}${diagnosticText}${stack ? `\n${stack}` : ""}`;
      })
      .join("\n");
    if (primaryError) {
      primaryError.cleanupErrors = cleanupErrors;
      console.error(`Local PostgreSQL cleanup also failed; original test error preserved.\n${cleanupMessage}`);
    } else {
      primaryError = new Error(`Local PostgreSQL cleanup incomplete.\n${cleanupMessage}`);
      primaryError.cleanupErrors = cleanupErrors;
    }
  }

  if (primaryError) throw primaryError;
}

main().catch((error) => {
  console.error(`FAIL invitation local SQL: ${error.message}`);
  if (error.stack && !error.message.includes(error.stack)) console.error(error.stack);
  process.exitCode = 1;
});
