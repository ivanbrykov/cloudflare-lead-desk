# Lead Desk installation

This is an installation repository, not the upstream CRM source.

- Preserve the existing Worker name, D1 binding/ID, and authentication secrets.
- Product code arrives through `pnpm run build`; do not copy upstream src/ here.
- `lead-desk.json` records a full upstream source commit. Ordinary builds do not
  resolve a moving branch; only the installation owner deliberately changes
  the pin after backing up D1 and reviewing migration history.
- Never commit `.lead-desk`, `.wrangler`, `.dev.vars`, or credentials.
- Build before deploying. Deploy uses the prepared version and applies pending
  migrations to the existing DB; it must not provision a replacement database.
- Use the pinned Node/pnpm tooling and review upstream migration/release notes.
- Commit only `lead-desk.json` for a source-pin upgrade. Do not force-push,
  add a Cloudflare credential, or treat an older pin as a database rollback.
