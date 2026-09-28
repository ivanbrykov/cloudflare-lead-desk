PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_tokens` (
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` integer,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` integer,
	`scope` text DEFAULT 'intake:write' NOT NULL,
	`token` text,
	`token_hash` text,
	`type` text DEFAULT 'api' NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_api_tokens`("created_at", "expires_at", "id", "last_used_at", "name", "prefix", "revoked_at", "scope", "token", "token_hash", "type", "workspace_id") SELECT "created_at", "expires_at", "id", "last_used_at", "name", "prefix", "revoked_at", "scope", "token", "token_hash", CASE "type" WHEN 'private' THEN 'api' WHEN 'public' THEN 'browser' ELSE "type" END, "workspace_id" FROM `api_tokens`;--> statement-breakpoint
DROP TABLE `api_tokens`;--> statement-breakpoint
ALTER TABLE `__new_api_tokens` RENAME TO `api_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_unique` ON `api_tokens` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_workspace_idx` ON `api_tokens` (`workspace_id`);