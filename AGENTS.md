# Agent Instructions — cloudflare-lead-desk

Read this before opening a pull request. It is the project-level policy for
coding agents; the machine-wide `/mnt/data/AGENTS.md` still applies on top.

## Stack

- Cloudflare Worker serving Elysia (HTTP) + React/Vite workbench, D1 database.
- Validation and public contracts live in Effect Schema (`src/domain/schemas.ts`).
  Do not add a second validator for a schema that already has one.
- Drizzle stays inside `src/db/repository.ts`; business rules go in Effect
  commands (`src/application/`). Keep that boundary.
- Node 24.20.0 (see `.node-version`), pnpm 10.34.5 (see `packageManager`).
  Use `pnpm run <script>` and `pnpm exec <tool>`; do not introduce Bun.

## Before opening a PR

Run `pnpm run check` (lint + typecheck + test). It must be green. The CI job
`.github/workflows/ci.yml` runs the same thing plus a build and a
`wrangler deploy --dry-run`, so a local pass means CI will pass.

Do not copy code, product copy, UI assets, or screenshots from Attio, HubSpot,
Twenty, or other reference products. See `CONTRIBUTING.md` and `SECURITY.md`.

## Deploy button in the PR body (required)

Every pull request that a reviewer might want to try must include a "Deploy to
Cloudflare" button wired to **that PR's branch**. The button belongs in the PR
description, never in `README.md` or any committed file.

The URL is a static string with no way to discover the branch, so substitute the
branch name by hand — this is the one step that must not be skipped:

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ivanbrykov/cloudflare-lead-desk/tree/<BRANCH>)
```

Replace `<BRANCH>` with the head branch of the PR, for example:

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ivanbrykov/cloudflare-lead-desk/tree/feature/single-use-invitations)
```

Why the PR body and not the repo: the button clones the repo into the
*reviewer's* own GitHub account and provisions a fresh D1 and secrets in their
Cloudflare account. It is a throwaway preview of that branch, not a window into
a deployment that already exists. Putting it in the PR body keeps it tied to the
branch it describes and removes it when the PR closes; putting it in `README.md`
leaves a stale link behind after every merge.

The `README.md` button stays pointed at the repository root and deploys `main`.
Do not add a `/tree/<branch>` path to it — a bare URL resolves to the default
branch at clone time, which is correct for the permanent install path.

## Secrets

`BETTER_AUTH_SECRET` and `SETUP_TOKEN` are the only required secrets. Generate
fresh random values per installation; never commit one. `.dev.vars.example`
lists them with empty values and is the template the installer reads — keep both
secrets out of it.
