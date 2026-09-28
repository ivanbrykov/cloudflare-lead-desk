CREATE TABLE `__activities_keep` AS SELECT * FROM `activities`;--> statement-breakpoint
DELETE FROM `activities`;--> statement-breakpoint
CREATE TABLE `__new_leads` (
	`created_at` integer NOT NULL,
	`custom_fields` text DEFAULT '{}' NOT NULL,
	`deleted_at` integer,
	`email` text,
	`estimated_value` integer,
	`first_name` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_name` text,
	`name` text NOT NULL,
	`normalized_email` text,
	`origin` text,
	`public_key_id` text,
	`source` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_leads`("created_at", "custom_fields", "deleted_at", "email", "estimated_value", "first_name", "id", "last_name", "name", "normalized_email", "origin", "public_key_id", "source", "updated_at", "workspace_id") SELECT "created_at", "custom_fields", "deleted_at", "email", "estimated_value", "first_name", "id", "last_name", "name", "normalized_email", "origin", "public_key_id", "source", "updated_at", "workspace_id" FROM `leads`;--> statement-breakpoint
DROP TABLE `leads`;--> statement-breakpoint
ALTER TABLE `__new_leads` RENAME TO `leads`;--> statement-breakpoint
CREATE INDEX `leads_normalized_email_idx` ON `leads` (`workspace_id`,`normalized_email`);--> statement-breakpoint
CREATE INDEX `leads_workspace_created_idx` ON `leads` (`workspace_id`,`created_at`);--> statement-breakpoint
INSERT INTO `activities` ("actor_email", "body", "created_at", "id", "kind", "lead_id", "metadata", "workspace_id") SELECT "actor_email", "body", "created_at", "id", "kind", "lead_id", "metadata", "workspace_id" FROM `__activities_keep`;--> statement-breakpoint
DROP TABLE `__activities_keep`;--> statement-breakpoint
DROP TABLE `pipelines`;
