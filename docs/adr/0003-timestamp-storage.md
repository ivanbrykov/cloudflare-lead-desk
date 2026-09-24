# ADR 0003: Timestamp storage

App-owned timestamps are stored as Unix milliseconds
(`integer(..., { mode: 'timestamp_ms' })`) and read back as `Date` values in
server code. The wire format is unchanged: API responses serialize `Date` to
ISO-8601 JSON strings, the contact keyset cursor keeps its ISO-8601 payload,
and expiry overrides (`expiresAt`) remain ISO-8601 strings at the request edge.

This matches the Better Auth tables (`user`, `session`, `account`), which
already use `timestamp_ms`, and removes the previous split where auth rows
were integer milliseconds and app rows were ISO-8601 `text`. Migration 0007
converts existing rows with `unixepoch(..., 'subsec') * 1000`, preserving
millisecond precision, including `NULL` timestamps.

SQLite cannot change a column type in place, so the migration rebuilds each
affected table. D1 always enforces foreign keys and runs a migration in one
implicit transaction, and a deferred foreign key violation raised by dropping
a referenced table is not cleared by recreating the same table name later in
the transaction; drizzle-kit's generated drop/rename order therefore fails on
D1. The migration instead renames each table to `__old_*` so foreign keys
follow the rename, creates the replacements parents-before-children, copies
rows parents-before-children, drops the originals children-before-parents, and
recreates the named indexes plus the `registration_claims_grant_guard` trigger.
`PRAGMA defer_foreign_keys = on` documents the D1 migration contract but the
statement order is constraint-safe on its own.