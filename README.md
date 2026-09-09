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
5. Build and apply the generated migration: `pnpm exec wrangler d1 migrations apply cloudflare-lead-desk --remote`.
6. Deploy: `pnpm run deploy`.

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
