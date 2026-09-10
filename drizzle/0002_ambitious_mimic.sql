-- Bootstrap the default workspace, pipeline, and stage as part of schema
-- migration instead of per-request seeding. Fixed ids keep existing
-- references (opportunities, intake defaults) stable.
INSERT OR IGNORE INTO workspaces (id, slug, name, created_at, updated_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'default', 'Lead Desk', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');--> statement-breakpoint
INSERT OR IGNORE INTO pipelines (id, workspace_id, name, created_at, updated_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAW', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'Sales', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');--> statement-breakpoint
INSERT OR IGNORE INTO stages (id, workspace_id, pipeline_id, name, color, position, created_at, updated_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAX', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '01ARZ3NDEKTSV4RRFFQ69G5FAW', 'New inquiry', 'blue', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');--> statement-breakpoint
-- Renumber every stage into one deterministic sequence ordered by
-- (created_at, id), so duplicate (pipeline_id, position) rows — which were
-- possible before the unique index existed — are resolved with a stable,
-- idempotent order before uniqueness is enforced.
UPDATE stages SET position = (SELECT COUNT(*) - 1 FROM stages AS earlier WHERE earlier.created_at < stages.created_at OR (earlier.created_at = stages.created_at AND earlier.id <= stages.id));--> statement-breakpoint
CREATE UNIQUE INDEX `stages_pipeline_position_unique` ON `stages` (`pipeline_id`,`position`);
