CREATE TABLE `track_plays` (
	`play_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`track_key` text NOT NULL,
	`guild_id` text,
	`session_id` text,
	`requested_by` text,
	`triggered_by` text NOT NULL,
	`listeners_count` integer NOT NULL,
	`elapsed_ms` integer,
	`event_type` text NOT NULL,
	`played_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_key`) REFERENCES `tracks`(`track_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `track_plays_user_played_at_idx` ON `track_plays` (`user_id`,`played_at`);--> statement-breakpoint
CREATE INDEX `track_plays_track_played_at_idx` ON `track_plays` (`track_key`,`played_at`);--> statement-breakpoint
CREATE TABLE `tracks` (
	`track_key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`source_url` text NOT NULL,
	`title` text NOT NULL,
	`artist` text,
	`created_at` text NOT NULL
);
