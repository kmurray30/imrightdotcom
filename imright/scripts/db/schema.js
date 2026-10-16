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
    // Grants access to the pipeline debug page (GET /api/articles/:id/debug)
    // for any article, not scoped to what this account owns — a support/dev
    // tool, not a social-layer permission. Set directly in the DB (see
    // imright/scripts/grant-admin.js); no self-serve signup path, deliberately.
    isAdmin: boolean('is_admin').notNull().default(false),
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
    viewCount: integer('view_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('articles_owner_user_id_idx').on(table.ownerUserId, table.createdAt.desc()),
    index('articles_is_public_idx').on(table.isPublic, table.createdAt.desc()).where(sql`${table.isPublic} = true`),
    index('articles_claim_text_trgm_idx').using('gin', sql`${table.claimText} gin_trgm_ops`),
  ]
);

/** Dedupes views by the existing anonymous `imright_vid` visitor cookie
 * (identity.js), not by users.id — a view has to work for a total drive-by
 * visitor who has never generated or liked anything, and keying it to the
 * guest/account identity system would mean minting a permanent `users` row
 * on every single article pageview (the exact per-pageview-row problem that
 * system was deliberately designed to avoid). visitor_id is therefore a bare
 * cookie value, not a foreign key into users. */
export const articleViews = pgTable(
  'article_views',
  {
    articleId: uuid('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    visitorId: uuid('visitor_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.visitorId] }),
    index('article_views_article_id_idx').on(table.articleId),
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

/**
 * Durable copy of the full per-stage pipeline visualization (angles, wiki
 * search/filter, link validation, raw LLM inputs/outputs, counterarguer) —
 * exactly the `data` shape generate-debug.js's buildHtml() renders. Without
 * this, that data only ever existed as per-stage YAML/JSON files under the
 * project root, which are wiped on every Railway redeploy; this table is
 * what lets an admin view a given article's debug page at any time, not just
 * until the next deploy. One row per article, written once right after the
 * pipeline finishes (see imright/index.js's collectDebugData() call and its
 * caller in serve-site.js) — never read on a normal article pageview, so it
 * deliberately isn't a column on `articles` itself.
 */
export const pipelineDebug = pgTable('pipeline_debug', {
  articleId: uuid('article_id')
    .primaryKey()
    .references(() => articles.id, { onDelete: 'cascade' }),
  debugData: jsonb('debug_data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Feedback submitted from the header menu's "Give feedback" item. `userId`
 * is whoever req.user resolved to at submit time (guest or real account),
 * kept only for traceability — `onDelete: 'set null'` so deleting an
 * account doesn't take its feedback history with it. `email` is always a
 * real address to follow up at: a real account's own email (server-trusted,
 * never the client-supplied one — see routes/social.js) for a logged-in
 * submitter, or a typed one for a guest/anonymous visitor, who has no
 * account email to fall back on.
 */
export const feedback = pgTable('feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  email: text('email').notNull(),
  message: text('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Admin-only Workshop experiments: resume the pipeline from Conspirator (1),
 * Tabloid Generator (5), or Counterarguer (7) — the only LLM stages — reusing
 * an existing article's earlier-stage data (from pipelineDebug) unchanged,
 * with a different provider/model/system-prompt for the stages that re-run.
 * Deliberately NOT a view/branch of `articles`/`pipelineDebug` — a Workshop
 * run must never be reachable from Discover/search/profile/any public
 * listing, so it lives in its own table with no code path that ever joins
 * it into those queries.
 */
export const workshopRuns = pgTable(
  'workshop_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Nullable: null for a from-scratch stage-1 run with no source article.
    sourceArticleId: uuid('source_article_id').references(() => articles.id, { onDelete: 'set null' }),
    claimText: text('claim_text').notNull(),
    startStage: integer('start_stage').notNull(),
    // { "1": {provider, model, systemPrompt}, "5": {...}, "7": {...} } — only
    // keys for LLM stages at or after startStage.
    stageConfig: jsonb('stage_config').notNull(),
    status: text('status').notNull().default('running'), // running | done | error
    errorMessage: text('error_message'),
    // Populated once done: the same 13-key shape generate-debug.js's
    // buildHtml() consumes, plus a stageRows array (model/cost/time per
    // stage actually run, see run-workshop.js).
    resultData: jsonb('result_data'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('workshop_runs_created_by_user_id_idx').on(table.createdByUserId, table.createdAt.desc()),
    index('workshop_runs_source_article_id_idx').on(table.sourceArticleId),
    check('workshop_runs_status_check', sql`${table.status} IN ('running', 'done', 'error')`),
    check('workshop_runs_start_stage_check', sql`${table.startStage} IN (1, 5, 7)`),
  ]
);

/**
 * Persisted, learned "known models" per provider for the Workshop model
 * dropdown. Seeded at migration time with the models already known to this
 * codebase (see utils/grok-pricing.json); grown automatically the first time
 * a custom model string completes a stage without throwing.
 */
export const workshopKnownModels = pgTable(
  'workshop_known_models',
  {
    provider: text('provider').notNull(),
    modelName: text('model_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.modelName] })]
);
