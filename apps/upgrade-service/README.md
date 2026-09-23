# Lead Desk central Upgrade service

This small Cloudflare Worker is the public endpoint for the **Upgrade Lead Desk**
button in a copied installation. It does not deploy consumer Workers or hold
consumer Cloudflare credentials. It signs a GitHub user in, checks that the user
can write the selected installation and that the GitHub App is installed there,
then dispatches the trusted `cloudflare-upgrade.yml` workflow in the upstream
Lead Desk repository. The workflow validates an exact upstream commit and makes
one pin-only commit in the installation. Ordinary Cloudflare rebuilds remain
pinned.

## Activate after review

1. The initial public origin is fixed to
   `https://lead-desk-upgrade.ivbr.workers.dev` in `wrangler.jsonc`, using the
   maintainer account's existing `ivbr.workers.dev` subdomain and Worker name
   `lead-desk-upgrade`. An initial Worker was created on 2026-09-23 with only
   public App bindings; `/upgrade` currently returns a sanitized HTTP 400 because
   its private credentials are absent. This is **not an operational Upgrade
   service**. A custom domain can
   replace this later, but would require updating the GitHub App callback and
   the copied README button together.
2. Register a **public GitHub App** owned by the Lead Desk maintainer. Use
   `https://lead-desk-upgrade.ivbr.workers.dev/callback` as its exact OAuth
   callback and `https://lead-desk-upgrade.ivbr.workers.dev/upgrade` as its setup
   URL. Keep OAuth user authorization
   enabled and expiring; disable webhook delivery (no webhook is used). Request
   repository permissions **Metadata: read**, **Contents: read and write**, and
   **Actions: read and write**. No organization or account permissions are
   needed. Do not request OAuth authorization during installation if using the
   setup URL; the service starts the authorization flow after setup.
3. Install the App on the upstream `ivanbrykov/cloudflare-lead-desk` repository
   for workflow dispatch. Each installation owner will separately install it on
   only their copied Lead Desk repository. GitHub displays the App's permissions
   during that one-time authorization. The App can have broad declared
   permissions, but each workflow access token is narrowed to one repository and
   either read-only contents, contents write, or upstream Actions write.
4. App ID `5040911`, Client ID `Iv23ligUWrUXVh2xZuEh`, and public slug
   `lead-desk-upgrade` are already recorded as Worker vars. The App identity,
   owner, and Metadata-read/Contents-write/Actions-write permissions were
   verified through GitHub's public App API.
   `SESSION_SECRET` was generated with a cryptographically secure random source
   and installed as a Worker secret on 2026-09-23. Add the remaining Worker
   secrets `GITHUB_CLIENT_SECRET` and `GITHUB_APP_PRIVATE_KEY` (the complete
   downloaded PEM). Do not put these in a committed `.dev.vars` or Wrangler
   vars. Upstream Actions secret `LEAD_DESK_UPGRADE_APP_ID` is already set to
   `5040911`; add `LEAD_DESK_UPGRADE_APP_PRIVATE_KEY` with the same complete
   PEM. Rotate the private key if it leaks. Never paste either secret into chat.
5. The `lead-desk-upgrade` Worker now exists in the maintainer Cloudflare
   account. After the reviewed source reaches upstream `main`, connect it to
   that GitHub repository's `main` branch as
   a **separate Workers Builds project**. Set root directory to
   `apps/upgrade-service`, build command to `pnpm install --frozen-lockfile`,
   and deploy command to `pnpm run deploy`. Optionally include only
   `apps/upgrade-service/*` in build watch paths, so CRM-only commits do not
   redeploy this Worker. GitHub App secrets belong in the Worker's runtime
   settings, not build logs or this repository. This is one shared deployment;
   customer Lead Desk builds remain independent.
6. Test `/upgrade` sign-in and App installation on an approved disposable
   repository, and only then replace the copied template README's pending badge
   with a link to this origin. A selected hostname alone must never be
   advertised as a live Upgrade button.

GitHub only dispatches a `workflow_dispatch` workflow after its YAML exists on
the upstream default branch. Therefore, after security review and explicit
merge approval, first merge the central workflow **with the Upgrade badge still
inactive**. Then complete the disposable live test and activate the badge in a
follow-up change. The draft PR must not be described as end-to-end verified.

The App user OAuth code is protected by PKCE and an encrypted state cookie. The
short-lived session cookie is encrypted, HttpOnly, Secure and SameSite=Lax; the
POST also requires a CSRF token and same-origin request. The service never accepts
a repository name as authorization by itself: GitHub user identity, collaborator
permission, App installation/repository scope, and `lead-desk.json` are checked
before dispatch. The workflow rechecks identity, pin, and default-branch state.

## Checks

From the upstream worktree:

```sh
pnpm --dir apps/upgrade-service install --frozen-lockfile
pnpm --dir apps/upgrade-service run check
pnpm run test:central-upgrade
```

`check` runs local tests and a Wrangler deployment dry-run; it neither deploys
the service nor proves live GitHub OAuth/App behavior. The live gates are App
authorization and dispatch, exact pin commit after validation, and the
installation's Cloudflare build on that App-authored push while Worker/D1 identity
and stored records remain unchanged. Do not claim these from mocks.
