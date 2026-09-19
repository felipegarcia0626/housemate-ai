const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "..");

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close(() =>
          reject(new Error("Could not determine a free port.")),
        );
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
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

async function runSqlFile(client, filePath, label) {
  const sql = await expandPsqlIncludes(filePath);

  try {
    await client.query(sql);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  }

  console.log(`PASS ${label}`);
}

async function removeDatabaseDirectory(databaseDir) {
  const retryableErrors = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(databaseDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retryableErrors.has(error.code) || attempt === 19) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function main() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const databaseDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "housemate-ai-sql-"),
  );
  const port = await findFreePort();
  const migrationDirectory = path.join(
    repositoryRoot,
    "database",
    "migrations",
  );
  const seedDirectory = path.join(repositoryRoot, "database", "seeds");
  const testDirectory = path.join(repositoryRoot, "tests");
  let postgres;
  let failure;
  let postgresStopped = false;

  try {
    postgres = new EmbeddedPostgres({
      databaseDir,
      port,
      user: "postgres",
      password: "housemate-sql-test",
      authMethod: "password",
      persistent: false,
      onLog: () => {},
      onError: (error) => {
        if (process.env.DEBUG_SQL_TESTS === "1") console.error(error);
      },
    });

    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("housemate_test");

    const bootstrapClient = postgres.getPgClient("housemate_test");
    await bootstrapClient.connect();
    await bootstrapClient.query("CREATE ROLE service_role NOLOGIN");
    await bootstrapClient.end();

    for (const migrationPath of await sqlFiles(migrationDirectory)) {
      const client = postgres.getPgClient("housemate_test");
      await client.connect();
      try {
        await runSqlFile(
          client,
          migrationPath,
          `migration ${path.basename(migrationPath)}`,
        );
      } finally {
        await client.end();
      }
    }

    const seedPaths = await sqlFiles(seedDirectory);
    for (let pass = 1; pass <= 2; pass += 1) {
      for (const seedPath of seedPaths) {
        const client = postgres.getPgClient("housemate_test");
        await client.connect();
        try {
          await runSqlFile(
            client,
            seedPath,
            `seed pass ${pass} ${path.basename(seedPath)}`,
          );
        } finally {
          await client.end();
        }
      }
    }

    for (const testPath of await sqlFiles(testDirectory)) {
      const client = postgres.getPgClient("housemate_test");
      await client.connect();
      try {
        await runSqlFile(
          client,
          testPath,
          `SQL test ${path.basename(testPath)}`,
        );
      } finally {
        await client.end();
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (postgres) {
      try {
        await postgres.stop();
        postgresStopped = true;
      } catch (error) {
        if (error.code === "EBUSY" || error.code === "ENOTEMPTY") {
          try {
            await removeDatabaseDirectory(databaseDir);
            postgresStopped = true;
          } catch (cleanupError) {
            failure ??= cleanupError;
          }
        } else {
          failure ??= error;
        }
      }
    }

    if (!postgresStopped) {
      try {
        await removeDatabaseDirectory(databaseDir);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure) {
    throw failure;
  }

  console.log("PASS npm run test:sql completed on isolated PostgreSQL");
}

main().catch((error) => {
  console.error(`FAIL npm run test:sql: ${error.message}`);
  process.exit(1);
});
