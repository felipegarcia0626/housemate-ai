# HouseMate E2E: commands, isolation, and recovery limits

This page describes the current source configuration and test assertions. A test
assertion is not an execution result. Environment variable names are listed
without values; keep credentials outside Git. No environment values or remote
project state were inspected for this documentation update.

## Command map

### Mocked browser tests

- `npm run test:e2e:readonly` uses
  `playwright.readonly.config.cjs`, whose `testMatch` selects
  `expenses.editor.spec.cjs` and `notifications.mocked.spec.cjs`.
- `npm run test:e2e:notifications-ui` uses the same config and explicitly
  selects only `tests/e2e/notifications.mocked.spec.cjs`.
- The config has no `globalSetup`; it starts a local Next.js server on
  `127.0.0.1:3200`, uses a loopback dummy Supabase URL and dummy keys,
  sets `E2E_WRITE_ENABLED=0`, and writes Playwright output under
  `test-results/readonly`. It sets `NODE_ENV=test`; its source
  comments that Next.js does not load `.env.local` in that mode. This is a
  mocked/local test setup, not a side-effect-free command: it starts a server
  and can create local test artifacts.
- The selected specs intercept their application API calls. The Notifications
  spec uses a fictitious session and a simulated Realtime socket; its simulated
  INSERT exercises client reconciliation against mocked GET responses. These
  are not calls to real Supabase Auth, Realtime, or business persistence.

### Authenticated Realtime subscription preflight

`npm run test:e2e:notifications-realtime:subscription` selects only
`notifications-realtime-subscription.spec.cjs` with
`playwright.realtime-readonly.config.cjs`. That config has no global
setup/teardown hooks, but starts a local Next.js server on
`127.0.0.1:3210` and can write artifacts under
`test-results/realtime-subscription-readonly`.

The config calls Next.js `loadEnvConfig(__dirname, true)` before validating
its inputs, so it may load environment files where applicable. This review did
not read those values. The source requires
`E2E_SUPABASE_URL`, `E2E_ALLOWED_SUPABASE_PROJECT_REF`,
`E2E_SUPABASE_ANON_KEY`, `E2E_TEST_EMAIL`,
`E2E_TEST_PASSWORD`, `E2E_NOTIFICATION_B_EMAIL`, and
`E2E_NOTIFICATION_B_PASSWORD`. The operator must confirm that the
configured project and public key are authorized. The code rejects known
administrative key forms, but that check cannot prove that every unrecognized
key is public; the project-ref comparison is a destination allowlist, not proof
that the project is non-production.

The spec signs in two existing, distinct Auth users against the configured
Supabase project. Browser application API GETs are fulfilled locally; the
browser network guard allows only the specified Auth user/refresh requests and
Realtime WebSocket, and blocks other HTTP/WebSocket destinations and application
API mutations. This still contacts real Auth and Realtime services and is not
a no-side-effect operation. Its assertion is that both sessions mount the bell
and reach `SUBSCRIBED`. That does not demonstrate INSERT delivery, RLS row
visibility, notification reconciliation, or a UI update from a real event.
No execution result for this preflight is claimed here.

### Integration, Agent, and provisioning entrypoints

- `npm run test:e2e` and `npm run test:e2e:write` use
  `playwright.integration.config.cjs` without a positional spec filter;
  its `testDir` is `tests/e2e`.
  `npm run test:e2e:notifications-realtime` and
  `npm run test:e2e:write:notifications-realtime` select
  `notifications-realtime.spec.cjs` with that config. All four entrypoints
  currently throw the unconditional recovery guard while evaluating the config,
  before that config's `loadEnvConfig()` call, server startup, globalSetup
  registration, or spec collection.
- `npm run test:e2e:agent` and `npm run test:e2e:write:agent`
  invoke `node tests/e2e/agent-authenticated.cjs` directly. The
  `test:e2e:agent:split` and `test:e2e:write:agent:split` aliases
  invoke `node tests/e2e/agent-direct-split.cjs`; neither uses a Playwright
  config. Both modules call `loadEnvConfig(process.cwd())` at import time.
  If their write-context and authorized-household checks pass, `main()`
  then reaches the unconditional recovery guard before constructing the
  administrative client, signing in, or sending business requests.
- Both `npm run e2e:provision-user` and
  `npm run e2e:write:provision-user` invoke
  `node tests/e2e/provision-test-user.cjs` directly; neither uses the
  integration config. The script loads environment configuration at import.
  After validating write context it constructs an administrative client and
  calls `auth.admin.listUsers()`. An existing account returns without
  creation or update. If no account is found, `E2E_ALLOW_AUTH_USER_CREATE=1`
  is an additional opt-in only: it does not override
  `E2E_RECOVERY_BLOCKED`. The guard throws before the mutating
  `auth.admin.createUser()` call. Therefore the command can make a real
  Auth-admin listing request while the hold is active; do not treat it as a
  purely local or read-only harness.
- `npm run test:e2e:safety` runs the local
  `write-context-functional.cjs` contract harness with test doubles; it
  does not invoke Playwright.
- `npm run test:e2e:categories` runs a separate Node harness, not
  Playwright. Its source starts Embedded PostgreSQL in a temporary directory
  and creates a temporary `housemate_e2e` database, with stop/removal
  cleanup code. It is not covered by the Playwright integration-config guard;
  this page does not claim a runtime result for it.

## Environment and write-context limits

There is no universal E2E variable checklist: each entrypoint has different
inputs. The mocked Playwright config supplies dummy Supabase values and clears
the named E2E/write-related variables passed to its server. The authenticated
subscription preflight has the separate public-key and existing-account inputs
listed above.

