# Package releases and the installation template

`templates/cloudflare/` is an isolated installation project. Deploy to Cloudflare
can copy that folder as the root of a user's repository. It has its own dependency
lockfile, Worker entrypoint, Wrangler configuration, installer scripts, and secret
example. It does not depend on a parent workspace or the upstream source tree.

The template's `pnpm run build` resolves a release, downloads its versioned asset,
verifies its checksum, installs the tarball offline with scripts disabled into an
ignored staging project, verifies the package metadata and migration hashes, and
promotes the prepared application to `.lead-desk/current/`. Tracked files remain
unchanged. Static assets come from the package; users need no Vite toolchain.

## Release pipeline

The upstream CI verification job runs lint/typecheck/product tests, source build
and deploy dry-run, release contract tests, and a real template install/upgrade
exercise using local D1 and Chromium. It then creates:

- `lead-desk.tgz`: `@ivanbrykov/lead-desk`, bundled Worker, assets, SQL migrations,
  release metadata, project license and linked Worker legal comments.
- `lead-desk.json`: version, source commit, required runtime date/flags, archive
  SHA-256, and the migration filename/hash history.

PR/branch builds preserve these as CI artifacts. Only the upstream repository's
verified main pushes (or a manual workflow run on main) can publish. Releases use
`build-<full-source-commit>` tags and package versions
`0.1.0-main.<workflow-run-number>.<attempt>`. These are rolling main builds, not a
promise of stable API compatibility. GitHub marks them as normal releases so its
latest endpoint can select them.

The publishing job checks that main still points at the verified commit, checks
migration history against the prior latest release, uploads both assets to a
draft, and only then publishes it as latest. Published assets are never replaced;
an interrupted draft upload may resume only if its existing asset digests match.
If they differ (for example after rebuilding on a workflow retry), review and
remove the unpublished draft before retrying. Published assets are never clobbered. Concurrent publishers are serialized,
and a superseded main build is skipped (or left as a draft if main advanced during
upload). The previous published latest stays available when verification fails.

The public convenience link is:

```text
https://github.com/ivanbrykov/cloudflare-lead-desk/releases/latest/download/lead-desk.tgz
```

The updater does not put that moving URL in a frozen lockfile. It resolves latest
once through the GitHub API, then fetches `lead-desk.json` and `lead-desk.tgz` from
the same exact tag. The digest detects mismatched/corrupt downloads; it is not an
independent signature against compromise of the trusted upstream repository.

## First release

1. Review and merge this implementation into upstream main.
2. Let CI complete and publish the first package release (or run CI manually on
   main if a previous verification run failed).
3. Confirm the release contains both assets before trying the template button.

The feature-branch implementation does not publish anything by itself. Before
that first release, the template correctly fails with no release available.

## Existing full-source snapshot installations

Do not press the deploy button again to update an installation you want to keep.
Migrate the existing installation repository to the thin template instead:

1. Back up the existing D1 and record the current Worker name, database binding/ID,
   build settings, and runtime variables. Keep the existing secrets in Cloudflare.
2. Replace the application source/build files with the template in a review branch.
   Preserve deployment-specific configuration while adopting the template's main,
   assets.directory, and DB.migrations_dir paths. Keep DB bound to the existing ID.
3. Check that the installation's historical SQL migrations match the packaged
   migration history. The current invitation feature's migration names and contents
   are preserved by this release builder. Custom schema changes need separate review.
4. Use `pnpm install --frozen-lockfile`, `pnpm run build`, and
   `pnpm run deploy:dry-run`. Confirm the prepared version and resource identities.
5. Set Workers Builds to build with `pnpm run build` and deploy with
   `pnpm run deploy`, then deploy to that same Worker/database.

No migration of an existing private snapshot repository is performed by adding
this feature to upstream. That transition needs its own review against the actual
installation configuration.

## Migration and rollback boundaries

Existing SQL files are immutable. New product schema changes require new migration
files. The publisher prevents changing/removing any migration from the previous
latest package. Applications must remain compatible across the migration/deploy
window: prefer additive migrations and staged changes. Migrations can succeed
before a Worker deployment fails, so deployment is not a cross-resource transaction.
A previous Worker version alone cannot undo a database change.

The integration test uses the actual current product twice and adds a synthetic
migration only to the second test artifact. It proves packaging, asset delivery,
local migration persistence, and retained account/session/token/invitation behavior.
It does not prove every future schema change safe. Remote Cloudflare provisioning,
release permissions/settings, and the first live template upgrade remain rollout
checks; they are not silently claimed by local tests.

## Reproduce locally

```sh
pnpm install --frozen-lockfile
pnpm --dir templates/cloudflare install --frozen-lockfile
pnpm run check
pnpm run test:release
pnpm exec playwright install chromium
pnpm run test:distribution
pnpm run release:build /tmp/lead-desk-release-output 0.1.0-local.1
```

Use a new output directory. The distribution test prints its evidence path and
leaves results, logs, the isolated consumer, package artifacts and screenshots.
It uses random local-only credentials and never deploys remote resources.

## Live release API diagnostic

The manual CI input `release_api_smoke=true` runs normal verification and then
uses the workflow's own `GITHUB_TOKEN` to create a disposable draft, upload and
check both package assets, verify non-overwriting resume, and remove that draft.
It never publishes the draft or advances latest. Selecting this input also
suppresses the normal publishing job, including on main.

```sh
gh workflow run ci.yml --ref <review-branch> -f release_api_smoke=true
```

This explicitly exercises GitHub API behavior that mocked tests cannot prove.
The creation request's JSON response supplies the numeric release ID; no immediate
listing/tag rediscovery is required. Subsequent state checks and asset operations
address that ID. An interrupted diagnostic may leave a draft named
`release-api-smoke-<run-id>-<attempt>`; inspect it before cleanup. The diagnostic
only removes the draft it created and only while its ID/tag still identify a draft.
