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

1. Choose the permanent HTTPS origin for this service, such as its `workers.dev`
   URL or a custom domain. Set `PUBLIC_ORIGIN` in `wrangler.jsonc` to that exact
   origin, with no path or trailing slash. Deploying this Worker requires an
   authenticated Cloudflare account; a dry-run does not create a resource.
2. Register a **public GitHub App** owned by the Lead Desk maintainer. Use
   `${PUBLIC_ORIGIN}/callback` as its exact OAuth callback and
   `${PUBLIC_ORIGIN}/upgrade` as its setup URL. Keep OAuth user authorization
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
4. Set `GITHUB_CLIENT_ID` and `GITHUB_APP_SLUG` as Worker vars. Add Worker secrets
   `GITHUB_APP_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (downloaded
   PEM), and `SESSION_SECRET` (at least 32 random characters). Do not put these
   in a committed `.dev.vars` or Wrangler vars. Set upstream Actions secrets
   `LEAD_DESK_UPGRADE_APP_ID` and `LEAD_DESK_UPGRADE_APP_PRIVATE_KEY` to the same
   App identity/key. Rotate the private key if it leaks.
5. Deploy the Worker, test its `/upgrade` sign-in and App installation on an
   approved disposable repository, and only then put the actual service URL into
   the copied template README's Upgrade button. A placeholder URL must never be
   advertised as a live button.

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
