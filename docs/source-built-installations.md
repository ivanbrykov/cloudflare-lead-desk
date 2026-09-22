# Source-built installation and upgrade contract

`templates/cloudflare/` is the reviewed source for the dedicated public
`ivanbrykov/cloudflare-lead-desk-template` repository. GitHub creates each
installation from that template's complete default-branch tree, preserving the
Upgrade workflow that Cloudflare's subdirectory-copy flow omitted. The generated
repository owns Wrangler configuration, D1 identity, secrets, the exact upstream
source pin, and a small set of installer scripts; it does not import the parent
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

The dedicated template's initial pin is merged upstream commit
`ad31f24d22aff10c1a80447f1c2549f22e62f0e1`, which exposes the stable
source-build command. For existing installations only, the installer retains a
narrow adapter for historical pin `8c8f7cd...`; it consumes that commit's local
build output and never contacts GitHub Releases.

## Explicit Upgrade workflow

The copied repository includes `.github/workflows/upgrade.yml`. Its manual
`workflow_dispatch` flow uses three fresh hosted runners:

1. A read-only resolver checks out the actual default branch without persisted
   credentials and records its SHA, old source configuration, and upstream-main
   target before candidate code runs.
2. A separate read-only validator compiles that exact candidate, fetches the old
   recorded revision, and compares immutable SQL history even when generated output
   is absent. It emits no artifact or output used by the writer.
3. A fresh writer receives `contents: write` only after validation. It checks the
   default branch still equals the resolved base, parses the old configuration from
   that commit, reconstructs only `lead-desk.json` using Git plumbing, verifies the
   one-path diff, rechecks the remote SHA, and performs a normal non-force push. It
   executes no checked-out repository helper or candidate output.

All referenced GitHub actions are pinned to full commit SHAs. Candidate code never
shares a runner with repository write authority, and no artifact/cache crosses that
boundary. The workflow uses no Cloudflare token, refuses to run in the upstream
source repository, and reports concurrent branch advances or branch-protection
rejections instead of bypassing them. An already-current run produces no commit.

The generated installation README's Upgrade button uses
`../../actions/workflows/upgrade.yml`. GitHub documents that relative links in a
rendered README are transformed for the current repository and branch, avoiding a
hard-coded consumer repository name.

Cloudflare documents that every push to the configured production branch triggers
a Workers Build. Whether a push made with a workflow's `GITHUB_TOKEN` reaches that
external GitHub App is still a live integration gate; GitHub's suppression of
recursive Actions workflows does not prove either outcome. Do not add a plaintext
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

1. Generate a repository through the dedicated GitHub template and confirm
   `.github/workflows/upgrade.yml` plus the repository-relative README button.
2. Import that generated repository into Cloudflare, verify D1 provisioning occurs
   before migrations/deployment, set the two runtime secrets, and redeploy.
3. Run Upgrade and verify its bot commit triggers Workers Builds while the Worker
   name, D1 name/ID, secrets, and stored records remain unchanged.

Mocks and local Git repositories are not evidence for those platform behaviors.

## Publishing the dedicated template

The upstream folder remains the source of truth. Publish only reviewed main content
by splitting `templates/cloudflare/` into the dedicated repository's `main` branch,
then verify its root tree, workflow syntax, template-repository setting, and commit
SHA. Do not add release archives or a package registry. Changes to the dedicated
repository should be traceable to an upstream reviewed commit.
