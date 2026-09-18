CREATE TABLE `registration_claims` (
	`claim_key` text NOT NULL,
	`created_at` text NOT NULL,
	`grant_kind` text NOT NULL,
	`grant_ref` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_claims_claim_key_unique` ON `registration_claims` (`claim_key`);--> statement-breakpoint
-- Durable guard: re-validate grant eligibility inside the redemption batch.
-- RAISE(ABORT) aborts the whole batch, rolling back the user/account writes
-- of a redemption that lost the race or raced against a revocation,
-- consumption, or expiry committed by another request.
CREATE TRIGGER `registration_claims_grant_guard` BEFORE INSERT ON `registration_claims`
WHEN (NEW.grant_kind = 'bootstrap'
      AND NOT EXISTS (SELECT 1 FROM bootstrap_state WHERE id = 'default' AND consumed_at IS NULL AND expires_at > NEW.created_at))
  OR (NEW.grant_kind = 'invite'
      AND NOT EXISTS (SELECT 1 FROM staff_invites WHERE token_hash = NEW.grant_ref AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NEW.created_at))
BEGIN
  SELECT RAISE(ABORT, 'registration grant unavailable');
END;
