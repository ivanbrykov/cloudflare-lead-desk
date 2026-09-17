CREATE TABLE `bootstrap_state` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	CONSTRAINT "bootstrap_state_default_only" CHECK(id = 'default')
);
--> statement-breakpoint
CREATE TABLE `staff_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text,
	`used_by_user_id` text,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_invites_token_hash_unique` ON `staff_invites` (`token_hash`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `expires_at` text;--> statement-breakpoint
ALTER TABLE `user` ADD `disabled_at` integer;
--> statement-breakpoint
-- Seed the bootstrap invite state exactly once. INSERT OR IGNORE keeps reruns
-- from refreshing timestamps or reopening a consumed row; consumed_at is set
-- only if at least one user already exists at migration time.
INSERT OR IGNORE INTO bootstrap_state (id, created_at, expires_at, consumed_at) SELECT 'default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days'), (CASE WHEN (SELECT COUNT(*) FROM user) > 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END);