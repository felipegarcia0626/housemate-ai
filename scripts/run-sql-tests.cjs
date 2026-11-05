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
    const position = Number(error.position ?? error.internalPosition);
    const source = error.internalPosition ? error.internalQuery : sql;
    const line =
      Number.isInteger(position) && position > 0 && source
        ? source.slice(0, position - 1).split("\n").length
        : null;
    const location = line ? ` (line ${line})` : "";
    throw new Error(`${label}${location}: ${error.message}`, { cause: error });
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
  const fixtureDirectory = path.join(repositoryRoot, "tests", "fixtures");
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
      postgresFlags: ["-c", "wal_level=logical"],
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
    await bootstrapClient.query("CREATE ROLE service_role NOLOGIN BYPASSRLS");
    // Supabase supplies this publication before migration 0037 in production.
    await bootstrapClient.query("CREATE PUBLICATION supabase_realtime");
    await bootstrapClient.end();

    for (const migrationPath of await sqlFiles(migrationDirectory)) {
      if (path.basename(migrationPath) === "0030_household_membership_lifecycle.sql") {
        const fixturePath = path.join(fixtureDirectory, "0030_household_legacy_fixture.sql");
        const fixtureClient = postgres.getPgClient("housemate_test");
        await fixtureClient.connect();
        try {
          await runSqlFile(fixtureClient, fixturePath, "migration fixture 0030_household_legacy_fixture.sql");
        } finally {
          await fixtureClient.end();
        }
      }
      const client = postgres.getPgClient("housemate_test");
      await client.connect();
      try {
        const isLinkingMigration =
          path.basename(migrationPath) ===
          "0043_whatsapp_linking_persistence.sql";
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
    await require("../tests/financial-eligibility-concurrency.cjs")(postgres);
    await require("../tests/financial-eligibility-races.cjs")(postgres);
    await require("../tests/whatsapp-linking-concurrency.cjs")(postgres);
    await require("../tests/whatsapp-authorization-concurrency.cjs")(postgres);
    await require("../tests/whatsapp-linking-http-sql.cjs")(postgres);
    await require("../tests/whatsapp-event-recovery-concurrency.cjs")(postgres);
    await require("../tests/whatsapp-event-http-sql.cjs")(postgres);
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
