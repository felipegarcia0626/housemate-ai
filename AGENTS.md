<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# HouseMate AI — Codex Development Instructions

This file contains stable operational rules for work in this repository. The architecture, contracts, data model, security decisions, and implementation scope remain authoritative in their dedicated documents.

## 1. Read before acting

Before changing code, read the relevant instructions and source-of-truth documents:

- `docs/vision/01_Project_Vision.md`
- `docs/vision/02_PRD.md`
- `docs/architecture/architecture_overview.md`
- `docs/architecture/c4_context.md`
- `docs/architecture/c4_container.md`
- `docs/architecture/tech_stack.md`
- `docs/architecture/data_model.md`
- `docs/architecture/api_contract.md`
- `docs/architecture/agent_architecture.md`
- `docs/architecture/implementation_plan.md`
- `docs/architecture/project_structure.md`
- `docs/architecture/security.md`

Read only the documents relevant to the requested increment when the task is narrowly scoped, but never invent a contract that is not documented. If documentation and implementation disagree, identify the concrete contradiction before making a broad decision.

## 2. Scope and architecture

HouseMate AI is a modular monolith. Use the smallest change that satisfies the requested increment and preserve the existing dependency direction:

```text
Route / Channel
      ↓
Controlled Context
      ↓
Service
      ↓
Repository
      ↓
Infrastructure / PostgreSQL
```

Web/PWA may invoke controlled backend use cases directly. Agent-originated business operations use controlled Tools; Tools are not a mandatory layer for Web/PWA. Routes and channels are adapters and must not contain business rules, financial calculations, direct Supabase access, SQL, or repository calls.

Do not introduce microservices, queues, event buses, Redis, event sourcing, generic repositories, or generic financial-movement abstractions unless an approved requirement explicitly demands them. `Expense` and `Income` remain independent capabilities.

Each increment must have an explicit whitelist. Do not modify files outside that whitelist, unrelated modules, protected migrations, configuration, or environment files. Do not implement a later phase because it is technically possible.

## 3. Context and household isolation

Financial operations must use the controlled context defined by the current architecture. HTTP routes obtain household or actor context through `getConfiguredHttpHouseholdContext()` or `getConfiguredHttpActorContext()` as appropriate.

Never trust `householdId`, actor identity, or equivalent context supplied through query parameters, body, cookies, arbitrary headers, or paths as the authoritative context. Services and repositories must still apply household filters and validate member, category, receipt, and resource ownership.

Do not expose another household's existence through errors. Preserve the documented public error contract and sanitize infrastructure details at the HTTP boundary.

## 4. Domain responsibilities

Business rules belong in domain services and pure domain calculators. Repositories perform persistence and mapping only. Infrastructure owns provider-specific clients.

Financial calculations must be deterministic and authoritative in backend code, never in the LLM. Accumulate monetary values using integer cents and `bigint` where the existing module does so. Before converting accumulated cents to `number`, enforce the documented safe range and preserve the existing cent/money semantics.

Expense rules include household isolation, separate `created_by` and `paid_by`, persisted `ExpenseDistribution`, confirmed-only Balance participation, and the approved RPC semantics for atomic writes. Income remains independent, supports its documented CRUD semantics, and does not participate in compensation Balance. Sharing Rules calculate splits without persisting them; Balance consumes persisted distributions and does not recalculate sharing rules. Dashboard consumes backend-calculated values and does not persist derived aggregates.

Do not duplicate an existing calculator or business rule in a Route, Tool, dashboard, WhatsApp handler, or another module.

## 5. Route and API rules

Route Handlers should:

1. parse transport input;
2. reject unsupported or malformed transport values;
3. resolve controlled context;
4. call the domain Service;
5. project the documented public DTO;
6. translate and sanitize errors;
7. return the documented status and response shape.

Routes must not select a household from client input, perform writes directly, call `.from()` or `.rpc()` directly, or duplicate service validation. API behavior must match `docs/architecture/api_contract.md`; do not add undocumented fields, filters, statuses, or endpoints.

## 6. Agent and integrations

