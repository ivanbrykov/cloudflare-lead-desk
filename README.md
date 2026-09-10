# Cloudflare Lead Desk

A self-hosted, Cloudflare-native CRM for teams handling inbound opportunities. It stores data in D1, serves a React workbench from Workers, and exposes a documented API for trusted form integrations.

## Alpha scope

- Contacts, opportunities, pipelines, stages, notes, and a Kanban work queue.
- Configurable fields for contacts and opportunities.
- Cloudflare Access staff authentication and displayed-once `intake:write` tokens.
- Idempotent, atomic `POST /v1/intakes` capture for websites and other trusted systems.

Companies, tasks, email sync, imports, reporting, workflows, custom objects, and multi-tenancy are deliberately not included yet.

## Install on Cloudflare

Prerequisites: a Cloudflare account, Node.js 24.20.0 (see `.node-version`) and pnpm 10.34.5, and a Cloudflare Zero Trust team.

Install the pinned pnpm version using `npm install --global pnpm@10.34.5` if needed.

1. Install dependencies: `pnpm install --frozen-lockfile`.
2. Create a D1 database: `pnpm exec wrangler d1 create cloudflare-lead-desk`.
3. Copy the returned database ID into `wrangler.jsonc`.
4. Configure a Cloudflare Access application for the deployed hostname. Set its audience value and team hostname in `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`.
5. Build and apply the generated migration: `pnpm exec wrangler d1 migrations apply cloudflare-lead-desk --remote`. The migration also bootstraps the default workspace, pipeline, and stage rows (fixed ids, `INSERT OR IGNORE`) and makes stage positions unique per pipeline — the app itself never seeds data per request, so deleted bootstrap rows are not resurrected.
6. Deploy: `pnpm run deploy`.

Both `src/worker-global.ts` (the configured deployment entry) and the compatibility
entry `src/worker.ts` use the same app compiled at module scope.

For local development, copy `.dev.vars.example` to `.dev.vars`, use `ENVIRONMENT=development`, then run `pnpm run dev:worker` and `pnpm run dev`. `DEV_ADMIN_EMAIL` is honored only outside production.

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

## Custom fields

Custom fields are configured per contact and opportunity (Settings → Fields) and validated against the active definitions:

- Creation (`POST /v1/contacts`, `POST /v1/opportunities`, `POST /v1/intakes`) must provide every required field. `null` is rejected for required fields, and blank optional fields are simply omitted.
- `PUT /v1/contacts/:id` treats `customFields` as a patch: omit the object or a key to keep the stored value, and send an explicit `null` to clear an optional field. Required fields cannot be cleared, and a custom-fields update still fails for a contact that has no stored value for a required field. Unknown or archived keys are always rejected.
- Reads expose active definitions only. Archived definitions keep their stored values for historical export but are excluded from payloads, so an archived value never blocks editing a contact.
- Core fields and custom-field values are written in a single D1 transaction, so a failed field write rolls back the whole request.

## Development

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

The public contract is REST/OpenAPI. Elysia handles HTTP, Effect Schema is the single validation model, and Effect commands contain domain rules. See [`docs/adr`](docs/adr).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
