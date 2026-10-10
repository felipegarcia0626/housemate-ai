# Authenticated Agent E2E

This runner uses a dedicated Supabase Auth account and the real `/api/agent`
route. It never falls back to the MVP household or to mocked interpretation.

Required local variables (keep them outside Git):

- `E2E_TEST_EMAIL`
- `E2E_TEST_PASSWORD`
- `E2E_SUPABASE_URL`
- `E2E_SUPABASE_ANON_KEY`

Optional variables:

- `E2E_BASE_URL` (defaults to `http://localhost:3000`)
- `E2E_TEST_DISPLAY_NAME` (defaults to `Felipe`)
- `E2E_TEST_HOUSEHOLD_NAME` (defaults to `HouseMate E2E`)
- `E2E_AGENT_HOUSEHOLD_ID` to select an existing household owned by the test user

Start the application with the normal development command, then run:

```bash
npm run test:e2e:agent
npm run test:e2e:agent:split
```

The direct-split runner requires the pre-created SQL fixture
`tests/e2e/household-fixture.sql` to have been executed manually first. It
selects the configured household and resolves its two existing members using
read-only service-role queries; it never creates or deletes users or
memberships. It never prints keys, tokens, cookies, passwords, or full provider
errors.

The runner signs in with Supabase Auth, provisions the user only when needed,
selects the test household, and sends `Gasté $20.000 en una cena` to the real
Agent API. It prints only request IDs, HTTP status, result type, and boolean
setup information. Access tokens, refresh tokens, cookies and secrets are
never printed.

## Realtime subscription preflight

Run `npm run test:e2e:notifications-realtime:subscription` to execute only
`notifications-realtime-subscription.spec.cjs` with its standalone Playwright
configuration. The preflight uses two existing Auth accounts and verifies that
each independent browser session reaches `SUBSCRIBED` for the Notifications
Realtime channel. It does not create business data, and it does not prove INSERT
delivery, RLS row visibility, notification reconciliation, or a badge update.

The run requires the E2E Supabase URL and matching allowed project ref, a public
anon/publishable key manually confirmed for that project, and the existing A/B
test-account variables. Never provide an administrative key. Matching the
project ref constrains the destination but does not prove that the project is
non-production or that the accounts exist; confirm those independently before
running the preflight.
