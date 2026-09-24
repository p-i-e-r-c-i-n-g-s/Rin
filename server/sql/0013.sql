-- Backs the login throttle in server/src/services/auth.ts: failed password
-- logins per client IP within a rolling window. Before this, nothing limited
-- password guessing on POST /api/auth/login, and the admin username is
-- published on every post, so the password was the only barrier.

CREATE TABLE IF NOT EXISTS `login_attempts` (
	`ip` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
UPDATE `info` SET `value` = '13' WHERE `key` = 'migration_version';
