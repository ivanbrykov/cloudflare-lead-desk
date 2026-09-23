# My Lead Desk installation

This repository owns your Cloudflare Worker, D1 binding, runtime settings, and
secrets. Lead Desk application code is compiled from the exact upstream commit in
`lead-desk.json`; ordinary builds never select a newer revision.

## First deployment

This repository was copied from the official Lead Desk Cloudflare folder
template. Cloudflare does not copy `.github/workflows`; the optional Upgrade
workflow takes one setup commit. Optionally edit the Worker `name` and D1
`database_name` in `wrangler.jsonc` before deployment; keep those identities and
both authentication secrets across upgrades.

1. If you used the Deploy to Cloudflare button, open the Cloudflare application
   it already created; **do not import this repository again**. Only if you
   created the repository separately, choose **Create application → Import a
   repository** in Cloudflare Workers & Pages and select it.
2. Confirm Workers Builds uses:

   - **Build command:** `pnpm run build`
   - **Deploy command:** `pnpm run deploy`
   - **Node:** 24.20.0 or later within Node 24
   - **pnpm:** 10.34.5 (also pinned in `package.json`)
3. Let the button-started build finish, or save and deploy the manual import.
   The trusted deploy helper creates or resolves the named D1 database, records
   its ID in the ephemeral build checkout, applies migrations, and deploys the
   Worker.
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

First, **[install the Upgrade workflow](../../new/main?filename=.github%2Fworkflows%2Fupgrade.yml&value=name%3A%20Upgrade%20Lead%20Desk%0A%0Aon%3A%0A%20%20workflow_dispatch%3A%0A%0Apermissions%3A%0A%20%20contents%3A%20write%0A%0Ajobs%3A%0A%20%20upgrade%3A%0A%20%20%20%20uses%3A%20ivanbrykov%2Fcloudflare-lead-desk%2F.github%2Fworkflows%2Fcloudflare-upgrade.yml%40main%0A)** once. Review the new file path (`.github/workflows/upgrade.yml`) and its contents, then commit it to this repository's default branch. GitHub's editor may not prefill the file; if it is blank, copy [the small workflow file](upgrade-workflow.yml) into that path. This one-time commit does not advance your source pin.

If you renamed the default branch from `main`, create the file on your current
default branch instead of using the prefilled link's `main` destination.

[![Upgrade Lead Desk](https://img.shields.io/badge/Upgrade-Lead%20Desk-blue)](../../actions/workflows/upgrade.yml)

After installation, the button opens this repository's Actions page. Select
**Run workflow** on the default branch. The workflow resolves the latest
upstream `main` commit, builds and checks it without write credentials, checks
your old SQL migration history, and commits only the new `lead-desk.json` pin
from a separate runner. It calls a reusable workflow maintained in the
[upstream Lead Desk repository](https://github.com/ivanbrykov/cloudflare-lead-desk/blob/main/.github/workflows/cloudflare-upgrade.yml).

Back up D1 before running Upgrade. After it finishes, confirm the pin commit
and the connected Cloudflare build, Worker name, D1 ID, secrets, and stored
records. If your repository blocks Actions from writing, review its Actions
permissions and branch rules. The installed workflow calls upstream `@main`,
so each manual run uses the current upstream upgrade logic with temporary
write permission to this repository. Review that upstream workflow before
enabling it and run it only when you are ready to upgrade.

### Manual alternative

An ordinary rebuild uses the exact source commit in `lead-desk.json`; it does
not pick up new upstream changes. To upgrade:

1. Back up your D1 database. Record the current Worker name, `DB` database ID,
   and secret **names** so you can verify they stay attached. SQL migrations are
   forward-only; changing the source pin back is not a database rollback.
2. Choose a commit from [upstream Lead Desk `main`](https://github.com/ivanbrykov/cloudflare-lead-desk/commits/main)
   and confirm CI passed for that exact commit. Copy its full 40-character SHA.
   Before editing, compare the current SHA in
   `lead-desk.json` with the new SHA using GitHub's upstream compare view
   (`https://github.com/ivanbrykov/cloudflare-lead-desk/compare/OLD...NEW`).
   Check `drizzle/*.sql`: existing migrations must not be removed or changed;
   new migration names must come after the old ones. If the candidate rewrites
   history or is not descended from your current pin, stop and investigate.
3. Change **only** `revision` in this repository's `lead-desk.json` to that SHA.
   Leave `repository`, `wrangler.jsonc`, secrets, and the D1 binding/ID alone.
   For a local preflight before committing, run `pnpm install --frozen-lockfile`,
   `pnpm run build`, and `pnpm run deploy:dry-run` in your installation checkout.
   A clean checkout cannot check old SQL history for you, so step 2 still matters.
4. Commit only `lead-desk.json` to the branch connected to Cloudflare. Workers
   Builds will compile the pinned source and deploy to the existing Worker and
   D1 database. Check the build result and confirm the Worker name, D1 ID,
   secrets, and stored records are unchanged. If the build fails, fix the cause
   before retrying; do not treat an older source pin as a D1 rollback.

There is no GitHub App, separate Upgrade Worker, Release package, or publishing
token in either upgrade path. See [source-built installation details](https://github.com/ivanbrykov/cloudflare-lead-desk/blob/main/docs/source-built-installations.md)
for the migration and recovery boundaries.

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
