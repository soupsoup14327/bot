CREATE TABLE "track_likes" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_track_id" text NOT NULL,
	"source_url" text NOT NULL,
	"title" text NOT NULL,
	"artist" text,
	"liked_at" text NOT NULL,
	CONSTRAINT "track_likes_pk" PRIMARY KEY("user_id","provider","provider_track_id")
);
--> statement-breakpoint
CREATE TABLE "track_plays" (
	"play_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"track_key" text NOT NULL,
	"guild_id" text,
	"session_id" text,
	"requested_by" text,
	"triggered_by" text NOT NULL,
	"listeners_count" integer NOT NULL,
	"elapsed_ms" integer,
	"event_type" text NOT NULL,
	"played_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"track_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"source_url" text NOT NULL,
	"title" text NOT NULL,
	"artist" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "track_likes" ADD CONSTRAINT "track_likes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_plays" ADD CONSTRAINT "track_plays_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_plays" ADD CONSTRAINT "track_plays_track_key_tracks_track_key_fk" FOREIGN KEY ("track_key") REFERENCES "public"."tracks"("track_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "track_likes_user_liked_at_idx" ON "track_likes" USING btree ("user_id","liked_at");--> statement-breakpoint
CREATE INDEX "track_plays_user_played_at_idx" ON "track_plays" USING btree ("user_id","played_at");--> statement-breakpoint
CREATE INDEX "track_plays_track_played_at_idx" ON "track_plays" USING btree ("track_key","played_at");