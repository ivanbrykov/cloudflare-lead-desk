# Source-built installation and upgrade contract

`templates/cloudflare/` is the installation project copied by Cloudflare's
Deploy button from this repository. Cloudflare's copy omits `.github/workflows`,
so the Upgrade workflow runs centrally in upstream Lead Desk rather than in the
copied installation. The generated repository owns Wrangler configuration, D1
identity, secrets, the exact upstream source pin, and a small set of installer
scripts; it does not import the parent workspace.

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

## Explicit Upgrade workflow

After activation, the installation README's Upgrade button leads to the [central
Upgrade service](../apps/upgrade-service/README.md). Until then, the draft badge
opens setup guidance rather than starting a run. The user authorizes the Lead Desk
GitHub App once for their copied repository; each later click authenticates the
user, checks their write permission and App repository scope, and dispatches
`.github/workflows/cloudflare-upgrade.yml` in the upstream repository. The
requester cannot directly dispatch that upstream workflow.

The workflow uses three fresh hosted runners:

1. A read-only resolver records the installation's repository ID, actual default
   branch/SHA, current source pin, requester permission, and exact upstream-main
   candidate before candidate code runs.
2. A separate read-only validator checks out the installation without persisted
   credentials, compiles the exact candidate, fetches SQL from the old recorded
   revision, and rejects removed or rewritten migrations even without generated
   output. It emits no artifact or output used by the writer.
3. A fresh writer receives a single-repository App token with Contents write only
   after validation. Trusted upstream code rereads the original configuration,
   rechecks requester permission, pin and default-branch SHA, creates one
   `lead-desk.json` blob/tree/commit through GitHub's Git Data API, and advances
   the branch without force. It runs no candidate or installation scripts.

All workflow actions are pinned to full commit SHAs. Candidate code never shares
a runner with repository write authority, and no artifact/cache crosses that
boundary. The workflow uses no Cloudflare token; concurrent branch advances and
branch-protection rejections fail closed. An already-current run makes no commit.

Whether this GitHub App-authored pin commit starts the installation's Cloudflare
Workers Build is a live integration gate. The answer cannot be inferred from
GitHub Actions `GITHUB_TOKEN` suppression behavior. Do not add a plaintext
Cloudflare deploy hook or Cloudflare API token to solve that uncertainty.

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
   contains `lead-desk.json` and the README Upgrade button. The absence of
   `.github/workflows` is expected.
2. Inspect the Cloudflare application already created by the folder button;
   do not import the repository again. Confirm D1 provisioning occurs before
   migrations/deployment, set the two runtime secrets, and redeploy that
   existing application. Import a repository only when it was created without
   the Deploy button.
3. Authorize the GitHub App once, run Upgrade, and verify its App commit triggers Workers Builds while the Worker
   name, D1 name/ID, secrets, and stored records remain unchanged.

Mocks and local Git repositories are not evidence for those platform behaviors.

The former dedicated GitHub template repository is not part of this installation
path. It need not be deleted to use the Cloudflare folder button; deleting it is
a separate owner decision.
