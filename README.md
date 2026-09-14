# Cloudflare Lead Desk

A self-hosted, Cloudflare-native CRM for teams handling inbound opportunities. It stores data in D1, serves a React workbench from Workers, and exposes a documented API for trusted form integrations.

## Alpha scope

- Contacts, opportunities, pipelines, stages, notes, and a Kanban work queue.
- Configurable fields for contacts and opportunities.
- Email + password staff authentication (Better Auth, D1-backed sessions) and displayed-once `intake:write` tokens.
- Idempotent, atomic `POST /v1/intakes` capture for websites and other trusted systems.

Companies, tasks, email sync, imports, reporting, workflows, custom objects, and multi-tenancy are deliberately not included yet.

## Install on Cloudflare

Every deployment is independent: the repo carries no account-specific values.

### One-click install

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ivanbrykov/cloudflare-lead-desk)

The button clones this repository into your own GitHub or GitLab account, provisions a fresh D1 database in your Cloudflare account, prompts for the secrets listed in `.dev.vars.example` (`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `STAFF_EMAILS`, `SETUP_TOKEN`), runs the migrations as part of `pnpm run deploy`, and connects Workers Builds so every push to your copy deploys automatically.

After the first deploy, open the app, switch to sign-up, and create the first account using the invite token (`SETUP_TOKEN`). Registration is invite-gated by design — every sign-up must present the token, so there is no separate "close registration" step. To add staff later, add their email to `STAFF_EMAILS` in the dashboard and share the invite token. Only emails in `STAFF_EMAILS` get data access: a token holder whose email is not allowlisted can create an account but sees no data.

### Manual install

Prerequisites: a Cloudflare account, Node.js 24.20.0 (see `.node-version`) and pnpm 10.34.5. Install the pinned pnpm version using `npm install --global pnpm@10.34.5` if needed.

1. Install dependencies: `pnpm install --frozen-lockfile`.
2. Create the D1 database in your account: `pnpm exec wrangler d1 create cloudflare-lead-desk`.
3. Set the session secret: `openssl rand -base64 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET`.
4. In the dashboard (Workers → Settings), set `BETTER_AUTH_URL` to the Worker's public origin (for example `https://cloudflare-lead-desk.<your-account>.workers.dev` — required in production, where authentication fails closed without it), `STAFF_EMAILS` to the comma-separated emails of the staff who may sign in, and `SETUP_TOKEN` to an invite token (`openssl rand -hex 32`).
5. Deploy: `pnpm run deploy` (set `CLOUDFLARE_ACCOUNT_ID` if your wrangler login spans multiple accounts). The deploy script builds, applies the D1 migrations, and deploys. The migration also bootstraps the default workspace, pipeline, and stage rows (fixed ids, `INSERT OR IGNORE`) and makes stage positions unique per pipeline — the app itself never seeds data per request, so deleted bootstrap rows are not resurrected. Migration commands reference the `DB` binding rather than a database name, so renamed databases keep working.

You can also connect the repository in the dashboard under Workers → Settings → Builds, with the deploy command set to `pnpm run deploy`.

Open the deployed app, switch to sign-up, and create the first account using
the `SETUP_TOKEN` invite token. Registration stays invite-gated — every
sign-up must present the token — so there is no follow-up step to close it.
Adding staff means adding their email to `STAFF_EMAILS` and sharing the
invite token; only allowlisted emails get data access.

Both `src/worker-global.ts` (the configured deployment entry) and the compatibility
entry `src/worker.ts` use the same app compiled at module scope.

For local development, copy `.dev.vars.example` to `.dev.vars` and set `BETTER_AUTH_SECRET` (`openssl rand -base64 32`) and `SETUP_TOKEN` (`openssl rand -hex 32`), then run `pnpm run dev:worker` and `pnpm run dev`. Enter the invite token on the sign-up screen to create a throwaway account; sessions are stored in local D1. Optionally add `ENVIRONMENT=development` and a `DEV_ADMIN_EMAIL` to bypass the session check locally — `DEV_ADMIN_EMAIL` is honored only outside production, and deployments always set `ENVIRONMENT=production`, so those dev-only values are deliberately absent from `.dev.vars.example` (its entries become prompted secrets in the one-click install flow).

## Integration API

Create an intake token in **Settings → Tokens**, then send an idempotent form submission:

```sh
curl https://crm.example.com/v1/intakes \
  -H 'Authorization: Bearer cld_…' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: a-stable-submission-id' \
  --data '{
    "source": "website_form",
    "contact": { "email": "alex@example.com", "firstName": "Sam" },
    "opportunity": {
      "name": "New service inquiry",
      "source": "calculator",
      "customFields": { "segment": "Enterprise" }
    }
  }'
```

The interactive OpenAPI documentation is available at `/openapi`.

### Intake idempotency contract

Send `Content-Type: application/json`. Every intake body is byte-limited before
decoding; unsupported or missing media types return `415 unsupported_media_type`
when within the limit, and oversized bodies return 413 regardless of media type.


`POST /v1/intakes` is the only size-limited route: the raw request body is
bounded to **65,536 actual bytes** (enforced on the streamed body, with or
without a declared `Content-Length`) before JSON parsing. Larger bodies get
`413 payload_too_large` and write no intake data.

The limit is owned by the intake route itself, not by the Worker entry: a
route-local Elysia `parse` hook reads the streamed body with
[`get-stream`](https://github.com/sindresorhus/get-stream)
(`getStreamAsArrayBuffer`, `maxBuffer: 65_536` bytes), then decodes it with a
standard `TextDecoder` and `JSON.parse`. Because the hook is attached to the
route, every accepted alias (`/v1/intakes`, `/v1/intakes/`, and the
normalized `/v1/intakes/.`) enforces the identical byte limit, and the limit
applies before token and idempotency checks. On overflow `get-stream` throws
`MaxBufferError` and cancels the still-open input stream (its async iteration
also releases the reader lock); the route `error` hook maps that one error
type to the `413 payload_too_large` response and never returns or logs the
error instance, which carries the raw submitted bytes. Malformed JSON keeps
Elysia's ordinary `400` handling. Unsupported media types return 415 after
the same bounded read; they never fall through to another body parser.

- **Keys.** `Idempotency-Key` is required and must be 1-128 printable ASCII
  characters (`0x21`-`0x7E`, no spaces). A missing key returns
  `400 idempotency_key_required`; any other malformed key returns
  `400 invalid_idempotency_key`. Both are rejected before any intake data is
  written, as are unauthorized requests.
- **Identity.** The key is workspace-scoped and outlives tokens: rotating or
  revoking tokens never duplicates a submission. Each accepted key stores a
  deterministic SHA-256 fingerprint of the decoded request. The fingerprint
  sorts object keys recursively, preserves array order, and normalizes the
  contact email (case/whitespace), so JSON whitespace, property order, and
  email case never create a conflict. Omitted versus explicitly supplied
  optional values are fingerprinted differently and may legitimately
  conflict; use one stable form per logical submission.
- **Replay.** Re-sending the same logical payload returns the original
  `201` response and IDs without updating contacts or inserting history.
  Replays skip current custom-field and pipeline validation, so an accepted
  submission keeps replaying after fields are archived or newly required and
  after pipelines are archived.
- **Conflicts.** A different payload under the same key returns
  `409 idempotency_conflict` without exposing the stored payload or hash.
  Concurrent same-key calls settle to one persisted winner; identical
  concurrent retries all return the original success.
- **Legacy keys.** Keys accepted before fingerprints existed (null
  `request_hash`) return `409 idempotency_legacy_unverifiable`. Reconcile
  them against the already stored opportunity (its ID is returned in
  `details`) before considering another submission or key. The stored row is
  never overwritten, backfilled from the new request, or deleted, and blind
  new-key retries are not a substitute for reconciliation.
- **Routing.** The selected or default stage must belong to the selected or
  default pipeline, both must belong to the current workspace, and archived
  pipelines are rejected. Invalid combinations return `422 invalid_stage`
  with no contact, opportunity, activity, custom-value, or idempotency
  writes.
- **Atomicity.** Contact upsert, opportunity, intake activity, custom-field
  values, and the idempotency key commit in one D1 transaction. A failed
  transaction reserves no key, so the same key can be retried after a
  transient failure.

### List pagination and filters

`GET /v1/contacts` is keyset (seek) paginated over `createdAt DESC`,
tie-broken by `id DESC`:

- `limit` bounds a page to an integer between 1 and 100 (default 50).
  Non-numeric or out-of-range values return `422 validation_error`.
- `cursor` takes the opaque `nextCursor` from a previous response - a
  base64url-encoded keyset of the last row's `createdAt` and `id` over the
  ordering above. Omit it for the first page; the final page returns
  `nextCursor: null`. A missing, malformed, or tampered cursor returns
  `422 invalid_cursor`.
- `query` keeps its search role and composes with pagination: a literal
  substring match on first name, last name, or email (`%` and `_` match
  literally).
- Items keep the flat contact shape, including `customFields`.
- Custom-field values are fetched for the whole page in batched `IN (...)`
  queries chunked to D1's 100-bound-parameter limit, not one query per
  contact.

Consistency while paging: each page is evaluated as of its own query (no
snapshot spans pages). Pages are disjoint windows of the keyset ordering,
so a row is never returned on two pages, and a pass over an unchanged
dataset returns every matching row exactly once. If rows change while a
client pages: a row deleted after its page was served is skipped (it never
reappears); a row inserted after the current cursor position may surface
in a later page; a row inserted before the cursor - newer timestamps, the
usual case - sorts ahead of it and is only visible after restarting from
the first page.

`GET /v1/opportunities` is not paginated; the optional `pipelineId` query
parameter restricts results to one active pipeline of the current workspace.
An unknown or archived `pipelineId` returns `422 validation_error`.
Opportunity custom-field values use the same batched read.

### Opportunity editing

`PATCH /v1/opportunities/:id` updates the editable staff fields of an
existing opportunity. It accepts `{ name?, estimatedValue? }`:

- At least one field is required; `{}` returns `422 validation_error`.
- `name` must be non-empty without leading or trailing whitespace (the same
  `NonEmptyString` contract as every other name field in the app); blank
  names return `422 validation_error`.
- `estimatedValue` must be a non-negative finite number. An explicit `null`
  clears the stored value; omitting the field keeps it. Negative or
  non-finite values return `422 validation_error`.
- Unknown ids return `404 not_found`. Staff authentication is
  required; missing or invalid identities return `401 unauthorized`.

The workbench exposes the endpoint as a minimal "Edit details" form on the
opportunity detail page, and the board lists active pipelines in a pipeline
selector whose selection drives `GET /v1/opportunities?pipelineId=`.

## Custom fields

Custom fields are configured per contact and opportunity (Settings → Fields) and validated against the active definitions:

- Creation (`POST /v1/contacts`, `POST /v1/opportunities`, `POST /v1/intakes`) must provide every required field. `null` is rejected for required fields, and blank optional fields are simply omitted.
- `PUT /v1/contacts/:id` treats `customFields` as a patch: omit the object or a key to keep the stored value, and send an explicit `null` to clear an optional field. Required fields cannot be cleared, and a custom-fields update still fails for a contact that has no stored value for a required field. Unknown or archived keys are always rejected.
- Reads expose active definitions only. Archived definitions keep their stored values for historical export but are excluded from payloads, so an archived value never blocks editing a contact.
- Core fields and custom-field values are written in a single D1 transaction, so a failed field write rolls back the whole request.

## Observability

Every API request (`/health`, `/openapi`, and `/v1/*`) emits exactly one JSON log line, written synchronously before the response is returned (a Workers isolate can be suspended once the response is sent, so logging does not rely on post-response callbacks):

```json
{"event":"request","method":"GET","path":"/v1/contacts","status":200,"durationMs":3.42}
```

Fields:

- `event` — `request` for the per-request line; `request.failure` for structured failure lines emitted when a persistence write or a command fails.
- `method` — the HTTP method.
- `path` — the URL pathname (the actual route path, e.g. `/v1/contacts/01...`). Query strings are never logged, so the contact search `query` parameter of `GET /v1/contacts` does not reach the logs.
- `status` — the final HTTP status of the response.
- `durationMs` — total processing time for the request in milliseconds.

Responses with a 5xx status, and failure lines, are written with `console.error`; everything else uses `console.log`. Failure lines additionally carry `errorClass`, and for persistence failures the database error's class as `errorCauseClass` (the cause message is never logged because it can embed SQL with bound values), or for command defects the error `errorMessage`. Log lines never contain headers, request bodies, tokens, emails, query strings, stacks, or SQL.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request from a clean checkout. It uses no secrets and performs no deployment:

1. `pnpm install --frozen-lockfile` — pnpm pinned by the `packageManager` field, Node from `.node-version`.
2. `pnpm run typecheck`.
3. `pnpm exec vitest run` — includes the Miniflare-backed D1 suites.
4. `pnpm run build`.
5. `pnpm exec wrangler deploy --dry-run` — validates the deployable bundle without authentication.

## Development

```sh
pnpm run check
pnpm run build
```

`pnpm run check` runs the typecheck and the full test suite; the same gates (plus the build and the deploy dry-run) run in CI.

The public contract is REST/OpenAPI. Elysia handles HTTP, Effect Schema is the single validation model, and Effect commands contain domain rules. See [`docs/adr`](docs/adr).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
