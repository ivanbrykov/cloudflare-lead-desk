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

The permanent `README.md` installation link points at the dedicated public GitHub
template repository. That repository is published from reviewed
`templates/cloudflare/` content and preserves `.github/workflows`; Cloudflare's
subdirectory copy does not. PR source previews may still use the whole feature
branch as shown above, but never restore the subdirectory Deploy Button as the
supported installation path.

## Secrets

`BETTER_AUTH_SECRET` and `SETUP_TOKEN` are the only required secrets. Generate
fresh random values per installation; never commit one. `.dev.vars.example`
lists them with empty values and is the template the installer reads — keep both
secrets out of it.

## Source distribution

- Template scripts/config live in `templates/cloudflare/` and must work when
  copied alone to a new repository. Do not use parent workspace imports there.
- Published SQL migration names and contents are immutable; add new migrations.
- Ordinary template builds fetch and compile only the full SHA recorded in
  `lead-desk.json`; only the explicit Upgrade workflow may advance that pin.
- Keep Worker/UI/migration build details in the upstream `source:build` command.
  Failed fetches, installs, builds, or validation must block deployment.
- The manual updater may commit only the source pin, never force-push, bypass
  branch protection, or deploy a customer installation directly.
- After a reviewed template change lands on main, publish the
  `templates/cloudflare/` tree to `ivanbrykov/cloudflare-lead-desk-template` and
  verify the dedicated repository's root tree before advertising the change.
- Validate with `pnpm run test:source` and `pnpm run test:distribution` in addition
  to the app checks when changing source distribution or installer behavior.
