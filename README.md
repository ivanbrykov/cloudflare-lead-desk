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

### Installation repository

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ivanbrykov/cloudflare-lead-desk/tree/main/templates/cloudflare)

1. Click the button to copy only [`templates/cloudflare`](templates/cloudflare)
   into a new repository in your GitHub account and connect it to Cloudflare.
   Cloudflare's copy omits `.github/workflows`; this installation needs no local
   Actions workflow.
2. Use **build command `pnpm run build`** and **deploy command
   `pnpm run deploy`**. The first deploy creates or resolves the named D1 database,
   applies migrations, and deploys the Worker; later deploys reuse it.
3. In the Worker's **Settings → Variables and Secrets**, set
   `BETTER_AUTH_SECRET` and `SETUP_TOKEN`, then redeploy before using the app.

Your generated repository owns only installation configuration; every build
compiles Lead Desk from the exact full source SHA recorded in `lead-desk.json`.
Ordinary rebuilds repeat the recorded revision. The generated README's **Upgrade
Lead Desk** button will open the centrally hosted Upgrade service after its
GitHub App is activated. The installation owner authorizes the App once for that
repository; each manual click then validates upstream `main` and creates one
source-pin commit only when the revision changes. Deployment applies pending
migrations to the existing `DB` binding and updates the existing Worker. Until
the service is activated, use the existing dedicated-template path for a live
upgrade button; do not treat this draft folder path as launched.

No GitHub Release package or publishing token is involved. See [source-built
installations](docs/source-built-installations.md) for pinning, template publishing,
migration compatibility, live verification limits, and converting an existing
full-source snapshot without replacing its database.

The template leaves both secrets empty. Generate separate random values for `BETTER_AUTH_SECRET` (`openssl rand -base64 32`) and `SETUP_TOKEN` (`openssl rand -hex 32`). Generate these once per installation and keep them across redeployments. The auth URL is detected automatically from the incoming request; there is no URL field to fill in.

After the first deploy, open the app, switch to sign-up, and create the first account using the invite token (`SETUP_TOKEN`). Registration is invitation-only by design: the bootstrap token creates the first account, and every later account requires a single-use invite that an authenticated staff member creates with `POST /v1/invites`. Only invited staff can create an account or reach data.

### Manual install from source

Prerequisites: a Cloudflare account, Node.js 24.20.0 (see `.node-version`) and pnpm 10.34.5. Install the pinned pnpm version using `npm install --global pnpm@10.34.5` if needed.

1. Install dependencies: `pnpm install --frozen-lockfile`.
2. Create the D1 database in your account with any name you like — it does not need to match the Worker, for example `pnpm exec wrangler d1 create lead-desk-db`. Copy the `database_id` it prints into the `d1_databases` entry in `wrangler.jsonc` (replacing the empty string) and set `database_name` to the same name you used.
3. Set the session secret: `openssl rand -base64 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET`.
4. Set the invite token: `openssl rand -hex 32 | pnpm exec wrangler secret put SETUP_TOKEN`. Keep it across redeployments.
5. Deploy: `pnpm run deploy` (set `CLOUDFLARE_ACCOUNT_ID` if your wrangler login spans multiple accounts). The deploy script builds, applies the D1 migrations, and deploys. The migration also bootstraps the default workspace, pipeline, and stage rows (fixed ids, `INSERT OR IGNORE`) and makes stage positions unique per pipeline — the app itself never seeds data per request, so deleted bootstrap rows are not resurrected. Migration commands reference the `DB` binding rather than a database name, so renamed databases keep working.

You can also connect the repository in the dashboard under Workers → Settings → Builds, with the deploy command set to `pnpm run deploy`.

Open the deployed app, switch to sign-up, and create the first account using
the `SETUP_TOKEN` invite token. Registration stays invitation-only: the
bootstrap token creates the first account only, and adding staff means
creating a single-use invite with `POST /v1/invites` from an authenticated
staff session. Only invited staff get data access.

Both `src/worker-global.ts` (the configured deployment entry) and the compatibility
entry `src/worker.ts` use the same app compiled at module scope.

Missing or old template-placeholder session secrets fail authentication closed.
An empty `SETUP_TOKEN` disables bootstrap-token registration only: active,
unused, unexpired staff invites stay redeemable, so revoke those too in order to
stop all new registrations. Production also rejects invite tokens shorter than
32 characters after trimming whitespace; this does not disable existing accounts or sign-in. The bootstrap token is usable until the first account
exists, and staff invite tokens are single-use; rotate `SETUP_TOKEN` if it
leaks.

A fresh deployment operates in bootstrap mode: sign-up is gated by
`SETUP_TOKEN` alone and every authenticated session is treated as staff.
Once the first account exists, the bootstrap grant is no longer available and
new staff accounts are created exclusively through single-use invites.

A fresh deployment also gets a one-time setup window: the migration seeds the
bootstrap grant with a 7-day expiry (`bootstrap_state`, fixed id `default`),
and the grant is consumed the moment the first account is created. Existing
installations gain access at upgrade because the same migration marks the
grant consumed when a user already exists, so nothing about the previous
sign-in flow changes for them. Audit the `bootstrap_state` row before
deploying if you are upgrading an installation you did not build.

If that one-time window expires before the first account is created, the
bootstrap token stops accepting sign-ups. Recovery is operator-only and
narrow on purpose: extend the window only for an unused grant, never reset
consumption, and never expose a public reset path. Run this against the D1
binding, replacing `<DB>` with your configured binding name:

