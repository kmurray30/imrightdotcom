/**
 * Drizzle schema — the source of truth for every table this plan adds
 * (users, sessions, articles, follows, article_likes, bookmark_folders,
 * bookmark_folder_items, comments, comment_likes). `drizzle-kit generate`
 * reads this file to produce the real migration SQL in ./migrations.
 *
 * `site_lock` and `backup_links` (imright/scripts/site-lock.js,
 * backup-links.js) are intentionally NOT declared here — they predate this
 * schema, are unrelated to it, and keep managing their own table via plain
 * `pg` + inline `CREATE TABLE IF NOT EXISTS`, same as today.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Postgres's citext type has no first-class Drizzle helper; customType is the
// documented escape hatch for exactly this kind of case-insensitive-text need
// (case-insensitive username/email uniqueness without hand-rolled LOWER() indexes).
const citext = customType({ dataType: () => 'citext' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    isGuest: boolean('is_guest').notNull().default(true),
    username: citext('username').unique(),
    email: citext('email').unique(),
    passwordHash: text('password_hash'),
    displayName: text('display_name').notNull().default('Anonymous'),
    guestCookieId: uuid('guest_cookie_id').unique(),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
  },
  (table) => [
    index('users_guest_cookie_id_idx').on(table.guestCookieId).where(sql`${table.guestCookieId} is not null`),
    check(
      'users_account_fields_required',
      sql`${table.isGuest} OR (${table.username} IS NOT NULL AND ${table.email} IS NOT NULL AND ${table.passwordHash} IS NOT NULL)`
    ),
  ]
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (table) => [
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ]
);

export const articles = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    claimText: text('claim_text').notNull(),
    // Defaults to public: most claims generated here are jokes/bits meant to
    // be shared, not kept private — private is now an explicit opt-out via
    // VisibilityToggle rather than something every article starts as.
    isPublic: boolean('is_public').notNull().default(true),
    // Exactly buildArticleData()'s current shape (title/body/sections/citations/images/counterarguments).
    articleData: jsonb('article_data').notNull(),
    likeCount: integer('like_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    bookmarkCount: integer('bookmark_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('articles_owner_user_id_idx').on(table.ownerUserId, table.createdAt.desc()),
    index('articles_is_public_idx').on(table.isPublic, table.createdAt.desc()).where(sql`${table.isPublic} = true`),
    index('articles_claim_text_trgm_idx').using('gin', sql`${table.claimText} gin_trgm_ops`),
  ]
);

export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followeeId: uuid('followee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.followerId, table.followeeId] }),
    index('follows_followee_id_idx').on(table.followeeId),
    check('follows_no_self_follow', sql`${table.followerId} <> ${table.followeeId}`),
  ]
);

export const articleLikes = pgTable(
  'article_likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.articleId] }),
    index('article_likes_article_id_idx').on(table.articleId),
  ]
);

export const bookmarkFolders = pgTable(
  'bookmark_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('bookmark_folders_user_id_name_key').on(table.userId, table.name),
    // Exactly one default ("Unsorted") folder per user: a partial unique
    // index, since a same-table CHECK can't count rows.
    uniqueIndex('bookmark_folders_one_default_per_user').on(table.userId).where(sql`${table.isDefault}`),
  ]
);

export const bookmarkFolderItems = pgTable(
  'bookmark_folder_items',
  {
    folderId: uuid('folder_id')
      .notNull()
      .references(() => bookmarkFolders.id, { onDelete: 'cascade' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.folderId, table.articleId] }),
    index('bookmark_folder_items_article_id_idx').on(table.articleId),
  ]
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    likeCount: integer('like_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('comments_article_id_idx').on(table.articleId)]
);

export const commentLikes = pgTable(
  'comment_likes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.commentId] }),
    index('comment_likes_comment_id_idx').on(table.commentId),
  ]
);

/**
 * Durable status for a /api/run pipeline execution — the id here is the same
 * runId used in /api/stream/:runId and returned from POST /api/run.
 *
 * Exists specifically so a deploy or crash mid-run doesn't strand the
 * client: run state used to live only in the process's in-memory `activeRuns`
 * Map, so a browser reconnecting to a fresh process (after the old one was
 * killed) got a bare 404 from GET /api/stream/:runId and its EventSource
 * would retry that forever with no feedback — a silent, permanent hang.
 * Now the stream handler falls back to this table when a runId isn't in the
 * current process's memory: 'ready'/'done' replays the real outcome as if
 * nothing happened; 'running' with no in-memory record only happens if the
 * process that was running it died — rather than just reporting that as a
 * failure, the stream handler automatically restarts the pipeline from
 * scratch under the same runId (claimText is kept for exactly this), bounded
 * by retryCount so a claim that deterministically fails can't retry forever
 * and rack up LLM cost.
 */
export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: uuid('id').primaryKey(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    claimText: text('claim_text').notNull(),
    status: text('status').notNull().default('running'), // running | ready | done | error
    articleId: uuid('article_id').references(() => articles.id, { onDelete: 'set null' }),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('pipeline_runs_status_check', sql`${table.status} IN ('running', 'ready', 'done', 'error')`),
  ]
);
