DROP INDEX `pipelines_workspace_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_workspace_active_name_unique` ON `pipelines` (`workspace_id`,`name`) WHERE archived_at IS NULL;