# Contributing

Thanks for improving Cloudflare Lead Desk.

1. Read the architecture decisions in `docs/adr`.
2. Keep HTTP contracts in Effect Schema; do not add a second validator.
3. Keep Drizzle inside D1 repositories and business rules in Effect commands.
4. Add tests for changed behavior and run `pnpm run check` before opening a pull request.
5. Never edit or delete an applied migration; add a new migration on top. D1 records applied migrations by filename, so a rewritten file silently diverges from every database that already ran it. The release/upgrade path verifies append-only history with migration digests.
6. Do not copy code, product copy, UI assets, or screenshots from Attio, HubSpot, Twenty, or other products used as references.

Report security issues privately as described in [SECURITY.md](SECURITY.md).
