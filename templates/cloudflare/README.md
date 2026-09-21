# My Lead Desk installation

This repository owns your Cloudflare deployment configuration. The CRM itself is
installed from a packaged GitHub Release when you run the build command.

## First deployment

The Deploy to Cloudflare flow provisions your Worker and D1 and prompts for
`BETTER_AUTH_SECRET` and `SETUP_TOKEN`. Keep the generated database ID, Worker
name and both secrets across updates. Configure Workers Builds with:

- **Build command:** `pnpm run build`
- **Deploy command:** `pnpm run deploy`
- **Node:** 24.20.0 or later within Node 24
- **pnpm:** 10.34.5 (also pinned in `package.json`)

The build resolves the latest published Lead Desk release, verifies its SHA-256,
installs its bundled Worker/UI/migrations, and records the exact version, source
commit, and digest in `.lead-desk/current/installation.json`. The deploy command
checks build readiness, applies pending D1 migrations using the `DB` binding, and
deploys to the existing Worker.

At least one Lead Desk package release must exist upstream before this template
can build. If there is no release yet, the build fails; it does not silently
install repository source or an older cached package.

## Update

Trigger a new **build and deploy** in Cloudflare Workers Builds. The unchanged
`"release": "latest"` setting in `lead-desk.json` resolves again on every build.
No application-source sync or automated commits to this repository are needed.
The updater never edits your tracked package manifest, tooling lockfile, Wrangler
configuration, or secrets. All downloaded application files are under ignored
`.lead-desk/`.

Reactivating an existing Cloudflare Worker version is different: it uses the
already-uploaded code and does not run this updater. Upstream commits become
available only once upstream CI publishes their package release. Following latest
means you opt into successful main builds, including their database migrations.

For a local deployment:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run deploy
```

Cloudflare performs dependency installation before its configured build command.
`pnpm run deploy` deliberately does not resolve latest a second time: it deploys
exactly what the successful build prepared.

## Pin a release

Change `release` in `lead-desk.json` to an exact upstream tag:

```json
{
  "release": "build-<full-40-character-source-commit>",
  "repository": "ivanbrykov/cloudflare-lead-desk"
}
```

Use an actual tag from the upstream Releases page, replacing the placeholder.
`LEAD_DESK_RELEASE` is an optional build-environment override for the same setting.
Switch back to `latest` to follow updates. The public upstream needs no GitHub
credential. If API rate limits require one, `LEAD_DESK_GITHUB_TOKEN` is an optional
**build-only** token used for the GitHub API, never for redirected asset downloads.

A pinned version makes subsequent builds repeat that version. Pinning an older
release is not a database rollback. Database migrations are forward-only; restore
from a database backup or use an explicitly compatible corrective release when
recovering from a bad migration.

## Local development and checks

```sh
pnpm install --frozen-lockfile
pnpm run build
cp .dev.vars.example .dev.vars
# Fill .dev.vars with fresh local-only values; do not commit it.
pnpm run db:migrate:local
pnpm exec wrangler dev --local --local-protocol https
```

The template runs production auth behavior, so local authentication also needs an
HTTPS origin. A local self-signed certificate may require browser acknowledgement.
`pnpm run deploy:dry-run` validates packaging without deploying.

## Failed builds and compatibility changes

A failed release lookup, download, checksum check, install, or compatibility check
fails the build and invalidates deploy readiness. It never falls back to cached
code. Retry the build once the underlying problem is resolved.

The updater refuses rewritten/removed migrations when an existing generated
installation is available. Upstream publishing also compares migration hashes
against the previous latest release, covering fresh Cloudflare build checkouts.
If a release needs a newer compatibility date or additional flags, the build asks
you to review and update `wrangler.jsonc` explicitly. New resource bindings or
changes to these installer scripts may likewise require a template update; package
updates do not rewrite installation-owned files.

`.lead-desk/.lock` prevents concurrent updates. If a build process was killed and
left it behind, first confirm no updater is running, then remove that lock
directory and rebuild. Do not edit `.lead-desk/current` manually.
