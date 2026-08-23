CREATE TABLE `activities` (
	`actor_email` text,
	`body` text NOT NULL,
	`contact_id` text NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`opportunity_id` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activities_contact_created_idx` ON `activities` (`contact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activities_opportunity_created_idx` ON `activities` (`opportunity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` text,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` text,
	`scope` text DEFAULT 'intake:write' NOT NULL,
	`token_hash` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_workspace_idx` ON `api_tokens` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`created_at` text NOT NULL,
	`email` text,
	`first_name` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_name` text,
	`normalized_email` text,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contacts_workspace_created_idx` ON `contacts` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_workspace_email_unique` ON `contacts` (`workspace_id`,`normalized_email`);--> statement-breakpoint
CREATE TABLE `custom_field_definitions` (
	`archived_at` text,
	`created_at` text NOT NULL,
	`entity_type` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`type` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `field_definitions_workspace_entity_idx` ON `custom_field_definitions` (`workspace_id`,`entity_type`,`archived_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `field_definitions_workspace_entity_key_unique` ON `custom_field_definitions` (`workspace_id`,`entity_type`,`key`);--> statement-breakpoint
CREATE TABLE `custom_field_values` (
	`created_at` text NOT NULL,
	`entity_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`field_definition_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`updated_at` text NOT NULL,
	`value_boolean` integer,
	`value_date` text,
	`value_number` integer,
	`value_text` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`field_definition_id`) REFERENCES `custom_field_definitions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `field_values_entity_idx` ON `custom_field_values` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `field_values_entity_definition_unique` ON `custom_field_values` (`entity_type`,`entity_id`,`field_definition_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`created_at` text NOT NULL,
	`key` text NOT NULL,
	`response_json` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_workspace_key_unique` ON `idempotency_keys` (`workspace_id`,`key`);--> statement-breakpoint
CREATE TABLE `opportunities` (
	`created_at` text NOT NULL,
	`estimated_value` integer,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pipeline_id` text NOT NULL,
	`primary_contact_id` text NOT NULL,
	`source` text NOT NULL,
	`stage_id` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`primary_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stage_id`) REFERENCES `stages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `opportunities_workspace_stage_idx` ON `opportunities` (`workspace_id`,`stage_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `opportunities_contact_idx` ON `opportunities` (`primary_contact_id`);--> statement-breakpoint
CREATE TABLE `pipelines` (
	`id` text PRIMARY KEY NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`name` text NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_workspace_name_unique` ON `pipelines` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `stages` (
	`color` text DEFAULT 'slate' NOT NULL,
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pipeline_id` text NOT NULL,
	`position` integer NOT NULL,
	`updated_at` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stages_pipeline_position_idx` ON `stages` (`pipeline_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `stages_pipeline_name_unique` ON `stages` (`pipeline_id`,`name`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);