CREATE TABLE `track_likes` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_track_id` text NOT NULL,
	`source_url` text NOT NULL,
	`title` text NOT NULL,
	`artist` text,
	`liked_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `provider`, `provider_track_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `track_likes_user_liked_at_idx` ON `track_likes` (`user_id`,`liked_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
