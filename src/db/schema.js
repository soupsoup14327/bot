import {
  index as pgIndex,
  integer as pgInteger,
  pgTable,
  primaryKey as pgPrimaryKey,
  text as pgText,
} from 'drizzle-orm/pg-core';
import {
  index as sqliteIndex,
  integer as sqliteInteger,
  primaryKey as sqlitePrimaryKey,
  sqliteTable,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';

const TABLE_USERS = 'users';
const TABLE_TRACKS = 'tracks';
const TABLE_TRACK_LIKES = 'track_likes';
const TABLE_TRACK_PLAYS = 'track_plays';

/**
 * Database schema owner.
 *
 * Intentional non-goals of the data layer:
 * - Guild session state is NOT persisted here; it stays in-memory per guild
 *   because it is transient by nature (current player state, listeners count,
 *   connected voice channel, etc).
 * - `track_likes.title` / `track_likes.artist` stay denormalized for fast UI
 *   reads even after `tracks` exists. The canonical table serves history and
 *   future recommendation flows; the read path can stay simple.
 * - Any Postgres-only type or feature needs a dedicated ADR revisit. See
 *   docs/adr/001-data-layer.md §4 before adding backend-specific schema.
 *
 * Practical note:
 * - This file is the schema source of truth.
 * - Tiny `schema.sqlite.js` / `schema.pg.js` wrappers exist only because
 *   Drizzle generation is dialect-specific, while runtime needs both backends.
 * - Current schema covers likes plus playback history foundations:
 *   `users`, `tracks`, `track_likes`, `track_plays`.
 */

const sqliteUsers = sqliteTable(TABLE_USERS, {
  userId: sqliteText('user_id').primaryKey(),
  createdAt: sqliteText('created_at').notNull(),
});

const sqliteTracks = sqliteTable(TABLE_TRACKS, {
  trackKey: sqliteText('track_key').primaryKey(),
  provider: sqliteText('provider').notNull(),
  sourceUrl: sqliteText('source_url').notNull(),
  title: sqliteText('title').notNull(),
  artist: sqliteText('artist'),
  createdAt: sqliteText('created_at').notNull(),
});

const sqliteTrackLikes = sqliteTable(
  TABLE_TRACK_LIKES,
  {
    userId: sqliteText('user_id')
      .notNull()
      .references(() => sqliteUsers.userId, { onDelete: 'cascade' }),
    provider: sqliteText('provider').notNull(),
    providerTrackId: sqliteText('provider_track_id').notNull(),
    sourceUrl: sqliteText('source_url').notNull(),
    title: sqliteText('title').notNull(),
    artist: sqliteText('artist'),
    likedAt: sqliteText('liked_at').notNull(),
  },
  (table) => ({
    pk: sqlitePrimaryKey({
      name: 'track_likes_pk',
      columns: [table.userId, table.provider, table.providerTrackId],
    }),
    userLikedAtIdx: sqliteIndex('track_likes_user_liked_at_idx').on(table.userId, table.likedAt),
  }),
);

const sqliteTrackPlays = sqliteTable(
  TABLE_TRACK_PLAYS,
  {
    playId: sqliteText('play_id').primaryKey(),
    userId: sqliteText('user_id')
      .notNull()
      .references(() => sqliteUsers.userId, { onDelete: 'cascade' }),
    trackKey: sqliteText('track_key')
      .notNull()
      .references(() => sqliteTracks.trackKey, { onDelete: 'cascade' }),
    guildId: sqliteText('guild_id'),
    sessionId: sqliteText('session_id'),
    requestedBy: sqliteText('requested_by'),
    triggeredBy: sqliteText('triggered_by').notNull(),
    listenersCount: sqliteInteger('listeners_count').notNull(),
    elapsedMs: sqliteInteger('elapsed_ms'),
    eventType: sqliteText('event_type').notNull(),
    playedAt: sqliteText('played_at').notNull(),
  },
  (table) => ({
    userPlayedAtIdx: sqliteIndex('track_plays_user_played_at_idx').on(table.userId, table.playedAt),
    trackPlayedAtIdx: sqliteIndex('track_plays_track_played_at_idx').on(table.trackKey, table.playedAt),
  }),
);

const pgUsers = pgTable(TABLE_USERS, {
  userId: pgText('user_id').primaryKey(),
  createdAt: pgText('created_at').notNull(),
});

const pgTracks = pgTable(TABLE_TRACKS, {
  trackKey: pgText('track_key').primaryKey(),
  provider: pgText('provider').notNull(),
  sourceUrl: pgText('source_url').notNull(),
  title: pgText('title').notNull(),
  artist: pgText('artist'),
  createdAt: pgText('created_at').notNull(),
});

const pgTrackLikes = pgTable(
  TABLE_TRACK_LIKES,
  {
    userId: pgText('user_id')
      .notNull()
      .references(() => pgUsers.userId, { onDelete: 'cascade' }),
    provider: pgText('provider').notNull(),
    providerTrackId: pgText('provider_track_id').notNull(),
    sourceUrl: pgText('source_url').notNull(),
    title: pgText('title').notNull(),
    artist: pgText('artist'),
    likedAt: pgText('liked_at').notNull(),
  },
  (table) => ({
    pk: pgPrimaryKey({
      name: 'track_likes_pk',
      columns: [table.userId, table.provider, table.providerTrackId],
    }),
    userLikedAtIdx: pgIndex('track_likes_user_liked_at_idx').on(table.userId, table.likedAt),
  }),
);

const pgTrackPlays = pgTable(
  TABLE_TRACK_PLAYS,
  {
    playId: pgText('play_id').primaryKey(),
    userId: pgText('user_id')
      .notNull()
      .references(() => pgUsers.userId, { onDelete: 'cascade' }),
    trackKey: pgText('track_key')
      .notNull()
      .references(() => pgTracks.trackKey, { onDelete: 'cascade' }),
    guildId: pgText('guild_id'),
    sessionId: pgText('session_id'),
    requestedBy: pgText('requested_by'),
    triggeredBy: pgText('triggered_by').notNull(),
    listenersCount: pgInteger('listeners_count').notNull(),
    elapsedMs: pgInteger('elapsed_ms'),
    eventType: pgText('event_type').notNull(),
    playedAt: pgText('played_at').notNull(),
  },
  (table) => ({
    userPlayedAtIdx: pgIndex('track_plays_user_played_at_idx').on(table.userId, table.playedAt),
    trackPlayedAtIdx: pgIndex('track_plays_track_played_at_idx').on(table.trackKey, table.playedAt),
  }),
);

export const sqliteSchema = Object.freeze({
  users: sqliteUsers,
  tracks: sqliteTracks,
  trackLikes: sqliteTrackLikes,
  trackPlays: sqliteTrackPlays,
});

export const pgSchema = Object.freeze({
  users: pgUsers,
  tracks: pgTracks,
  trackLikes: pgTrackLikes,
  trackPlays: pgTrackPlays,
});

/**
 * @param {'sqlite' | 'postgres'} backend
 */
export function getSchemaForBackend(backend) {
  return backend === 'postgres' ? pgSchema : sqliteSchema;
}
