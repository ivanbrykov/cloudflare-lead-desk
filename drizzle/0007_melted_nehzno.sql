-- Convert every app-owned timestamp column from ISO-8601 text to Unix
-- milliseconds (the Better Auth convention, `timestamp_ms`). SQLite cannot
-- change a column type in place, so each table is rebuilt. The rebuild is
-- ordered to be constraint-safe under D1's always-on foreign keys:
--   1. rename each table to __old_* (existing FKs follow the rename);
--   2. create the replacements, parents before children;
--   3. copy rows with unixepoch() conversion, parents before children;
--   4. drop the __old_* tables, children before parents;
--   5. recreate named indexes and the registration grant-guard trigger.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
-- 1. Rename the existing tables.
ALTER TABLE `workspaces` RENAME TO `__old_workspaces`;--> statement-breakpoint
ALTER TABLE `contacts` RENAME TO `__old_contacts`;--> statement-breakpoint
ALTER TABLE `pipelines` RENAME TO `__old_pipelines`;--> statement-breakpoint
ALTER TABLE `stages` RENAME TO `__old_stages`;--> statement-breakpoint
ALTER TABLE `custom_field_definitions` RENAME TO `__old_custom_field_definitions`;--> statement-breakpoint
ALTER TABLE `custom_field_values` RENAME TO `__old_custom_field_values`;--> statement-breakpoint
ALTER TABLE `opportunities` RENAME TO `__old_opportunities`;--> statement-breakpoint
ALTER TABLE `activities` RENAME TO `__old_activities`;--> statement-breakpoint
ALTER TABLE `api_tokens` RENAME TO `__old_api_tokens`;--> statement-breakpoint
ALTER TABLE `idempotency_keys` RENAME TO `__old_idempotency_keys`;--> statement-breakpoint
ALTER TABLE `bootstrap_state` RENAME TO `__old_bootstrap_state`;--> statement-breakpoint
ALTER TABLE `registration_claims` RENAME TO `__old_registration_claims`;--> statement-breakpoint
ALTER TABLE `staff_invites` RENAME TO `__old_staff_invites`;--> statement-breakpoint
-- 2. Create the millisecond-schema replacements.
CREATE TABLE `workspaces` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `contacts` (
	`created_at` integer NOT NULL,
	`email` text,
	`first_name` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_name` text,
	`normalized_email` text,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `pipelines` (
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `stages` (
	`color` text DEFAULT 'slate' NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pipeline_id` text NOT NULL,
	`position` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `custom_field_definitions` (
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`entity_type` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`type` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `custom_field_values` (
	`created_at` integer NOT NULL,
	`entity_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`field_definition_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`value_boolean` integer,
	`value_date` text,
	`value_number` integer,
	`value_text` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`field_definition_id`) REFERENCES `custom_field_definitions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `opportunities` (
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`estimated_value` integer,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pipeline_id` text NOT NULL,
	`primary_contact_id` text NOT NULL,
	`source` text NOT NULL,
	`stage_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`primary_contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stage_id`) REFERENCES `stages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `activities` (
	`actor_email` text,
	`body` text NOT NULL,
	`contact_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`opportunity_id` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` integer,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` integer,
	`scope` text DEFAULT 'intake:write' NOT NULL,
	`token_hash` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`created_at` integer NOT NULL,
	`key` text NOT NULL,
	`request_hash` text,
	`response_json` text NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `bootstrap_state` (
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	CONSTRAINT "bootstrap_state_default_only" CHECK(id = 'default')
);--> statement-breakpoint
CREATE TABLE `registration_claims` (
	`claim_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`grant_kind` text NOT NULL,
	`grant_ref` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `staff_invites` (
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` integer,
	`token_hash` text NOT NULL,
	`used_at` integer,
	`used_by_user_id` text,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
-- 3. Copy every row, converting ISO-8601 text to Unix milliseconds.
INSERT INTO `workspaces` ("created_at", "id", "name", "slug", "updated_at") SELECT CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), "id", "name", "slug", CAST(unixepoch("updated_at", 'subsec') * 1000 AS INTEGER) FROM `__old_workspaces`;--> statement-breakpoint
INSERT INTO `contacts` ("created_at", "email", "first_name", "id", "last_name", "normalized_email", "updated_at", "workspace_id") SELECT CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), "email", "first_name", "id", "last_name", "normalized_email", CAST(unixepoch("updated_at", 'subsec') * 1000 AS INTEGER), "workspace_id" FROM `__old_contacts`;--> statement-breakpoint
INSERT INTO `pipelines` ("archived_at", "created_at", "id", "name", "updated_at", "workspace_id") SELECT CAST(unixepoch("archived_at", 'subsec') * 1000 AS INTEGER), CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), "id", "name", CAST(unixepoch("updated_at", 'subsec') * 1000 AS INTEGER), "workspace_id" FROM `__old_pipelines`;--> statement-breakpoint
INSERT INTO `stages` ("color", "created_at", "id", "name", "pipeline_id", "position", "updated_at", "workspace_id") SELECT "color", CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), "id", "name", "pipeline_id", "position", CAST(unixepoch("updated_at", 'subsec') * 1000 AS INTEGER), "workspace_id" FROM `__old_stages`;--> statement-breakpoint
INSERT INTO `custom_field_definitions` ("archived_at", "created_at", "entity_type", "id", "key", "label", "options", "required", "type", "updated_at", "workspace_id") SELECT CAST(unixepoch("archived_at", 'subsec') * 1000 AS INTEGER), CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), "entity_type", "id", "key", "label", "options", "required", "type", CAST(unixepoch("updated_at", 'subsec') * 1000 AS INTEGER), "workspace_id" FROM `__old_custom_field_definitions`;--> statement-breakpoint
INSERT INTO `custom_field_values` ("created_at", "entity_id", "entity_type", "field_definition_id", "id", "updated_at", "value_boolean", "value_date", "value_number", "value_text", "workspace_id") SELECT CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), "entity_id", "entity_type", "field_definition_id", "id", CAST(unixepoch("updated_at", 'subsec') * 1000 AS INTEGER), "value_boolean", "value_date", "value_number", "value_text", "workspace_id" FROM `__old_custom_field_values`;--> statement-breakpoint
INSERT INTO `opportunities` ("created_at", "deleted_at", "estimated_value", "id", "name", "pipeline_id", "primary_contact_id", "source", "stage_id", "updated_at", "workspace_id") SELECT CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), CAST(unixepoch("deleted_at", 'subsec') * 1000 AS INTEGER), "estimated_value", "id", "name", "pipeline_id", "primary_contact_id", "source", "stage_id", CAST(unixepoch("updated_at", 'subsec') * 1000 AS INTEGER), "workspace_id" FROM `__old_opportunities`;--> statement-breakpoint
INSERT INTO `activities` ("actor_email", "body", "contact_id", "created_at", "id", "kind", "metadata", "opportunity_id", "workspace_id") SELECT "actor_email", "body", "contact_id", CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), "id", "kind", "metadata", "opportunity_id", "workspace_id" FROM `__old_activities`;--> statement-breakpoint
INSERT INTO `api_tokens` ("created_at", "expires_at", "id", "last_used_at", "name", "prefix", "revoked_at", "scope", "token_hash", "workspace_id") SELECT CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), CAST(unixepoch("expires_at", 'subsec') * 1000 AS INTEGER), "id", CAST(unixepoch("last_used_at", 'subsec') * 1000 AS INTEGER), "name", "prefix", CAST(unixepoch("revoked_at", 'subsec') * 1000 AS INTEGER), "scope", "token_hash", "workspace_id" FROM `__old_api_tokens`;--> statement-breakpoint
INSERT INTO `idempotency_keys` ("created_at", "key", "request_hash", "response_json", "workspace_id") SELECT CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), "key", "request_hash", "response_json", "workspace_id" FROM `__old_idempotency_keys`;--> statement-breakpoint
INSERT INTO `bootstrap_state` ("consumed_at", "created_at", "expires_at", "id") SELECT CAST(unixepoch("consumed_at", 'subsec') * 1000 AS INTEGER), CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), CAST(unixepoch("expires_at", 'subsec') * 1000 AS INTEGER), "id" FROM `__old_bootstrap_state`;--> statement-breakpoint
INSERT INTO `registration_claims` ("claim_key", "created_at", "grant_kind", "grant_ref", "id", "user_id") SELECT "claim_key", CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), "grant_kind", "grant_ref", "id", "user_id" FROM `__old_registration_claims`;--> statement-breakpoint
INSERT INTO `staff_invites` ("created_at", "expires_at", "id", "name", "prefix", "revoked_at", "token_hash", "used_at", "used_by_user_id") SELECT CAST(unixepoch("created_at", 'subsec') * 1000 AS INTEGER), CAST(unixepoch("expires_at", 'subsec') * 1000 AS INTEGER), "id", "name", "prefix", CAST(unixepoch("revoked_at", 'subsec') * 1000 AS INTEGER), "token_hash", CAST(unixepoch("used_at", 'subsec') * 1000 AS INTEGER), "used_by_user_id" FROM `__old_staff_invites`;--> statement-breakpoint
-- 4. Drop the originals, children before parents.
DROP TABLE `__old_registration_claims`;--> statement-breakpoint
DROP TABLE `__old_staff_invites`;--> statement-breakpoint
DROP TABLE `__old_bootstrap_state`;--> statement-breakpoint
DROP TABLE `__old_idempotency_keys`;--> statement-breakpoint
DROP TABLE `__old_api_tokens`;--> statement-breakpoint
DROP TABLE `__old_activities`;--> statement-breakpoint
DROP TABLE `__old_custom_field_values`;--> statement-breakpoint
DROP TABLE `__old_opportunities`;--> statement-breakpoint
DROP TABLE `__old_stages`;--> statement-breakpoint
DROP TABLE `__old_pipelines`;--> statement-breakpoint
DROP TABLE `__old_custom_field_definitions`;--> statement-breakpoint
DROP TABLE `__old_contacts`;--> statement-breakpoint
DROP TABLE `__old_workspaces`;--> statement-breakpoint
-- 5. Recreate named indexes and the grant-guard trigger.
CREATE INDEX `activities_contact_created_idx` ON `activities` (`contact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activities_opportunity_created_idx` ON `activities` (`opportunity_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_workspace_idx` ON `api_tokens` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `contacts_workspace_created_idx` ON `contacts` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_workspace_email_unique` ON `contacts` (`workspace_id`,`normalized_email`);--> statement-breakpoint
CREATE INDEX `field_definitions_workspace_entity_idx` ON `custom_field_definitions` (`workspace_id`,`entity_type`,`archived_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `field_definitions_workspace_entity_key_unique` ON `custom_field_definitions` (`workspace_id`,`entity_type`,`key`);--> statement-breakpoint
CREATE INDEX `field_values_entity_idx` ON `custom_field_values` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `field_values_entity_definition_unique` ON `custom_field_values` (`entity_type`,`entity_id`,`field_definition_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_workspace_key_unique` ON `idempotency_keys` (`workspace_id`,`key`);--> statement-breakpoint
CREATE INDEX `opportunities_workspace_stage_idx` ON `opportunities` (`workspace_id`,`stage_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `opportunities_contact_idx` ON `opportunities` (`primary_contact_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pipelines_workspace_name_unique` ON `pipelines` (`workspace_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `registration_claims_claim_key_unique` ON `registration_claims` (`claim_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `staff_invites_token_hash_unique` ON `staff_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `stages_pipeline_position_idx` ON `stages` (`pipeline_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `stages_pipeline_position_unique` ON `stages` (`pipeline_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `stages_pipeline_name_unique` ON `stages` (`pipeline_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
CREATE TRIGGER `registration_claims_grant_guard` BEFORE INSERT ON `registration_claims`
WHEN (NEW.grant_kind = 'bootstrap'
      AND NOT EXISTS (SELECT 1 FROM bootstrap_state WHERE id = 'default' AND consumed_at IS NULL AND expires_at > NEW.created_at))
  OR (NEW.grant_kind = 'invite'
      AND NOT EXISTS (SELECT 1 FROM staff_invites WHERE token_hash = NEW.grant_ref AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NEW.created_at))
BEGIN
  SELECT RAISE(ABORT, 'registration grant unavailable');
END;
