# LeadScroll installation

This is an installation repository, not the upstream CRM source.

- Preserve the existing Worker name, D1 binding/ID, and authentication secrets.
- Product code arrives through `pnpm run build`; do not copy upstream src/ here.
- `leadscroll.json` ships with the `main` channel. Each build resolves it in
  an ephemeral checkout and does not commit the resolved SHA back, so while the
  repository records `main` a later build can select newer upstream code and its
  migrations. Commit a full SHA or run Upgrade once to lock the installation;
  only the owner deliberately advances the pin after backing up D1 and
  reviewing migration history.
- Never commit `.leadscroll`, `.wrangler`, `.dev.vars`, or credentials.
- Build before deploying. Deploy uses the prepared version and applies pending
  migrations to the existing DB; it must not provision a replacement database.
- Use the pinned Node/pnpm tooling and review upstream migration/release notes.
- Commit only `leadscroll.json` for a source-pin upgrade. Do not force-push,
  add a Cloudflare credential, or treat an older pin as a database rollback.