The shared write-context reader requires
`E2E_SUPABASE_URL`, `E2E_SUPABASE_ANON_KEY`,
`E2E_SUPABASE_SERVICE_ROLE_KEY`, `E2E_HOUSEHOLD_ID`,
`E2E_ALLOWED_HOUSEHOLD_ID`, `E2E_MEMBER_ID`,
`E2E_ALLOWED_SUPABASE_PROJECT_REF`, and
`HOUSEMATE_MVP_HOUSEHOLD_ID`; write-context consumers also require
`E2E_WRITE_ENABLED=1`. The Agent runners additionally require
`E2E_AGENT_HOUSEHOLD_ID` to match the authorized household and an existing
test account (`E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD`); their base
URL defaults to `http://localhost:3000`. These are code prerequisites,
not an authorization to run the blocked scenarios. Neither
`E2E_WRITE_ENABLED=1` nor
`E2E_ALLOW_AUTH_USER_CREATE=1` overrides the recovery hold.

## Recovery hold and setup boundaries

`assertRecoverableE2EOperation()` in
`tests/e2e/fixtures.cjs` throws `E2E_RECOVERY_BLOCKED` every time it
is called. No environment acknowledgement overrides it.

The standard integration config calls the guard before its `loadEnvConfig()` call,
`webServer`, `globalSetup`, and test discovery. Direct Agent runners
are not protected by that Playwright config: they load environment files at
module import, validate write context and the configured household, and then
hit their own guard before client construction, authentication, or HTTP calls.
`requestJson()` also blocks non-GET/HEAD/OPTIONS methods before
`fetch`. `ensureHousehold()` uses only
`GET /api/auth/households`; it does not run onboarding or post a household
selection.

The provisioning hold is later in its flow: `listUsers()` may run before
the guard, while `createUser()` cannot run through the guarded path.
The normal integration config fails before registering `global-setup.cjs`.
If an alternate config invokes that setup directly, it calls
`prepareExpenseFixtures()`, whose own recovery guard runs before write
context validation, administrative-client construction, or fixture RPCs. This
does not protect arbitrary side effects added to a different custom setup.

The invitation-creation spec has an unconditional top-level guard, so its test
is not collected while the hold remains active; it also checks the guard inside
the test callback. Its source contains assertions for a real invitation POST,
Realtime INSERT, correlated notification GET/reconciliation, and badge update.
Those assertions describe intended coverage only, not observed execution
results. The spec has not been reported as passing.

## Realtime coverage: mocked versus intended integration

The mocked Notifications spec covers the UI with fake session/API data and a
simulated Phoenix protocol: list, pagination, read actions, unread state,
filter behavior, error/retry, mocked invitation acceptance, and client
reconciliation after a simulated INSERT. Its nine tests were previously
reported by the operator as passing in PowerShell; this documentation update
did not rerun them. That result does not validate real Auth, Supabase delivery,
RLS, database permissions, or real invitation acceptance.

The separate subscription preflight authenticates two existing accounts and
checks channel establishment through `SUBSCRIBED`; it does not send or
assert a notification INSERT. The creation spec's source additionally expects
an invitation to be created, then correlates a Realtime callback, reconciliation
request/response, and unread badge change. Because its recovery guard prevents
collection, none of those creation-spec assertions are represented here as
executed results.

## Recovery and cleanup limits

The invitation creation spec sends the invitation POST without an
`idempotencyKey`. If the response is lost, the test may not obtain the
token hash needed to look up the invitation and notification IDs. The API's
idempotent recovery contract requires the client to retry with the same key,
household, and normalized email; the spec does not exercise that retry.

If both exact IDs are obtained, the spec's `finally` code attempts to
delete the notification first, verifies it is absent, and only then attempts
to delete the invitation and verifies that absence. It does not use broad
household/email/status filters as a fallback. If either exact ID is missing,
automatic deletion is withheld and the run is reported incomplete. This code
is not remotely verified. Checked-in migrations grant `SELECT, INSERT, UPDATE`
on `tb_notifications` to `service_role` (migration
`0031`) and `SELECT` on `tb_household_invitations`
(migration `0036`); those table grants do not include `DELETE`.
The effective privileges of any deployed database were not queried, so cleanup
success cannot be inferred from the migrations alone.

The Agent runners no longer perform automatic deletion based on snapshot
differences. Returned proposal/expense IDs are recorded as references, but do
not prove that this run created or owns those records; the recovery helper
therefore keeps these scenarios blocked. A failed request may have committed
before returning an ID. The shared fixture cleanup also preserves its recovery
manifest and is blocked by the same hold.

Two IDs were recorded historically as possible residual rows:
`tb_notifications.id = 7a3c7051-e317-4545-b3b3-2adcad6b239a` and
`tb_household_invitations.id = d0a5f146-7230-49db-bf54-42d30fc443c9`.
Their current existence was not checked in this review. Any cleanup requires an
authorized administrator to verify and operate on exact IDs, notification
before invitation; no broad deletion is authorized.

For the blocked creation spec only, Playwright sets
`__HOUSEMATE_REALTIME_E2E_DIAGNOSTICS__` in its browser contexts. The
diagnostics are opt-in and sanitized, but include lifecycle/correlation
references such as notification IDs; they are not authentication credentials
or full notification payloads. The mocked diagnostics suite uses a separate
subscription-status flag and tests that it remains disabled by default.

## Validation record for this update

This update was based on static inspection only. No tests, scripts, builds,
servers, database operations, or remote requests were run for it. The only
execution result recorded above is the prior operator-reported mocked Notifications
run; no result is claimed for the authenticated subscription preflight or the
blocked invitation-creation spec.
