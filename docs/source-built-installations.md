# Source-built installation and upgrade contract

`templates/cloudflare/` is the installation project copied by Cloudflare's
Deploy button from this repository. Cloudflare's copy omits `.github/workflows`,
but none is needed for a manual source-pin upgrade. The generated repository
owns Wrangler configuration, D1 identity, secrets, the exact upstream source
pin, and a small set of installer scripts; it does not import the parent
workspace.

## Pinned build

`lead-desk.json` records the public upstream `owner/repository` and a full
40-character commit. `pnpm run build`:

1. Invalidates deploy readiness and acquires the owned `.lead-desk/.lock`.
2. Initializes an isolated temporary Git checkout, fetches exactly the recorded
   commit, checks it out detached, and verifies `HEAD` equals the pin.
3. Installs the fetched source's dependencies from its `pnpm-lock.yaml` with
   `pnpm install --frozen-lockfile --prod=false`, so compilation tools remain
   available even when the build environment sets `NODE_ENV=production`.
4. Runs the upstream-owned `source:build` command. The template does not duplicate
   Vite, esbuild, Worker-entry, or dependency knowledge.
5. Verifies the Worker, UI, runtime requirements, migration names and hashes, and
   source-commit receipt before atomically promoting generated output.

The build subprocess does not receive known deployment credentials or application
secrets. Installation files and `.dev.vars` are never copied into source. Failed
fetches, installs, builds, runtime checks, and migration checks leave D1 and tracked
configuration untouched and keep deployment blocked until a successful rebuild.

The template's initial pin is merged upstream commit
`ad31f24d22aff10c1a80447f1c2549f22e62f0e1`, which exposes the stable
source-build command. For existing installations only, the installer retains a
narrow adapter for historical pin `8c8f7cd...`; it consumes that commit's local
build output and never contacts GitHub Releases.

## Manual pin update

An ordinary rebuild never advances the pin. The installation owner deliberately
chooses a full upstream commit SHA from `main` after its CI has passed, backs up
D1, and compares that candidate with the current `lead-desk.json` revision.
Check that the old revision is an ancestor of the candidate and that every
published `drizzle/*.sql` file is unchanged. In a separate checkout of the
upstream source, substitute the two full SHAs in:

```sh
git merge-base --is-ancestor OLD_SHA NEW_SHA
git diff --name-status OLD_SHA NEW_SHA -- 'drizzle/*.sql'
```

The first command must succeed. The second may show only added (`A`) migration
files, with names after the old history; modified, deleted, renamed, or reordered
migrations are a stop condition. A clean Cloudflare build has no old generated
receipt to compare against, so this check is required before changing the pin.

Change only `revision` in the installation's `lead-desk.json`. Optionally run
`pnpm install --frozen-lockfile`, `pnpm run build`, and
`pnpm run deploy:dry-run` in a local installation checkout before committing.
Commit only that file to the Cloudflare-connected branch. Workers Builds uses
the exact new SHA, applies pending migrations to the existing `DB` binding,
and deploys the existing Worker. Check the build and unchanged Worker/D1
identities, secrets, and stored records. No GitHub App, Actions workflow,
Release asset, publishing token, or Cloudflare deploy hook is required.

## Migration and rollback boundary

Published migration names and contents remain immutable. CI compares the current
`drizzle/*.sql` files with the pull-request base or previous pushed commit, rejects
removal or rewriting, and requires appended names to sort after history. The
installer also compares a candidate's migration receipt with the currently
prepared receipt when that state is available.

Migrations run before Worker deployment and are not part of a cross-resource
transaction. A source pin or Worker-version rollback does not reverse D1. Prefer
additive migrations and staged compatibility; restore a D1 backup or deploy a
compatible corrective revision when database rollback is required.

## Existing full-source snapshot installations

Do not generate a replacement repository for an installation whose D1 must
survive. Migrate its existing repository in a review branch:

1. Back up D1 and record the Worker name, `DB` binding/name/ID, build settings,
   runtime variables, and secrets. Keep the existing Cloudflare resources.
2. Replace application source/build files with the isolated template while
   preserving deployment-specific Wrangler values. Adopt the template's Worker
   entry, assets path, and migrations path, but keep `DB` bound to the existing ID.
3. Confirm every historical SQL migration is byte-identical to upstream history.
   Review custom schema changes separately.
4. Install with the frozen template lockfile, build the pinned source, and run
   `pnpm run deploy:dry-run`.
5. Point the existing Workers Build at `pnpm run build` / `pnpm run deploy`, then
   deploy to the same Worker and D1.

This feature does not mutate existing installation repositories or Cloudflare
resources automatically.

## Verification boundary

Local integration uses actual pinned Git checkouts, frozen installs, real Worker/UI
compilation, HTTPS workerd, local D1, Chromium, and Wrangler deployment dry-runs.
It exercises two controlled commits, an additive migration, persistent application
and authentication state, idempotent rebuild/upgrade, unreachable revisions, and
rewritten migration rejection.

Before claiming the complete installation experience, run these live gates on an
approved disposable target:

1. Generate a repository through the Cloudflare folder button and confirm it
   contains `lead-desk.json` and the README's manual upgrade instructions. The
   absence of `.github/workflows` is expected.
2. Inspect the Cloudflare application already created by the folder button;
   do not import the repository again. Confirm D1 provisioning occurs before
   migrations/deployment, set the two runtime secrets, and redeploy that
   existing application. Import a repository only when it was created without
   the Deploy button.
3. On an approved disposable installation, manually commit a reviewed pin
   change and verify its ordinary Git push triggers Workers Builds while the
   Worker name, D1 name/ID, secrets, and stored records remain unchanged.

Mocks and local Git repositories are not evidence for those platform behaviors.

The former dedicated GitHub template repository is not part of this installation
path. It need not be deleted to use the Cloudflare folder button; deleting it is
a separate owner decision.
