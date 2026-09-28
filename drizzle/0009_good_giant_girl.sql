PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_activities` (
	`actor_email` text,
	`body` text NOT NULL,
	`contact_id` text,
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`lead_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`opportunity_id` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_activities`("actor_email", "body", "contact_id", "created_at", "id", "kind", "lead_id", "metadata", "opportunity_id", "workspace_id") SELECT "actor_email", "body", "contact_id", "created_at", "id", "kind", "lead_id", "metadata", "opportunity_id", "workspace_id" FROM `activities`;--> statement-breakpoint
DROP TABLE `activities`;--> statement-breakpoint
ALTER TABLE `__new_activities` RENAME TO `activities`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `activities_contact_created_idx` ON `activities` (`contact_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activities_lead_created_idx` ON `activities` (`lead_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activities_opportunity_created_idx` ON `activities` (`opportunity_id`,`created_at`);