CREATE TABLE `leads` (
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
	`pipeline_id` text NOT NULL,
	`public_key_id` text,
	`source` text NOT NULL,
	`stage_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stage_id`) REFERENCES `stages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `leads_normalized_email_idx` ON `leads` (`workspace_id`,`normalized_email`);--> statement-breakpoint
CREATE INDEX `leads_pipeline_created_idx` ON `leads` (`workspace_id`,`pipeline_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `leads_stage_idx` ON `leads` (`workspace_id`,`stage_id`);--> statement-breakpoint
ALTER TABLE `activities` ADD `lead_id` text REFERENCES leads(id);--> statement-breakpoint
CREATE INDEX `activities_lead_created_idx` ON `activities` (`lead_id`,`created_at`);