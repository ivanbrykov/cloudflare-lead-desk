# Lead Desk installation

This is an installation repository, not the upstream CRM source.

- Preserve the existing Worker name, D1 binding/ID, and authentication secrets.
- Product code arrives through `pnpm run build`; do not copy upstream src/ here.
- `lead-desk.json` records a full upstream source commit. Ordinary builds do not
  resolve a moving branch; only the centrally hosted manual Upgrade workflow
  changes the pin after the installation owner authorizes the GitHub App.
- Never commit `.lead-desk`, `.wrangler`, `.dev.vars`, or credentials.
- Build before deploying. Deploy uses the prepared version and applies pending
  migrations to the existing DB; it must not provision a replacement database.
- Use the pinned Node/pnpm tooling and review upstream migration/release notes.
- The updater may commit only `lead-desk.json`, without force-pushing or adding a
  Cloudflare credential. Candidate code must stay on a read-only runner isolated
  from the fresh trusted write job. A source pin is not a database rollback.
