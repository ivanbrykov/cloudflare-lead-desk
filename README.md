# Cloudflare Lead Desk

A self-hosted, Cloudflare-native CRM for teams handling inbound opportunities. It stores data in D1, serves a React workbench from Workers, and exposes a documented API for trusted form integrations.

## Alpha scope

- Contacts, opportunities, pipelines, stages, notes, and a Kanban work queue.
- Configurable fields for contacts and opportunities.
- Cloudflare Access staff authentication and displayed-once `intake:write` tokens.
- Idempotent, atomic `POST /v1/intakes` capture for websites and other trusted systems.

Companies, tasks, email sync, imports, reporting, workflows, custom objects, and multi-tenancy are deliberately not included yet.

## Install on Cloudflare

Prerequisites: a Cloudflare account, Bun or Node 24+, and a Cloudflare Zero Trust team.

1. Install dependencies: `bun install` (or `npm install` where Bun is unavailable).
2. Create a D1 database: `bunx wrangler d1 create cloudflare-lead-desk`.
3. Copy the returned database ID into `wrangler.jsonc`.
4. Configure a Cloudflare Access application for the deployed hostname. Set its audience value and team hostname in `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`.
5. Build and apply the generated migration: `bunx wrangler d1 migrations apply cloudflare-lead-desk --remote`.
6. Deploy: `bun run deploy`.

For local development, copy `.dev.vars.example` to `.dev.vars`, use `ENVIRONMENT=development`, then run `npm run dev:worker` and `npm run dev`. `DEV_ADMIN_EMAIL` is honored only outside production.

## Integration API

Create an intake token in **Settings → Tokens**, then send an idempotent form submission:

```sh
curl https://crm.example.com/v1/intakes \
  -H 'Authorization: Bearer cld_…' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: a-stable-submission-id' \
  --data '{
    "source": "ileo",
    "contact": { "email": "sam@example.com", "firstName": "Sam" },
    "opportunity": {
      "name": "Rivera family — Fall",
      "source": "calculator",
      "customFields": { "cohort": "Fall" }
    }
  }'
```

The interactive OpenAPI documentation is available at `/openapi`.

## Development

```sh
npm run typecheck
npm test
npm run build
```

The public contract is REST/OpenAPI. Elysia handles HTTP, Effect Schema is the single validation model, and Effect commands contain domain rules. See [`docs/adr`](docs/adr).

## Licence

Apache-2.0. See [LICENSE](LICENSE).
