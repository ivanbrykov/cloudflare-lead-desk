# ADR 0002: Application boundaries

Elysia owns the REST/OpenAPI transport. Effect Schema is the sole runtime validation and decoding model. Effect command modules own business rules and typed errors. Drizzle/D1 repositories own persistence details.

The React SPA uses Wouter for navigation and React Query for server state. Better Auth (D1-backed sessions) verifies staff identity at the Worker boundary; registration is invitation-only (a bootstrap `SETUP_TOKEN` for the first account and single-use staff invites thereafter), and a disabled account's sessions are revoked durably. Alpha has no separate in-app role system.
