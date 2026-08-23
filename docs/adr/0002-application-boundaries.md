# ADR 0002: Application boundaries

Elysia owns the REST/OpenAPI transport. Effect Schema is the sole runtime validation and decoding model. Effect command modules own business rules and typed errors. Drizzle/D1 repositories own persistence details.

The React SPA uses Wouter for navigation and React Query for server state. Cloudflare Access verifies staff identity at the Worker boundary; alpha has no separate in-app role system.