```sh
pnpm exec wrangler d1 execute <DB> --remote --command \
  "UPDATE bootstrap_state SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days') WHERE id = 'default' AND consumed_at IS NULL AND NOT EXISTS (SELECT 1 FROM user);"
```

The `WHERE` clause refuses to touch a grant that was already consumed or a
database that already has an account, so the command is a no-op on a
healthy installation. Rotate `SETUP_TOKEN` in the same change if the
original value leaked.


### Adding staff

Staff accounts are created through single-use invites, not an email allowlist.
From an authenticated staff session, send `POST /v1/invites` with a
`{ name }` body (and an optional `expiresAt`, defaulting to 7 days); the
response contains the raw invite token exactly once. Share it with the new
staff member and have them sign up with it as the `x-setup-token` header on
`POST /api/auth/sign-up/email`:

```sh
curl https://crm.example.com/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -H 'x-setup-token: <invite-token>' \
  --data '{ "name": "New Staff", "email": "new@company.com", "password": "a-strong-password" }'
```

An invite is redeemed once and marked used automatically at sign-up; while it
is still available it can be listed (by 12-character prefix only) or revoked
with `DELETE /v1/invites/:id`.


### API tokens

Intake API tokens are created in **Settings → Tokens**. A token carries a
finite expiry that defaults to 90 days and must be in the future; `expiresAt`
is optional but never null on new tokens. Legacy rows created before the
expiry column existed keep a `null` `expiresAt` and are shown as
`No expiry (legacy)` — they keep working, and revoking them is the supported
way to retire one. A token's raw value is returned exactly once, at creation,
inside the dialog; the list only ever shows the 12-character prefix. Revoke a
token with `DELETE /v1/tokens/:id` or the Revoke action in the list. An
expired or revoked token returns `401 unauthorized` on use.

Invitations follow the same display-once rule with a 7-day default expiry,
and they can be used, expired, revoked, or still active — the list shows each
state and hides Revoke only for already-revoked rows.

### Managing staff accounts

`GET /v1/staff` lists every staff account as the public projection
(`id`, `name`, `email`, `disabledAt`); it never returns passwords, hashes,
tokens, or session material. `PATCH /v1/staff/:id` with
`{ "disabled": true }` disables an account: the durable disabled flag and the
deletion of all of that account's sessions commit in one D1 transaction, so
a disabled account's existing sessions are rejected immediately and sign-in
with its credentials is denied until the account is re-enabled. Re-enabling
with `{ "disabled": false }` restores the account's credentials; previously
issued sessions stay revoked, so the account must sign in again. An account
cannot disable itself, and the last enabled account cannot be disabled; both
return `409 conflict`. Unknown ids return `404 not_found`, and both endpoints
require an authenticated staff session.

### Optional auth URL override

By default, authentication uses the origin of each incoming Worker request, so a
new `workers.dev` address or a directly connected custom domain needs no extra
configuration. Production requires HTTPS. Only the resolved origin is trusted;
forwarded host/protocol headers do not change it. This assumes Cloudflare routes
the public request directly to the Worker.

To pin a canonical origin, or if a proxy rewrites the request URL, set the optional
`BETTER_AUTH_URL` variable to an absolute origin such as `https://crm.example.com`
(no path, query, or fragment). Add it to `vars` in your fork's `wrangler.jsonc` and
deploy. It is not a secret and is deliberately absent from the installer prompts.
When set, it takes precedence over request inference; use the app at that origin.
An invalid override fails authentication closed instead of falling back. Existing
installations with `BETTER_AUTH_URL` stored as a secret can keep it, or remove it
to enable automatic detection.

### Local development

Copy `.dev.vars.example` to `.dev.vars`, fill in `BETTER_AUTH_SECRET` and
`SETUP_TOKEN` using the generation commands above, and add
`ENVIRONMENT=development` to `.dev.vars` to allow local HTTP. Run
`pnpm run db:migrate:local`, then `pnpm run dev:worker` and open the URL it prints.
Enter the invite token on the sign-up screen to create a throwaway account;
sessions are stored in local D1.
Optionally add `DEV_ADMIN_EMAIL` to bypass the session check locally. Development
settings are deliberately absent from `.dev.vars.example`, whose entries become
installer prompts. Deployed configuration stays `ENVIRONMENT=production`.

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

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) verifies every push and pull request from a clean checkout. Verification uses no cloud credentials and performs no deployment:

1. `pnpm install --frozen-lockfile` — pnpm pinned by the `packageManager` field, Node from `.node-version`.
2. `pnpm run typecheck`.
3. `pnpm exec vitest run` — includes the Miniflare-backed D1 suites.
4. `pnpm run build`.
5. `pnpm exec wrangler deploy --dry-run` — validates the deployable bundle without authentication.
6. Source-build contract tests and an isolated template upgrade using local D1 and Chromium.
7. An append-only migration-history check against Git history.
8. The stable source-build command, preserving its source receipt as a CI artifact.

There is no package publication job. Installations compile their pinned commit with
its frozen lockfile, and only their explicit Upgrade workflow advances that pin.
See [the source installation contract](docs/source-built-installations.md).

## Development

```sh
pnpm run check
pnpm run build
```

`pnpm run check` runs the typecheck and the full test suite; the same gates (plus the build and the deploy dry-run) run in CI.

The public contract is REST/OpenAPI. Elysia handles HTTP, Effect Schema is the single validation model, and Effect commands contain domain rules. See [`docs/adr`](docs/adr).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
