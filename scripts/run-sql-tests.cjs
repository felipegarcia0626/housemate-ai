const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");
const databaseDirectoryPrefix = "housemate-ai-sql-";
const postgresHost = "127.0.0.1";
const postgresStopTimeoutMs = 30_000;

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    const finish = (error, port) => {
      if (settled) return;
      settled = true;

      const complete = (closeError) => {
        if (error && closeError) {
          reject(
            new AggregateError(
              [error, closeError],
              "Port selection failed and its probe socket also failed to close.",
              { cause: error },
            ),
          );
        } else if (error) {
          reject(error);
        } else if (closeError) {
          reject(closeError);
        } else {
          resolve(port);
        }
      };

      if (!server.listening) {
        complete();
        return;
      }

      try {
        server.close(complete);
      } catch (closeError) {
        complete(closeError);
      }
    };

    server.once("error", (error) => finish(error));

    try {
      server.listen(0, postgresHost, () => {
        try {
          const address = server.address();

          if (!address || typeof address === "string") {
            finish(new Error("Could not determine a free port."));
            return;
          }

          finish(null, address.port);
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

async function sqlFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function expandPsqlIncludes(filePath, stack = []) {
  const absolutePath = path.resolve(filePath);

  if (stack.includes(absolutePath)) {
    throw new Error(
      `Circular SQL include detected: ${[...stack, absolutePath].join(" -> ")}`,
    );
  }

  const source = await fs.readFile(absolutePath, "utf8");
  const lines = source.split(/\r?\n/);
  const expanded = [];

  for (const line of lines) {
    const includeMatch = line.match(/^\s*\\ir\s+(.+?)\s*$/);

    if (!includeMatch) {
      expanded.push(line);
      continue;
    }

    const includePath = path.resolve(
      path.dirname(absolutePath),
      includeMatch[1],
    );
    expanded.push(
      await expandPsqlIncludes(includePath, [...stack, absolutePath]),
    );
  }

  return expanded.join("\n");
}

async function runSqlFile(client, filePath, label, lifecycle = null) {
  if (lifecycle) throwIfSignalRequested(lifecycle);
  const sql = await expandPsqlIncludes(filePath);
  if (lifecycle) throwIfSignalRequested(lifecycle);

  try {
    await client.query(sql);
  } catch (error) {
    const position = Number(error.position ?? error.internalPosition);
    const source = error.internalPosition ? error.internalQuery : sql;
    const line =
      Number.isInteger(position) && position > 0 && source
        ? source.slice(0, position - 1).split("\n").length
        : null;
    const location = line ? ` (line ${line})` : "";
    throw new Error(`${label}${location}: ${error.message}`, { cause: error });
  }

  if (lifecycle) throwIfSignalRequested(lifecycle);

  console.log(`PASS ${label}`);
}

async function runLifecycleHarness(lifecycle, harnessPath, postgres) {
  throwIfSignalRequested(lifecycle);
  await require(harnessPath)(postgres);
  throwIfSignalRequested(lifecycle);
}

function samePath(left, right, platform = process.platform) {
  const normalizedLeft = path.resolve(left).replace(/[\\/]+$/, "");
  const normalizedRight = path.resolve(right).replace(/[\\/]+$/, "");

  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertOwnedDatabaseDirectory(
  databaseDir,
  temporaryDirectory = os.tmpdir(),
  platform = process.platform,
) {
  const resolvedDirectory = path.resolve(databaseDir);
  const resolvedParent = path.dirname(resolvedDirectory);
  const directoryName = path.basename(resolvedDirectory);

  if (
    !samePath(resolvedParent, temporaryDirectory, platform) ||
    !directoryName.startsWith(databaseDirectoryPrefix) ||
    directoryName.length <= databaseDirectoryPrefix.length
  ) {
    throw new Error(
      "Refusing to remove a database directory that is not this runner's temporary directory.",
    );
  }

  return resolvedDirectory;
}

async function removeDatabaseDirectory(
  databaseDir,
  { temporaryDirectory = os.tmpdir(), platform = process.platform } = {},
) {
  const ownedDirectory = assertOwnedDatabaseDirectory(
    databaseDir,
    temporaryDirectory,
    platform,
  );
  const retryableErrors = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(ownedDirectory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retryableErrors.has(error.code) || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function childProcessWasSpawned(child) {
  return Number.isInteger(child?.pid) && child.pid > 0;
}

function childProcessHasExited(child) {
  if (!childProcessWasSpawned(child)) return false;
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function capturePostgresProcess(state) {
  const child = state.postgres?.process ?? state.processHandle ?? null;
  if (child) state.processHandle = child;

  if (childProcessWasSpawned(child)) {
    state.processSpawned = true;
    if (state.pid !== child.pid) {
      state.pid = child.pid;
      console.log(
        "[sql-runner] postgres-pid=" + state.pid + " stage=" + state.stage,
      );
    }
  }
}

function signalNames(platform = process.platform) {
  return platform === "win32"
    ? ["SIGHUP", "SIGINT", "SIGTERM", "SIGBREAK"]
    : ["SIGHUP", "SIGINT", "SIGTERM"];
}

function installSignalHandlers(state) {
  for (const signal of signalNames()) {
    const handler = () => {
      state.signalCount += 1;
      if (!state.signalError) {
        const exitCodes = {
          SIGHUP: 129,
          SIGINT: 130,
          SIGTERM: 143,
          SIGBREAK: 149,
        };
        state.signalError = new Error(
          "Received " + signal + " while runner stage was " + state.stage + ".",
        );
        state.signalError.signal = signal;
        state.signalError.exitCode = exitCodes[signal] ?? 1;
      }
      console.error(
        "[sql-runner] termination signal observed count=" +
          state.signalCount +
          " signal=" +
          signal +
          " stage=" +
          state.stage,
      );
    };

    process.on(signal, handler);
    state.signalHandlers.push([signal, handler]);
  }
}

function removeSignalHandlers(state) {
  const errors = [];
  for (const [signal, handler] of state.signalHandlers) {
    try {
      process.removeListener(signal, handler);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  state.signalHandlers = [];
  return errors;
}

function throwIfSignalRequested(state) {
  if (state.signalError) throw state.signalError;
}

function exitCodeForFailure(error) {
  return error?.signalExitCode ?? error?.exitCode ?? 1;
}

function unhookEmbeddedPostgresSignalHandlers() {
  const embeddedPostgresEntry = require.resolve("embedded-postgres");
  const embeddedRequire = createRequire(embeddedPostgresEntry);
  const asyncExitHook = embeddedRequire("async-exit-hook");
  const hookEvents = asyncExitHook.hookedEvents();
  const removedSignals = [];

  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGBREAK"]) {
    if (hookEvents.includes(signal)) {
      asyncExitHook.unhookEvent(signal);
      removedSignals.push(signal);
    }
  }

  if (removedSignals.length === 0) {
    throw new Error(
      "Could not transfer embedded-postgres signal handling to the SQL runner.",
    );
  }

  return removedSignals;
}

async function verifyPostgresIdentity(client, state) {
  const expectedDirectory = await fs.realpath(state.databaseDir);
  const { rows } = await client.query(`
    SELECT
      host(inet_server_addr()) AS server_address,
      inet_server_port() AS server_port,
      current_setting('listen_addresses') AS listen_addresses,
      current_setting('unix_socket_directories') AS unix_socket_directories,
      current_setting('data_directory') AS data_directory
  `);
  const server = rows[0];
  if (
    rows.length !== 1 ||
    server.server_address !== postgresHost ||
    server.server_port !== state.port ||
    server.listen_addresses !== postgresHost ||
    server.unix_socket_directories !== "" ||
    typeof server.data_directory !== "string" ||
    !path.isAbsolute(server.data_directory)
  ) {
    throw new Error("Could not verify the temporary PostgreSQL IPv4 endpoint.");
  }

  const serverDirectory = await fs.realpath(server.data_directory);
  if (serverDirectory !== expectedDirectory) {
    throw new Error("PostgreSQL data directory does not match this run's cluster.");
  }
}

function createVerifiedPostgresClientFactory(state, createClient) {
  if (typeof createClient !== "function") {
    throw new TypeError("A PostgreSQL client constructor is required.");
  }

  return Object.freeze({
    getPgClient(database) {
      const rawClient = createClient(database);
      if (
        !rawClient ||
        typeof rawClient.connect !== "function" ||
        typeof rawClient.query !== "function" ||
        typeof rawClient.end !== "function"
      ) {
        throw new TypeError("The PostgreSQL client does not implement the required API.");
      }

      let verified = false;
      let connectionPromise = null;
      let closePromise = null;
      let connectionFailure = null;

      const closeRawClient = () => {
        if (!closePromise) {
          closePromise = Promise.resolve().then(() => rawClient.end());
        }
        return closePromise;
      };

      const connectAndVerify = () => {
        if (!connectionPromise) {
          connectionPromise = (async () => {
            try {
              await rawClient.connect();
              await verifyPostgresIdentity(rawClient, state);
              verified = true;
            } catch (error) {
              const primaryError =
                error instanceof Error ? error : new Error(String(error));
              try {
                await closeRawClient();
              } catch (closeError) {
                const secondaryError =
                  closeError instanceof Error
                    ? closeError
                    : new Error(String(closeError));
                const failure = new AggregateError(
                  [primaryError, secondaryError],
                  "PostgreSQL connection or identity verification failed, and closing the unverified session also failed: " +
                    primaryError.message +
                    "; close failure: " +
                    secondaryError.message,
                  { cause: primaryError },
                );
                failure.primaryError = primaryError;
                failure.closeError = secondaryError;
                connectionFailure = failure;
                throw failure;
              }
              connectionFailure = primaryError;
              throw primaryError;
            }
          })();
        }
        return connectionPromise;
      };

      const connect = (callback) => {
        if (callback !== undefined && typeof callback !== "function") {
          throw new TypeError("The PostgreSQL connect callback must be a function.");
        }
        const pending = connectAndVerify();
        if (callback) {
          pending.then(
            () => callback(null),
            (error) => callback(error),
          );
          return undefined;
        }
        return pending;
      };

      const query = (...args) => {
        if (!verified) {
          const error = new Error(
            "PostgreSQL identity must be verified by connect() before queries are allowed.",
          );
          const callback = args[args.length - 1];
          if (typeof callback === "function") {
            queueMicrotask(() => callback(error));
            return undefined;
          }
          return Promise.reject(error);
        }
        return rawClient.query(...args);
      };

      const end = (callback) => {
        if (callback !== undefined && typeof callback !== "function") {
          throw new TypeError("The PostgreSQL end callback must be a function.");
        }
        const pending = connectionFailure
          ? Promise.reject(connectionFailure)
          : closeRawClient();
        if (callback) {
          pending.then(
            () => callback(),
            (error) => callback(error),
          );
          return undefined;
        }
        return pending;
      };

      // Keep the driver's client private. Consumers get only this gated API;
      // connect() resolves after identity verification on the same session.
      return Object.freeze({ connect, query, end });
    },
  });
}

async function preparePostgresLifecycle(state) {
  state.stage = "load-embedded-postgres";
  const EmbeddedPostgres = (await import("embedded-postgres")).default;
  const removedSignalHooks = unhookEmbeddedPostgresSignalHandlers();
  console.log(
    "[sql-runner] embedded-postgres signal hooks transferred to runner " +
      "cleanup: " +
      JSON.stringify(removedSignalHooks),
  );
  throwIfSignalRequested(state);

  state.stage = "create-database-directory";
  const prefix = path.join(state.temporaryDirectory, databaseDirectoryPrefix);
  state.databaseDir = await fs.mkdtemp(prefix);
  state.directoryCreated = true;
  assertOwnedDatabaseDirectory(state.databaseDir, state.temporaryDirectory);
  console.log("[sql-runner] database-directory=" + JSON.stringify(state.databaseDir));
  throwIfSignalRequested(state);

  state.stage = "select-port";
  state.port = await findFreePort();
  throwIfSignalRequested(state);
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) {
    throw new Error("The local PostgreSQL port probe returned an invalid port.");
  }
  console.log(
    "[sql-runner] port-selected=" +
      state.port +
      " bind-race=possible-after-probe-socket-close",
  );

  state.stage = "construct-embedded-postgres";
  state.postgres = new EmbeddedPostgres({
    databaseDir: state.databaseDir,
    port: state.port,
    user: "postgres",
    password: randomBytes(32).toString("hex"),
    authMethod: "password",
    postgresFlags: [
      "-c",
      "wal_level=logical",
      "-c",
      `listen_addresses=${postgresHost}`,
      "-c",
      "unix_socket_directories=",
    ],
    persistent: true,
    onLog: () => {},
    onError: (error) => {
      if (process.env.DEBUG_SQL_TESTS === "1") console.error(error);
    },
  });
  throwIfSignalRequested(state);

  state.stage = "initialize-postgres";
  state.initialiseAttempted = true;
  await state.postgres.initialise();
  state.initialized = true;
  throwIfSignalRequested(state);

  state.stage = "start-postgres";
  state.startAttempted = true;
  try {
    await state.postgres.start();
    state.processStarted = true;
  } finally {
    capturePostgresProcess(state);
  }
  throwIfSignalRequested(state);

  // The dependency's createDatabase/dropDatabase helpers use localhost.
  // Keep its client private and verify every session created for the suite.
  const postgresClients = createVerifiedPostgresClientFactory(
    state,
    (database) => state.postgres.getPgClient(database, postgresHost),
  );
  state.stage = "verify-postgres-identity";
  const maintenanceClient = postgresClients.getPgClient("postgres");
  try {
    await maintenanceClient.connect();
    throwIfSignalRequested(state);
    console.log("[sql-runner] postgres-identity-verified host=" + postgresHost);

    // Use the verified session for the first write.
    state.stage = "create-test-database";
    await maintenanceClient.query("CREATE DATABASE housemate_test");
  } finally {
    await maintenanceClient.end();
  }
  throwIfSignalRequested(state);
  return postgresClients;
}

async function stopPostgres(state) {
  if (!state.postgres) return { kind: "not-started" };

  if (childProcessHasExited(state.processHandle)) {
    return { kind: "already-exited" };
  }

  if (!state.processStarted && !state.startAttempted) {
    return { kind: "not-started" };
  }

  const stopPromise = Promise.resolve()
    .then(() => state.postgres.stop())
    .then(
      () => ({ kind: "stopped" }),
      (error) => ({ kind: "error", error }),
    );

  if (state.supervised) {
    const outcome = await stopPromise;
    capturePostgresProcess(state);
    return outcome;
  }

  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "timeout" }),
      postgresStopTimeoutMs,
    );
  });

  try {
    const outcome = await Promise.race([stopPromise, timeoutPromise]);
    capturePostgresProcess(state);
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

function createLifecycleFailure(primaryError, cleanupErrors, state) {
  const errors = [];
  if (primaryError) errors.push(primaryError);
  errors.push(...cleanupErrors);
  if (errors.length === 0) return null;

  const descriptions = errors.map((error, index) => {
    const label =
      primaryError && index === 0
        ? "primary failure at " + state.failureStage
        : "cleanup failure " + (primaryError ? index : index + 1);
    return label + ": " + (error.message ?? String(error));
  });
  const failure = new AggregateError(
    errors,
    descriptions.join("; "),
    { cause: primaryError ?? cleanupErrors[0] },
  );
  failure.primaryError = primaryError;
  failure.cleanupErrors = cleanupErrors;
  failure.signalExitCode = state.signalError?.exitCode;
  return failure;
}

async function runWithPostgresLifecycle(
  runSuite,
  { temporaryDirectory = os.tmpdir(), supervised = false } = {},
) {
  const state = {
    stage: "not-started",
    temporaryDirectory,
    supervised,
    databaseDir: null,
    directoryCreated: false,
    port: null,
    postgres: null,
    initialiseAttempted: false,
    initialized: false,
    startAttempted: false,
    processStarted: false,
    processSpawned: false,
    processHandle: null,
    pid: null,
    signalCount: 0,
    signalError: null,
    signalHandlers: [],
    failureStage: null,
  };
  let primaryError = null;
  const cleanupErrors = [];

  try {
    installSignalHandlers(state);
    const postgresClients = await preparePostgresLifecycle(state);
    state.stage = "run-sql-suite";
    await runSuite({ postgres: postgresClients, lifecycle: state });
    throwIfSignalRequested(state);
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    state.failureStage = state.stage;
    if (
      state.signalError &&
      primaryError !== state.signalError &&
      !primaryError.message.includes(state.signalError.message)
    ) {
      primaryError = new AggregateError(
        [primaryError, state.signalError],
        "SQL execution was interrupted by " + state.signalError.signal + ".",
        { cause: primaryError },
      );
    }
  } finally {
    state.stage = "cleanup-postgres";
    let processStopped = false;
    try {
      if (!state.postgres) {
        processStopped = true;
      } else if (state.initialiseAttempted && !state.initialized) {
        console.error(
          "[sql-runner] retaining database directory; embedded-postgres does not expose initdb process ownership; " +
            (supervised
              ? "the supervisor will remove it only after the Job is empty"
              : "manual cleanup is required"),
        );
      } else {
        const outcome = await stopPostgres(state);
        capturePostgresProcess(state);
        if (outcome.kind === "error") cleanupErrors.push(outcome.error);
        if (outcome.kind === "timeout") {
          cleanupErrors.push(
            new Error(
              "PostgreSQL stop exceeded " +
                postgresStopTimeoutMs +
                "ms; database directory retained.",
            ),
          );
        } else if (outcome.kind === "already-exited" && !primaryError) {
          cleanupErrors.push(
            new Error("PostgreSQL exited before runner cleanup."),
          );
        }

        processStopped =
          outcome.kind === "not-started" ||
          (state.processSpawned && childProcessHasExited(state.processHandle)) ||
          (outcome.kind === "stopped" && !state.startAttempted);
        if (!processStopped && outcome.kind !== "error" && outcome.kind !== "timeout") {
          cleanupErrors.push(
            new Error(
              "PostgreSQL process exit could not be confirmed; database directory retained.",
            ),
          );
        }
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }

    if (state.directoryCreated) {
      if (processStopped) {
        state.stage = "remove-database-subdirectory";
        try {
          await removeDatabaseDirectory(state.databaseDir, {
            temporaryDirectory,
          });
          console.log("[sql-runner] database-directory-removed");
        } catch (error) {
          cleanupErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      } else {
        console.error(
          "[sql-runner] database-subdirectory-retained; " +
            (supervised
              ? "the supervisor will remove it only after the Job is empty"
              : "manual cleanup is required because process exit was not confirmed"),
        );
      }
    }

    state.stage = "remove-signal-handlers";
    cleanupErrors.push(...removeSignalHandlers(state));
  }

  if (state.signalError && !primaryError) {
    primaryError = state.signalError;
    state.failureStage = state.signalError.stage ?? "signal";
  }
  const failure = createLifecycleFailure(primaryError, cleanupErrors, state);
  if (failure) {
    failure.lifecycle = state;
    throw failure;
  }
  return state;
}
async function runSqlSuite(postgres, lifecycle) {
  throwIfSignalRequested(lifecycle);
  const migrationDirectory = path.join(
    repositoryRoot,
    "database",
    "migrations",
  );
  const seedDirectory = path.join(repositoryRoot, "database", "seeds");
  const testDirectory = path.join(repositoryRoot, "tests");
  const fixtureDirectory = path.join(repositoryRoot, "tests", "fixtures");

    const bootstrapClient = postgres.getPgClient("housemate_test");
    await bootstrapClient.connect();
    await bootstrapClient.query("CREATE ROLE service_role NOLOGIN BYPASSRLS");
    // Supabase supplies this publication before migration 0037 in production.
    await bootstrapClient.query("CREATE PUBLICATION supabase_realtime");
    await bootstrapClient.end();
    throwIfSignalRequested(lifecycle);

    for (const migrationPath of await sqlFiles(migrationDirectory)) {
      throwIfSignalRequested(lifecycle);
      lifecycle.stage = `migration ${path.basename(migrationPath)}`;
      const isForensicEvidenceMigration =
        path.basename(migrationPath) ===
        "0059_whatsapp_ambiguous_receipt_evidence.sql";
      const isLegacyIdentityRetirementMigration =
        path.basename(migrationPath) ===
        "0060_whatsapp_legacy_identity_retirement.sql";
      if (path.basename(migrationPath) === "0030_household_membership_lifecycle.sql") {
        const fixturePath = path.join(fixtureDirectory, "0030_household_legacy_fixture.sql");
        const fixtureClient = postgres.getPgClient("housemate_test");
        await fixtureClient.connect();
        try {
          await runSqlFile(
            fixtureClient,
            fixturePath,
            "migration fixture 0030_household_legacy_fixture.sql",
            lifecycle,
          );
        } finally {
          await fixtureClient.end();
        }
      }
      if (isForensicEvidenceMigration) {
        // Backfill fixtures must not leave permanent UNKNOWN/UNCERTAIN blockers
        // in the shared suite database. Exercise the pre-migration backfill in
        // a database clone of the 0058 schema, then discard that whole test DB.
        const forensicDatabase = "housemate_forensic_0059_test";
        const forensicFixturePath = path.join(
          fixtureDirectory,
          "0059_whatsapp_ambiguous_receipts.sql",
        );
        const forensicTestPath = path.join(
          testDirectory,
          "phase-4-whatsapp-receipt-forensic-retention.sql",
        );
        let forensicClient;
        let forensicDatabaseCreated = false;
        try {
          const maintenanceClient = postgres.getPgClient("postgres");
          await maintenanceClient.connect();
          try {
            await maintenanceClient.query(
              `CREATE DATABASE ${forensicDatabase} TEMPLATE housemate_test`,
            );
            forensicDatabaseCreated = true;
          } finally {
            await maintenanceClient.end();
          }
          throwIfSignalRequested(lifecycle);

          forensicClient = postgres.getPgClient(forensicDatabase);
          await forensicClient.connect();
          await runSqlFile(
            forensicClient,
            forensicFixturePath,
            "migration fixture 0059_whatsapp_ambiguous_receipts.sql",
            lifecycle,
          );
          await runSqlFile(
            forensicClient,
            migrationPath,
            `migration ${path.basename(migrationPath)} with historical fixtures`,
            lifecycle,
          );
          await runSqlFile(
            forensicClient,
            forensicTestPath,
            `SQL test ${path.basename(forensicTestPath)} with historical fixtures`,
            lifecycle,
          );
        } finally {
          if (forensicClient) await forensicClient.end();
          if (forensicDatabaseCreated) {
            const maintenanceClient = postgres.getPgClient("postgres");
            await maintenanceClient.connect();
            try {
              await maintenanceClient.query(
                `DROP DATABASE ${forensicDatabase}`,
              );
            } finally {
              await maintenanceClient.end();
            }
          }
        }
      }

      if (isLegacyIdentityRetirementMigration) {
        // Exercise the migration backfill against a pre-0060 database clone so
        // its historical rows never leak into the shared regression database.
        const legacyDatabase = "housemate_legacy_0060_test";
        const legacyFixturePath = path.join(
          fixtureDirectory,
          "0060_whatsapp_verified_link_history.sql",
        );
        const legacyBackfillTestPath = path.join(
          testDirectory,
          "phase-4-whatsapp-legacy-retirement-backfill.sql",
        );
        let legacyClient;
        let legacyDatabaseCreated = false;
        try {
          const maintenanceClient = postgres.getPgClient("postgres");
          await maintenanceClient.connect();
          try {
            await maintenanceClient.query(
              `CREATE DATABASE ${legacyDatabase} TEMPLATE housemate_test`,
            );
            legacyDatabaseCreated = true;
          } finally {
            await maintenanceClient.end();
          }
          throwIfSignalRequested(lifecycle);

          legacyClient = postgres.getPgClient(legacyDatabase);
          await legacyClient.connect();
          await runSqlFile(
            legacyClient,
            legacyFixturePath,
            "migration fixture 0060_whatsapp_verified_link_history.sql",
            lifecycle,
          );
          const legacyFixtureCheck = await legacyClient.query(`
            SELECT
              (SELECT count(*)::int FROM public.tb_users
               WHERE id = '00600000-0060-4000-8000-000000000001'
                 AND external_identifier = '19996600001') AS user_count,
              (SELECT count(*)::int FROM public.tb_whatsapp_links
               WHERE id = '00600000-0060-4000-8000-000000000002'
                 AND user_id = '00600000-0060-4000-8000-000000000001'
                 AND status = 'REVOKED'
                 AND verified_at = '2024-01-01 12:00:00+00') AS link_count
          `);
          if (
            legacyFixtureCheck.rows[0].user_count !== 1 ||
            legacyFixtureCheck.rows[0].link_count !== 1
          ) {
            throw new Error(
              `0060 historical fixture did not persist before migration: ${JSON.stringify(legacyFixtureCheck.rows[0])}`,
            );
          }
          await runSqlFile(
            legacyClient,
            migrationPath,
            `migration ${path.basename(migrationPath)} with historical fixtures`,
            lifecycle,
          );
          await runSqlFile(
            legacyClient,
            legacyBackfillTestPath,
            "SQL test phase-4-whatsapp-legacy-retirement-backfill.sql with historical fixtures",
            lifecycle,
          );
        } finally {
          if (legacyClient) await legacyClient.end();
          if (legacyDatabaseCreated) {
            const maintenanceClient = postgres.getPgClient("postgres");
            await maintenanceClient.connect();
            try {
              await maintenanceClient.query(`DROP DATABASE ${legacyDatabase}`);
            } finally {
              await maintenanceClient.end();
            }
          }
        }
      }

      const client = postgres.getPgClient("housemate_test");
      await client.connect();
      try {
        const isLinkingMigration =
          path.basename(migrationPath) ===
          "0043_whatsapp_linking_persistence.sql";
        const isWebProposalMigration =
          path.basename(migrationPath) ===
          "0054_web_pending_proposal_jwt.sql";
        if (isLinkingMigration) {
          await client.query("CREATE ROLE anon NOLOGIN");
          await client.query("CREATE ROLE authenticated NOLOGIN");

          const roleCheck = await client.query(`
            SELECT count(*)::int AS role_count
            FROM pg_roles
            WHERE rolname = ANY($1::text[])
          `, [["anon", "authenticated", "service_role"]]);
          if (roleCheck.rows[0].role_count !== 3) {
            throw new Error(
              "Supabase application roles must exist before migration 0043",
            );
          }

          // Model the known broad Supabase default ACLs only in this disposable
          // database and schema, so migration 0043 must actively revoke them.
          await client.query(`
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
            GRANT ALL ON TABLES TO anon, authenticated, service_role
          `);
          await client.query(`
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
            GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role
          `);

          const defaultAclCheck = await client.query(`
            SELECT
              (
                SELECT count(DISTINCT r.rolname)::int
                FROM pg_default_acl d
                JOIN pg_namespace n ON n.oid = d.defaclnamespace
                CROSS JOIN LATERAL aclexplode(d.defaclacl) a
                JOIN pg_roles r ON r.oid = a.grantee
                WHERE d.defaclrole = 'postgres'::regrole
                  AND d.defaclobjtype = 'r'
                  AND n.nspname = 'public'
                  AND r.rolname = ANY($1::text[])
                  AND a.privilege_type IN (
                    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                    'REFERENCES', 'TRIGGER'
                  )
              ) AS table_grantee_count,
              (
                SELECT count(DISTINCT r.rolname)::int
                FROM pg_default_acl d
                JOIN pg_namespace n ON n.oid = d.defaclnamespace
                CROSS JOIN LATERAL aclexplode(d.defaclacl) a
                JOIN pg_roles r ON r.oid = a.grantee
                WHERE d.defaclrole = 'postgres'::regrole
                  AND d.defaclobjtype = 'f'
                  AND n.nspname = 'public'
                  AND r.rolname = ANY($1::text[])
                  AND a.privilege_type = 'EXECUTE'
              ) AS function_grantee_count
          `, [["anon", "authenticated", "service_role"]]);
          if (
            defaultAclCheck.rows[0].table_grantee_count !== 3 ||
            defaultAclCheck.rows[0].function_grantee_count !== 3
          ) {
            throw new Error(
              "Scoped Supabase default ACL fixture was not prepared before migration 0043",
            );
          }
          console.log(
            "PASS application roles and scoped default ACLs prepared before migration 0043",
          );
        }
        if (isWebProposalMigration) {
          // Model broad inherited API-role table ACLs on the legacy proposal
          // table so 0054's targeted revoke is exercised rather than vacuous.
          await client.query(`
            GRANT ALL ON TABLE public.tb_pending_proposals
            TO PUBLIC, anon, authenticated
          `);
        }
        // Seeds run later. Populate financial tables before this snapshot so an
        // accidental destructive migration cannot pass against empty tables.
        const fixture = isLinkingMigration
          ? await client.query(`
              SELECT public.fn_create_expense(
                '00000000-0000-4000-8000-000000000001',
                '00000000-0000-4000-8000-000000000021',
                '00000000-0000-4000-8000-000000000021',
                NULL,NULL,NULL,7,current_date,'Link migration fixture','WEB',
                '[{"name":"Fixture","totalAmount":7}]',
                '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":7,"percentage":100}]'
              ) AS expense_id;
            `)
          : null;
        const fixtureIncome = isLinkingMigration
          ? await client.query(`
              INSERT INTO public.tb_incomes(household_id,created_by,member_id,amount,income_date,description)
              VALUES('00000000-0000-4000-8000-000000000001',
                '00000000-0000-4000-8000-000000000021',
                '00000000-0000-4000-8000-000000000021',7,current_date,'Link migration fixture')
              RETURNING id
            `)
          : null;
        const unchangedTables = [
          "tb_users",
          "tb_households",
          "tb_household_members",
          "tb_expenses",
          "tb_expense_items",
          "tb_expense_distributions",
          "tb_incomes",
          "tb_pending_proposals",
          "tb_whatsapp_user_contexts",
        ];
        const snapshot = async () => {
          const digests = [];
          for (const table of unchangedTables) {
            const result = await client.query(
              `SELECT md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) AS digest FROM public.${table} t`,
            );
            digests.push(result.rows[0].digest);
          }
          return digests;
        };
        const beforeLinking = isLinkingMigration ? await snapshot() : null;
        await runSqlFile(
          client,
          migrationPath,
          `migration ${path.basename(migrationPath)}`,
          lifecycle,
        );
        if (isLinkingMigration) {
          const accessCheck = await client.query(`
            WITH expected_tables(table_name) AS (
              VALUES
                ('tb_whatsapp_links'),
                ('tb_whatsapp_link_challenges'),
                ('tb_whatsapp_link_attempt_buckets'),
                ('tb_whatsapp_link_events')
            ),
            expected_functions(signature) AS (
              VALUES
                ('public.fn_whatsapp_link_account(uuid)'::regprocedure),
                ('public.fn_start_whatsapp_link_challenge(uuid,uuid,text,text,uuid)'::regprocedure),
                ('public.fn_cancel_whatsapp_link_challenge(uuid,uuid)'::regprocedure),
                ('public.fn_get_whatsapp_link_state(uuid)'::regprocedure),
                ('public.fn_complete_whatsapp_link_challenge(uuid,text,text,text)'::regprocedure)
            ),
            function_access AS (
              SELECT
                p.proname,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute,
                EXISTS (
                  SELECT 1
                  FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
                ) AS public_execute
              FROM expected_functions e
              JOIN pg_proc p ON p.oid = e.signature
            )
            SELECT
              EXISTS (
                SELECT 1
                FROM expected_tables t
                CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS roles(role_name)
                WHERE has_table_privilege(
                  roles.role_name,
                  format('public.%I', t.table_name),
                  'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                )
              ) AS table_access_remains,
              EXISTS (
                SELECT 1 FROM function_access f
                WHERE f.anon_execute OR f.authenticated_execute OR f.public_execute
                   OR f.service_execute <> (f.proname <> 'fn_whatsapp_link_account')
              ) AS function_access_unexpected
          `);
          if (
            accessCheck.rows[0].table_access_remains ||
            accessCheck.rows[0].function_access_unexpected
          ) {
            throw new Error(
              "Migration 0043 did not remove the expected direct ACLs under the scoped default ACL fixture",
            );
          }
          console.log(
            "PASS migration 0043 revoked direct table and RPC ACLs from client roles while preserving intended service_role EXECUTE",
          );

          // Keep the default ACL simulation limited to migration 0043; it does
          // not change global defaults or affect later migrations in the harness.
          await client.query(`
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
            REVOKE ALL ON TABLES FROM anon, authenticated, service_role
          `);
          await client.query(`
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
            REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role
          `);
        }
        if (
          isLinkingMigration &&
          JSON.stringify(beforeLinking) !== JSON.stringify(await snapshot())
        ) {
          throw new Error(
            "Linking migration changed existing identity or financial data",
          );
        }
        if (isLinkingMigration) {
          await client.query("DELETE FROM public.tb_expenses WHERE id=$1", [
            fixture.rows[0].expense_id,
          ]);
          await client.query("DELETE FROM public.tb_incomes WHERE id=$1", [
            fixtureIncome.rows[0].id,
          ]);
          console.log(
            "PASS linking migration preserves populated identity and financial tables",
          );
        }
      } finally {
        await client.end();
      }
      throwIfSignalRequested(lifecycle);
    }

    lifecycle.stage = "apply-seeds";
    const seedPaths = await sqlFiles(seedDirectory);
    for (let pass = 1; pass <= 2; pass += 1) {
      for (const seedPath of seedPaths) {
        throwIfSignalRequested(lifecycle);
        const client = postgres.getPgClient("housemate_test");
        await client.connect();
        try {
          await runSqlFile(
            client,
            seedPath,
            `seed pass ${pass} ${path.basename(seedPath)}`,
            lifecycle,
          );
        } finally {
          await client.end();
        }
      }
    }

    lifecycle.stage = "run-sql-tests";
    for (const testPath of await sqlFiles(testDirectory)) {
      throwIfSignalRequested(lifecycle);
      if (
        [
          "phase-4-whatsapp-receipt-forensic-retention.sql",
          "phase-4-whatsapp-legacy-retirement-backfill.sql",
        ].includes(path.basename(testPath))
      ) {
        continue;
      }
      const client = postgres.getPgClient("housemate_test");
      await client.connect();
      try {
        await runSqlFile(
          client,
          testPath,
          `SQL test ${path.basename(testPath)}`,
          lifecycle,
        );
      } finally {
        await client.end();
      }
    }
    lifecycle.stage = "web-pending-proposal-concurrency";
    await runLifecycleHarness(
      lifecycle,
      "../tests/web-pending-proposal-concurrency.cjs",
      postgres,
    );
    lifecycle.stage = "financial-eligibility-concurrency";
    await runLifecycleHarness(
      lifecycle,
      "../tests/financial-eligibility-concurrency.cjs",
      postgres,
    );
    lifecycle.stage = "financial-eligibility-races";
    await runLifecycleHarness(
      lifecycle,
      "../tests/financial-eligibility-races.cjs",
      postgres,
    );
    // This test intentionally runs before the other WhatsApp multi-session
    // harnesses, because it proves LINK_ONLY only from a globally clear ledger.
    lifecycle.stage = "whatsapp-admission-barrier-concurrency";
    await runLifecycleHarness(
      lifecycle,
      "../tests/whatsapp-admission-barrier-concurrency.cjs",
      postgres,
    );
    lifecycle.stage = "whatsapp-linking-concurrency";
    await runLifecycleHarness(
      lifecycle,
      "../tests/whatsapp-linking-concurrency.cjs",
      postgres,
    );
    lifecycle.stage = "whatsapp-authorization-concurrency";
    await runLifecycleHarness(
      lifecycle,
      "../tests/whatsapp-authorization-concurrency.cjs",
      postgres,
    );
    lifecycle.stage = "whatsapp-linking-http-sql";
    await runLifecycleHarness(
      lifecycle,
      "../tests/whatsapp-linking-http-sql.cjs",
      postgres,
    );
    lifecycle.stage = "whatsapp-event-recovery-concurrency";
    await runLifecycleHarness(
      lifecycle,
      "../tests/whatsapp-event-recovery-concurrency.cjs",
      postgres,
    );
    lifecycle.stage = "whatsapp-event-http-sql";
    await runLifecycleHarness(
      lifecycle,
      "../tests/whatsapp-event-http-sql.cjs",
      postgres,
    );
}

function powershellExecutablePath() {
  if (process.platform !== "win32") {
    throw new Error("The PowerShell supervisor is available only on Windows.");
  }
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const executable = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!fsSync.existsSync(executable)) {
    throw new Error("Windows PowerShell 5.1 was not found; refusing an unsupervised SQL run.");
  }
  return executable;
}

function runWindowsSupervisor() {
  const powershell = powershellExecutablePath();
  const supervisorScript = path.join(
    repositoryRoot,
    "scripts",
    "run-sql-tests-supervisor.ps1",
  );

  return new Promise((resolve, reject) => {
    const signalHandlers = [];
    const pendingSignals = [];
    let settled = false;
    let supervisor;
    const sendSignal = (exitCode) => {
      if (!supervisor) {
        pendingSignals.push(exitCode);
        return;
      }
      try {
        supervisor.stdin.write(Buffer.from([exitCode]), (error) => {
          if (error) stopOnSignalChannelFailure(error);
        });
      } catch (error) {
        stopOnSignalChannelFailure(error);
      }
    };
    const stopOnSignalChannelFailure = (error) => {
      if (settled) return;
      console.error(
        "[sql-runner] supervisor signal channel failed; terminating only its process handle: " +
          (error?.code ?? error?.message ?? "unknown error"),
      );
      supervisor?.kill();
    };
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGBREAK"]) {
      const handler = () => {
        const exitCodes = {
          SIGHUP: 129,
          SIGINT: 130,
          SIGTERM: 143,
          SIGBREAK: 149,
        };
        sendSignal(exitCodes[signal] ?? 1);
      };
      process.on(signal, handler);
      signalHandlers.push([signal, handler]);
    }
    let listenersRemoved = false;
    const removeListeners = () => {
      if (listenersRemoved) return;
      listenersRemoved = true;
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };

    try {
      supervisor = spawn(
        powershell,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          supervisorScript,
        ],
        {
          cwd: repositoryRoot,
          stdio: ["pipe", "inherit", "inherit"],
          windowsHide: false,
        },
      );
    } catch (error) {
      settled = true;
      removeListeners();
      reject(
        new Error(
          "Could not start the SQL Job Object supervisor: " +
            (error.code ?? error.message),
          { cause: error },
        ),
      );
      return;
    }
    supervisor.stdin.on("error", stopOnSignalChannelFailure);
    while (pendingSignals.length > 0) sendSignal(pendingSignals.shift());

    supervisor.once("error", (error) => {
      settled = true;
      removeListeners();
      reject(
        new Error(
          "Could not start the SQL Job Object supervisor: " +
            (error.code ?? error.message),
          { cause: error },
        ),
      );
    });
    supervisor.once("close", (code, signal) => {
      settled = true;
      removeListeners();
      if (!supervisor.stdin.destroyed) supervisor.stdin.destroy();
      if (code !== null) {
        resolve(code);
        return;
      }
      reject(
        new Error(
          "The SQL Job Object supervisor ended without an exit code" +
            (signal ? " (signal " + signal + ")" : "") +
            ".",
        ),
      );
    });
  });
}

async function validateSupervisedWorkerContext() {
  if (process.platform !== "win32") {
    throw new Error("The supervised worker entry point is Windows-only.");
  }
  // Launch context catches accidental misuse. Same-account callers can fabricate it.
  // Process containment comes from the supervisor-owned Job.
  if (process.env.HOUSEMATE_SQL_TEST_SUPERVISED !== "1") {
    throw new Error("The internal SQL worker requires the Windows supervisor.");
  }

  const rootValue = process.env.HOUSEMATE_SQL_TEST_TMP_ROOT;
  const parentValue = process.env.HOUSEMATE_SQL_TEST_TMP_PARENT;
  if (!rootValue || !parentValue) {
    throw new Error("The supervisor did not provide its required execution context.");
  }
  if (!path.isAbsolute(rootValue) || !path.isAbsolute(parentValue)) {
    throw new Error("The SQL supervisor execution context is malformed.");
  }

  const root = path.resolve(rootValue);
  const parent = path.resolve(parentValue);
  if (
    !samePath(path.dirname(root), parent) ||
    !samePath(root, os.tmpdir()) ||
    !/^housemate-ai-sql-supervisor-[0-9a-f]{32}$/i.test(path.basename(root))
  ) {
    throw new Error("The SQL supervisor temporary root is outside its expected parent.");
  }

  let parentStat;
  let rootStat;
  try {
    parentStat = await fs.lstat(parent);
    rootStat = await fs.lstat(root);
  } catch (error) {
    throw new Error(
      "The SQL supervisor temporary root is not available: " +
        (error.code ?? error.message),
      { cause: error },
    );
  }
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink()
  ) {
    throw new Error("The SQL supervisor temporary root is not a normal directory.");
  }

  return { root };
}

async function runSqlWorker(temporaryDirectory, supervised) {
  await runWithPostgresLifecycle(
    ({ postgres, lifecycle }) => runSqlSuite(postgres, lifecycle),
    { temporaryDirectory, supervised },
  );
}

function assertClientIdentitySelfTest(condition, message) {
  if (!condition) {
    throw new Error("SQL client identity self-test failed: " + message);
  }
}

function createClientIdentityProbe({
  dataDirectory,
  port,
  connectError = null,
  closeError = null,
}) {
  const events = [];
  return {
    events,
    async connect() {
      events.push("connect");
      if (connectError) throw connectError;
    },
    async query(sql) {
      if (sql.includes("current_setting('data_directory')")) {
        events.push("identity-query");
        return {
          rows: [
            {
              server_address: postgresHost,
              server_port: port,
              listen_addresses: postgresHost,
              unix_socket_directories: "",
              data_directory: dataDirectory,
            },
          ],
        };
      }
      events.push("caller-query");
      return { rows: [] };
    },
    async end() {
      events.push("end");
      if (closeError) throw closeError;
    },
  };
}

async function runPostgresClientIdentitySelfTests() {
  const expectedDirectory = await fs.realpath(repositoryRoot);
  const otherDirectory = await fs.realpath(path.dirname(repositoryRoot));
  const state = { databaseDir: repositoryRoot, port: 54321 };

  const verifiedDriverClient = createClientIdentityProbe({
    dataDirectory: expectedDirectory,
    port: state.port,
  });
  const secondVerifiedDriverClient = createClientIdentityProbe({
    dataDirectory: expectedDirectory,
    port: state.port,
  });
  let verifiedClientCreations = 0;
  const verifiedFactory = createVerifiedPostgresClientFactory(state, () => {
    verifiedClientCreations += 1;
    return verifiedClientCreations === 1
      ? verifiedDriverClient
      : secondVerifiedDriverClient;
  });
  const verifiedClient = verifiedFactory.getPgClient("housemate_test");
  assertClientIdentitySelfTest(
    verifiedClient !== verifiedDriverClient,
    "the factory does not expose its raw driver client",
  );
  let earlyQueryRejected = false;
  try {
    await verifiedClient.query("CALLER_WRITE");
  } catch (error) {
    earlyQueryRejected = error.message.includes("identity must be verified");
  }
  assertClientIdentitySelfTest(
    earlyQueryRejected,
    "the facade rejects a query before connect and identity verification",
  );
  await Promise.all([verifiedClient.connect(), verifiedClient.connect()]);
  await verifiedClient.query("CALLER_WRITE");
  assertClientIdentitySelfTest(
    verifiedClientCreations === 1 &&
      verifiedDriverClient.events.join(",") ===
        "connect,identity-query,caller-query",
    "identity and caller queries use one driver session, in order, with one verification",
  );
  await verifiedClient.end();

  const secondVerifiedClient = verifiedFactory.getPgClient("housemate_test");
  await secondVerifiedClient.connect();
  await secondVerifiedClient.query("CALLER_WRITE");
  await secondVerifiedClient.end();
  assertClientIdentitySelfTest(
    verifiedClientCreations === 2 &&
      secondVerifiedDriverClient.events.join(",") ===
        "connect,identity-query,caller-query,end",
    "a later client receives a separate identity check before its own caller query",
  );
  console.log("PASS client identity self-test: verified session is released after same-session verification");

  const mismatchedDriverClient = createClientIdentityProbe({
    dataDirectory: otherDirectory,
    port: state.port,
  });
  const mismatchedFactory = createVerifiedPostgresClientFactory(
    state,
    () => mismatchedDriverClient,
  );
  const mismatchedClient = mismatchedFactory.getPgClient("housemate_test");
  let mismatchError = null;
  try {
    await mismatchedClient.connect();
  } catch (error) {
    mismatchError = error;
  }
  let mismatchedQueryRejected = false;
  try {
    await mismatchedClient.query("CALLER_WRITE");
  } catch (error) {
    mismatchedQueryRejected = error.message.includes("identity must be verified");
  }
  assertClientIdentitySelfTest(
    mismatchError?.message.includes("data directory does not match") &&
      mismatchedQueryRejected &&
      mismatchedDriverClient.events.join(",") ===
        "connect,identity-query,end",
    "a mismatched directory closes the session and blocks caller SQL",
  );
  console.log("PASS client identity self-test: mismatched session is closed and never reaches caller SQL");

  const closeFailure = new Error("injected client close failure");
  const closeFailureDriverClient = createClientIdentityProbe({
    dataDirectory: otherDirectory,
    port: state.port,
    closeError: closeFailure,
  });
  const closeFailureFactory = createVerifiedPostgresClientFactory(
    state,
    () => closeFailureDriverClient,
  );
  const closeFailureClient = closeFailureFactory.getPgClient("housemate_test");
  let combinedError = null;
  try {
    await closeFailureClient.connect();
  } catch (error) {
    combinedError = error;
  }
  assertClientIdentitySelfTest(
    combinedError instanceof AggregateError &&
      combinedError.errors[0].message.includes("data directory does not match") &&
      combinedError.errors[1] === closeFailure &&
      combinedError.cause === combinedError.errors[0] &&
      closeFailureDriverClient.events.join(",") ===
        "connect,identity-query,end",
    "the identity error remains primary when closing the rejected session fails",
  );
  console.log("PASS client identity self-test: close failure is retained as a secondary error");

  const connectFailure = new Error("injected connection failure");
  const connectFailureDriverClient = createClientIdentityProbe({
    dataDirectory: expectedDirectory,
    port: state.port,
    connectError: connectFailure,
  });
  const connectFailureFactory = createVerifiedPostgresClientFactory(
    state,
    () => connectFailureDriverClient,
  );
  const connectFailureClient = connectFailureFactory.getPgClient("housemate_test");
  let observedConnectFailure = null;
  try {
    await connectFailureClient.connect();
  } catch (error) {
    observedConnectFailure = error;
  }
  assertClientIdentitySelfTest(
    observedConnectFailure === connectFailure &&
      connectFailureDriverClient.events.join(",") === "connect,end",
    "a failed connection is closed without running identity or caller queries",
  );
  console.log("PASS client identity self-test: failed connection is closed and rejected");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--client-identity-self-test")) {
    await runPostgresClientIdentitySelfTests();
    console.log("PASS PostgreSQL client identity self-tests completed without PostgreSQL");
    return;
  }

  if (args.includes("--lifecycle-self-test")) {
    throw new Error(
      "The runner lifecycle mocks were replaced by the native supervisor self-test.",
    );
  }

  if (args.includes("--supervised-worker")) {
    const context = await validateSupervisedWorkerContext();
    await runSqlWorker(context.root, true);
    console.log("PASS supervised npm run test:sql completed");
    return;
  }

  if (process.platform === "win32") {
    const code = await runWindowsSupervisor();
    if (code !== 0) {
      const error = new Error(
        "Windows SQL supervisor exited with code " + code + ".",
      );
      error.exitCode = code;
      throw error;
    }
    console.log("PASS npm run test:sql completed under Windows Job Object");
    return;
  }

  await runSqlWorker(os.tmpdir(), false);
  console.log("PASS npm run test:sql completed on isolated PostgreSQL");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("FAIL npm run test:sql: " + error.message);
    if (Array.isArray(error.errors)) {
      for (const detail of error.errors) {
        console.error("[sql-runner] failure detail: " + detail.message);
      }
    }
    process.exitCode = exitCodeForFailure(error);
  });
}
