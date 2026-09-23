# My Lead Desk installation

This repository owns your Cloudflare Worker, D1 binding, runtime settings, and
secrets. Lead Desk application code is compiled from the exact upstream commit in
`lead-desk.json`; ordinary builds never select a newer revision.

## First deployment

This repository was copied from the official Lead Desk Cloudflare folder
template. Cloudflare does not copy `.github/workflows`; Upgrade runs centrally
through the Lead Desk GitHub App. Optionally edit the Worker `name` and D1
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

[![Upgrade Lead Desk — activation pending](https://img.shields.io/badge/Upgrade-activation%20pending-808080?logo=githubactions&logoColor=white)](https://github.com/ivanbrykov/cloudflare-lead-desk/blob/main/apps/upgrade-service/README.md)

The central service is being activated. Until its HTTPS URL and GitHub App are
configured, the badge above opens setup information, not an Upgrade run. Do not
change your pin by clicking a workflow in this copied repository: Cloudflare
does not copy that workflow.

Once activated, the button will open the central Upgrade page. Authorize the
GitHub App once for this repository, select it, and confirm the manual upgrade.
The upstream-hosted workflow resolves `main` to a full SHA, compiles and validates
the candidate, checks old-pin SQL history even in a clean runner, and creates
only one `lead-desk.json` pin commit if the revision changes. An already-current
run makes no commit. A concurrent branch update or branch-protection rule fails
closed rather than being bypassed.

Resolution, read-only candidate validation, and the App-authored pin commit run
in separate hosted jobs. Candidate code never shares a runner with repository
write authority. No Cloudflare token or deploy hook is added. After the pin
commit appears, confirm that the connected Cloudflare build starts and retains
the same Worker and D1 IDs; this App-push behavior requires a live test.

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