The Agent interprets intent and selects Tools. Tools orchestrate and delegate to Services; they do not access PostgreSQL, Supabase, credentials, or repositories directly. Tools must use the names, schemas, confirmation rules, and outputs defined in `docs/architecture/agent_architecture.md`.

Write operations requiring confirmation must not persist before the approved confirmation flow. The Agent must not calculate authoritative financial totals or balances.

WhatsApp, OpenAI, Storage, and receipt processing belong in their documented modules and infrastructure locations. Do not begin those integrations or create their endpoints as part of an unrelated increment.

## 7. Persistence and migrations

Use the existing administrative Supabase client only through the repository/infrastructure boundary. Never expose service-role credentials to client code.

Database changes belong in `database/migrations/` and seeds in `database/seeds/`. Do not edit an applied migration to repair a later feature; create a new versioned migration only when the approved scope requires a schema or privilege change. Do not put business workflows in migrations.

Prefer existing tables, constraints, triggers, RPCs, indexes, and grants. Do not grant `ALL` or add privileges beyond the minimum documented requirement.

## 8. Validation and tests

Tests must exercise behavior rather than unreachable branches or superficial implementation checks. For API increments, use the existing functional harness pattern and test the real Route → Context → Service → Repository flow with controlled fakes where appropriate.

For financial behavior, cover correctness, isolation, validation, persistence semantics, deterministic arithmetic, DTO projection, sanitized errors, and relevant regressions. SQL integrity tests must remain transactional and finish with `ROLLBACK` when that is their established convention.

For every implementation increment, run the relevant checks available in the repository, normally:

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- the increment's functional harness;
- relevant regression harnesses;
- `git diff --check`.

Do not claim a test or external database validation passed unless it was actually executed. Do not add a test runner or dependency without an approved requirement.

## 9. Errors and security

Domain errors may preserve documented internal distinctions, but HTTP responses must expose only the approved public codes and sanitized messages. Never expose SQL, Supabase/PostgreSQL details, stack traces, URLs, credentials, tokens, or provider secrets.

Never commit `.env.local`, secrets, service-role keys, access tokens, logs, generated artifacts, or credentials. Keep server-only environment variables in server-only code. Do not change security policy, RLS, permissions, or authentication assumptions outside the requested scope.

## 10. Documentation discipline

Keep responsibilities separated:

- `api_contract.md`: HTTP contracts;
- `data_model.md`: conceptual and physical persistence;
- `agent_architecture.md`: Agent and Tool behavior;
- `implementation_plan.md`: phases and implementation progress;
- `project_structure.md`: physical organization;
- `security.md`: security constraints;
- vision/PRD documents: product intent and requirements.

Update only the document sections required to record an approved implementation or contract change. Do not copy an entire architecture document into operational instructions and do not describe future work as implemented.

## 11. Git discipline

Before staging:

1. inspect `git status` and the complete diff;
2. confirm the explicit whitelist;
3. check for secrets, environment files, generated files, and unrelated work;
4. separate shared-document hunks carefully when increments overlap.

Stage explicit paths only; never use broad `git add .` or `git add -A` when unrelated work may exist. After staging, inspect `git diff --cached`, `git diff --cached --check`, and the staged name list. Create one coherent commit only after the staged diff matches the approved scope. Push only when explicitly requested.

Do not use destructive cleanup (`git reset --hard`, `git clean`, or broad restore) to separate work. Preserve other increments in the working tree.

## 12. Handling ambiguity and findings

If a required decision is absent or conflicts with an approved architectural rule, stop before implementing and report:

- the missing or conflicting decision;
- the documents and code involved;
- why it blocks the increment;
- the minimum decision needed.

Do not silently redesign the architecture. A non-blocking issue outside the requested scope should be reported and left for a separate increment.

## 13. Definition of done

An increment is ready for staging only when:

- its documented contract is satisfied;
- the architecture and security boundaries are preserved;
- household isolation and error sanitization remain intact;
- relevant tests and static checks pass;
- the diff contains only the approved whitelist;
- no secrets, generated files, migrations, dependencies, or unrelated changes were included;
- documentation changes are minimal and accurate.

Do not implement `GET /api/expenses/{id}` or any other feature unless the current task explicitly authorizes it.
