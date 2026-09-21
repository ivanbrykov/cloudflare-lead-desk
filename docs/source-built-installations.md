# Source-built installation and upgrade contract

`templates/cloudflare/` is an isolated installation project. Deploy to Cloudflare
can treat that folder as the root of a user's new repository. It owns Wrangler
configuration, D1 identity, secrets, the exact upstream source pin, and a small set
of installer scripts; it does not import the parent workspace.

## Pinned build

`lead-desk.json` records the public upstream `owner/repository` and a full
40-character commit. `pnpm run build`:

1. Invalidates deploy readiness and acquires the owned `.lead-desk/.lock`.
2. Initializes an isolated temporary Git checkout, fetches exactly the recorded
   commit, checks it out detached, and verifies `HEAD` equals the pin.
3. Installs the fetched source's dependencies from its `pnpm-lock.yaml` with
   `pnpm install --frozen-lockfile`.
4. Runs the upstream-owned `source:build` command. The template does not duplicate
   Vite, esbuild, Worker-entry, or dependency knowledge.
5. Verifies the Worker, UI, runtime requirements, migration names and hashes, and
   source-commit receipt before atomically promoting generated output.

The build subprocess does not receive known deployment credentials or application
secrets. Installation files and `.dev.vars` are never copied into source. Failed
fetches, installs, builds, runtime checks, and migration checks leave D1 and tracked
configuration untouched and keep deployment blocked until a successful rebuild.

The initial pin, `8c8f7cdede319c7ab1785a2917c8d0f73fa565ac`, is reachable
on upstream main but predates `source:build`. The installer permits that commit
alone to run its existing local release builder, then consumes the unpacked local
build output. It does not contact GitHub Releases. Every later revision must expose
the stable source-build command.

## Explicit Upgrade workflow

The copied repository includes `.github/workflows/upgrade.yml`. Its manual
`workflow_dispatch` job checks out the repository's actual default branch, resolves
upstream `main` once, builds and validates that exact candidate, changes only
`lead-desk.json`, and pushes one ordinary commit. It grants only `contents: write`,
uses no Cloudflare token, never force-pushes, and refuses to run in the upstream
source repository. A concurrent branch advance or branch protection rejection is
reported as a failed push. An already-current run produces no commit.

The installation README's Upgrade button uses
`../../actions/workflows/upgrade.yml`. GitHub documents that relative links in a
rendered README are transformed for the current repository and branch, avoiding a
hard-coded consumer repository name.

Cloudflare's Deploy Button documentation says a referenced subdirectory is treated
as the new repository root, but does not explicitly promise that
`.github/workflows` is copied. The template therefore includes an identical root
`upgrade-workflow.yml`; if the workflow is absent, the owner uses GitHub's **set up
a workflow yourself** flow to commit it once as `.github/workflows/upgrade.yml`.

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

Do not press the deploy button again for an installation whose D1 must survive.
Migrate its repository in a review branch:

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

Before claiming the complete one-click experience, run these live gates on an
approved disposable target:

1. Copy the template through the actual Deploy to Cloudflare flow.
2. Confirm the workflow file and repository-relative README button in the copied
   repository, or record the one-time fallback step.
3. Run Upgrade and verify its bot commit triggers Workers Builds while the Worker
   name, D1 name/ID, secrets, and stored records remain unchanged.

Mocks and local Git repositories are not evidence for those platform behaviors.
