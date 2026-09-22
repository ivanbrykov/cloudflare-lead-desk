# My Lead Desk installation

This repository owns your Cloudflare Worker, D1 binding, runtime settings, and
secrets. Lead Desk application code is compiled from the exact upstream commit in
`lead-desk.json`; ordinary builds never select a newer revision.

## First deployment

This repository was generated from the official Lead Desk GitHub template, so the
Upgrade workflow is already present. Before importing it, optionally edit the
Worker `name` and D1 `database_name` in `wrangler.jsonc`; keep those identities and
both authentication secrets across upgrades.

1. In Cloudflare Workers & Pages, choose **Create application → Import a
   repository** and select this repository.
2. Configure Workers Builds with:

   - **Build command:** `pnpm run build`
   - **Deploy command:** `pnpm run deploy`
   - **Node:** 24.20.0 or later within Node 24
   - **pnpm:** 10.34.5 (also pinned in `package.json`)
3. Save and deploy. The trusted deploy helper creates or resolves the named D1
   database, records its ID in the ephemeral build checkout, applies migrations,
   and then deploys the Worker.
4. In the Worker's **Settings → Variables and Secrets**, add
   `BETTER_AUTH_SECRET` and `SETUP_TOKEN`, then redeploy before using the app.

The build fetches only the full source SHA recorded in `lead-desk.json`, installs
that checkout with its frozen `pnpm-lock.yaml` (including build-time development
dependencies even when `NODE_ENV=production`), and runs its source-build command.
The compiled Worker, browser assets, migrations, runtime requirements, and source
receipt are prepared under ignored `.lead-desk/current/`. The deploy command
checks that receipt, applies pending migrations through your existing `DB`
binding, and deploys to your existing Worker.

The initial pin is a reachable, immutable upstream commit. No GitHub Release or
release asset is downloaded.

## Upgrade Lead Desk

[![Upgrade Lead Desk](https://img.shields.io/badge/Upgrade-Lead%20Desk-2088ff?logo=githubactions&logoColor=white)](../../actions/workflows/upgrade.yml)

1. Select **Run workflow** on the page opened by the button.
2. Confirm the run on your repository's default branch.

The workflow resolves upstream `main` once to a full commit SHA, compiles and
validates that candidate, and compares its migration history with SQL fetched from
the previously pinned commit even in a clean runner. It then changes only
`revision` in `lead-desk.json`. If the pin is already current, it creates no
commit. Otherwise it makes one normal `github-actions[bot]` commit and pushes
without force. A concurrent update or
branch-protection rule that rejects direct pushes makes the workflow fail rather
than bypassing the rule.

Resolution, candidate validation, and the pin commit run as three isolated hosted
jobs. Candidate install/build code receives read-only repository permissions and a
checkout with credentials removed. The fresh write job consumes only immutable
resolver outputs, executes no repository script, reconstructs only
`lead-desk.json`, rechecks the default-branch SHA and old pin, and exposes the
write token only to that trusted inline step. Workflow actions are pinned to full
commit SHAs; no artifacts or caches cross the validation/write boundary.

The button uses a repository-relative GitHub link, so it targets this copied
repository rather than the upstream Lead Desk repository.

Cloudflare documents that pushes to the configured production branch trigger a
Workers Build. The specific workflow-token push path still needs a live copied
repository verification. After the upgrade commit appears, confirm that a
Cloudflare build starts and retains the same Worker and D1 IDs. If it does not,
push the pin commit with an owner credential or start the existing connected build
manually; do not add a deploy-hook URL or Cloudflare credential to this workflow.

## Rebuild or deploy locally

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run deploy
```

Cloudflare installs this repository's small tooling dependency set before its
build command. `pnpm run deploy` deliberately does not fetch source again: its
preflight requires the prepared repository and commit to match `lead-desk.json`,
resolves the installation's D1 identity, applies pending migrations, and deploys
exactly that successful prepared build.

To work against local D1 and HTTPS workerd:

```sh
cp .dev.vars.example .dev.vars
# Fill .dev.vars with new local-only values; never commit it.
pnpm run build
pnpm run db:migrate:local
pnpm exec wrangler dev --local --local-protocol https
```

`pnpm run deploy:dry-run` validates the prepared Worker without deploying.

## Pins, migrations, and failed builds

`lead-desk.json` must contain a public GitHub `owner/repository` and an exact
40-character `revision`. Do not replace the revision with `main`, `latest`, a tag,
or a shortened SHA. Rebuilding the same commit does not update the application.

A pin to older application code is not a database rollback. SQL migrations are
forward-only, existing migration names and contents are immutable, and new
migrations are applied once. Restore a D1 backup or use an explicitly compatible
corrective revision when recovering from a bad migration.

An unreachable commit, frozen install failure, source-build failure, rewritten
migration, or incompatible runtime requirement removes the readiness marker and
blocks deployment. Existing D1 data and tracked configuration remain untouched;
the last prepared Worker files are not treated as deployable until a successful
rebuild restores readiness.

The updater never copies `.dev.vars` or installation files into upstream source.
It removes deployment credentials from dependency-install and build subprocesses,
builds in an owned staging directory, and promotes only validated output.
`.lead-desk/.lock` prevents concurrent builds. If a killed process leaves that
directory behind, first confirm no build is running, then remove only the lock
directory and rebuild. Do not edit `.lead-desk/current` manually.
