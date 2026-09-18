/**
 * DB access layer for articles, likes, bookmarks, follows, and comments —
 * one module per concern, same pattern as site-lock.js/backup-links.js.
 */

import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb, schema } from './db/index.js';
import { HttpError } from './http-error.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUniqueViolation(error, constraintName) {
  const pgError = error?.cause ?? error;
  return pgError?.code === '23505' && (!constraintName || pgError?.constraint === constraintName);
}

async function getArticleRow(dbOrTx, id) {
  if (!UUID_PATTERN.test(id)) return null;
  const rows = await dbOrTx.select().from(schema.articles).where(eq(schema.articles.id, id)).limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

export async function createArticle({ ownerUserId, claimText, articleData }) {
  const db = getDb();
  const [row] = await db.insert(schema.articles).values({ ownerUserId, claimText, articleData }).returning();
  return row;
}

/** Unlike getArticleRow (the internal existence-check helper used inside
 * transactions elsewhere in this file), this is what GET /api/articles/:id
 * actually returns — it joins the owner's username/displayName so the
 * article page can show a byline without a second request, the same
 * information Discover/search/profile listings already include per row. */
export async function getArticleById(id) {
  if (!UUID_PATTERN.test(id)) return null;
  const db = getDb();
  const rows = await db
    .select({
      id: schema.articles.id,
      ownerUserId: schema.articles.ownerUserId,
      claimText: schema.articles.claimText,
      isPublic: schema.articles.isPublic,
      articleData: schema.articles.articleData,
      likeCount: schema.articles.likeCount,
      commentCount: schema.articles.commentCount,
      bookmarkCount: schema.articles.bookmarkCount,
      createdAt: schema.articles.createdAt,
      updatedAt: schema.articles.updatedAt,
      ownerUsername: schema.users.username,
      ownerDisplayName: schema.users.displayName,
    })
    .from(schema.articles)
    .innerJoin(schema.users, eq(schema.users.id, schema.articles.ownerUserId))
    .where(eq(schema.articles.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Shallow-merges `patch` into article_data (e.g. adding counterarguments
 * once step 7 finishes, without touching the rest of the content). */
export async function mergeArticleData(id, patch) {
  const db = getDb();
  await db
    .update(schema.articles)
    .set({ articleData: sql`${schema.articles.articleData} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(eq(schema.articles.id, id));
}

export async function listMyArticles(ownerUserId, { cursor = 0, limit = 30 } = {}) {
  const db = getDb();
  return db
    .select()
    .from(schema.articles)
    .where(eq(schema.articles.ownerUserId, ownerUserId))
    .orderBy(desc(schema.articles.createdAt))
    .limit(limit)
    .offset(cursor);
}

export async function setArticleVisibility({ articleId, userId, isPublic }) {
  const db = getDb();
  const article = await getArticleRow(db, articleId);
  if (!article) throw new HttpError(404, 'article_not_found');
  if (article.ownerUserId !== userId) throw new HttpError(403, 'not_owner');
  const [row] = await db
    .update(schema.articles)
    .set({ isPublic, updatedAt: new Date() })
    .where(eq(schema.articles.id, articleId))
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Article likes
// ---------------------------------------------------------------------------

export async function likeArticle({ userId, articleId }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const article = await getArticleRow(tx, articleId);
    if (!article) throw new HttpError(404, 'article_not_found');
    if (article.ownerUserId === userId) throw new HttpError(403, 'cannot_like_own_article');
    const inserted = await tx.insert(schema.articleLikes).values({ userId, articleId }).onConflictDoNothing().returning();
    if (inserted.length > 0) {
      await tx
        .update(schema.articles)
        .set({ likeCount: sql`${schema.articles.likeCount} + 1` })
        .where(eq(schema.articles.id, articleId));
    }
    return { liked: true };
  });
}

export async function unlikeArticle({ userId, articleId }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(schema.articleLikes)
      .where(and(eq(schema.articleLikes.userId, userId), eq(schema.articleLikes.articleId, articleId)))
      .returning();
    if (deleted.length > 0) {
      await tx
        .update(schema.articles)
        .set({ likeCount: sql`greatest(${schema.articles.likeCount} - 1, 0)` })
        .where(eq(schema.articles.id, articleId));
    }
    return { liked: false };
  });
}

// ---------------------------------------------------------------------------
// Bookmarks: folders + membership (no separate top-level "bookmarked" table —
// see the plan's rationale: "bookmarked at all" is derivable from membership)
// ---------------------------------------------------------------------------

async function isArticleBookmarkedByUser(tx, userId, articleId) {
  const rows = await tx
    .select({ folderId: schema.bookmarkFolderItems.folderId })
    .from(schema.bookmarkFolderItems)
    .innerJoin(schema.bookmarkFolders, eq(schema.bookmarkFolders.id, schema.bookmarkFolderItems.folderId))
    .where(and(eq(schema.bookmarkFolders.userId, userId), eq(schema.bookmarkFolderItems.articleId, articleId)))
    .limit(1);
  return rows.length > 0;
}

async function getOrCreateDefaultFolder(tx, userId) {
  const [existing] = await tx
    .select()
    .from(schema.bookmarkFolders)
    .where(and(eq(schema.bookmarkFolders.userId, userId), eq(schema.bookmarkFolders.isDefault, true)))
    .limit(1);
  if (existing) return existing;

  const created = await tx
    .insert(schema.bookmarkFolders)
    .values({ userId, name: 'Unsorted', isDefault: true })
    .onConflictDoNothing({ target: [schema.bookmarkFolders.userId, schema.bookmarkFolders.name] })
    .returning();
  if (created[0]) return created[0];

  // Lost a race with a concurrent request that created it first.
  const [row] = await tx
    .select()
    .from(schema.bookmarkFolders)
    .where(and(eq(schema.bookmarkFolders.userId, userId), eq(schema.bookmarkFolders.isDefault, true)))
    .limit(1);
  return row;
}

async function listFoldersWithChecked(tx, userId, articleId) {
  const folders = await tx.select().from(schema.bookmarkFolders).where(eq(schema.bookmarkFolders.userId, userId));
  const memberships = await tx
    .select({ folderId: schema.bookmarkFolderItems.folderId })
    .from(schema.bookmarkFolderItems)
    .where(eq(schema.bookmarkFolderItems.articleId, articleId));
  const checked = new Set(memberships.map((m) => m.folderId));
  return folders
    .map((f) => ({ id: f.id, name: f.name, isDefault: f.isDefault, checked: checked.has(f.id) }))
    .sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
}

/** First click on an un-bookmarked article: get-or-create "Unsorted", add it there. */
export async function quickBookmark({ userId, articleId }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const article = await getArticleRow(tx, articleId);
    if (!article) throw new HttpError(404, 'article_not_found');
    const wasBookmarked = await isArticleBookmarkedByUser(tx, userId, articleId);
    const folder = await getOrCreateDefaultFolder(tx, userId);
    await tx.insert(schema.bookmarkFolderItems).values({ folderId: folder.id, articleId }).onConflictDoNothing();
    if (!wasBookmarked) {
      await tx
        .update(schema.articles)
        .set({ bookmarkCount: sql`${schema.articles.bookmarkCount} + 1` })
        .where(eq(schema.articles.id, articleId));
    }
    return listFoldersWithChecked(tx, userId, articleId);
  });
}

export async function listBookmarkFoldersForArticle({ userId, articleId }) {
  const db = getDb();
  const article = await getArticleRow(db, articleId);
  if (!article) throw new HttpError(404, 'article_not_found');
  return listFoldersWithChecked(db, userId, articleId);
}

/** The "click the filled bookmark icon again" widget: check/uncheck one folder. */
export async function setBookmarkFolderMembership({ userId, articleId, folderId, checked }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [folder] = await tx
      .select()
      .from(schema.bookmarkFolders)
      .where(and(eq(schema.bookmarkFolders.id, folderId), eq(schema.bookmarkFolders.userId, userId)))
      .limit(1);
    if (!folder) throw new HttpError(404, 'folder_not_found');
    const article = await getArticleRow(tx, articleId);
    if (!article) throw new HttpError(404, 'article_not_found');

    const wasBookmarked = await isArticleBookmarkedByUser(tx, userId, articleId);
    if (checked) {
      await tx.insert(schema.bookmarkFolderItems).values({ folderId, articleId }).onConflictDoNothing();
    } else {
      await tx
        .delete(schema.bookmarkFolderItems)
        .where(and(eq(schema.bookmarkFolderItems.folderId, folderId), eq(schema.bookmarkFolderItems.articleId, articleId)));
    }
    const isBookmarked = await isArticleBookmarkedByUser(tx, userId, articleId);
    if (wasBookmarked && !isBookmarked) {
      await tx
        .update(schema.articles)
        .set({ bookmarkCount: sql`greatest(${schema.articles.bookmarkCount} - 1, 0)` })
        .where(eq(schema.articles.id, articleId));
    } else if (!wasBookmarked && isBookmarked) {
      await tx
        .update(schema.articles)
        .set({ bookmarkCount: sql`${schema.articles.bookmarkCount} + 1` })
        .where(eq(schema.articles.id, articleId));
    }
    return listFoldersWithChecked(tx, userId, articleId);
  });
}

export async function listBookmarkFolders(userId) {
  const db = getDb();
  return db.select().from(schema.bookmarkFolders).where(eq(schema.bookmarkFolders.userId, userId));
}

export async function createBookmarkFolder({ userId, name }) {
  const trimmed = typeof name === 'string' ? name.trim().slice(0, 60) : '';
  if (!trimmed) throw new HttpError(400, 'invalid_folder_name');
  const db = getDb();
  try {
    const [row] = await db.insert(schema.bookmarkFolders).values({ userId, name: trimmed, isDefault: false }).returning();
    return row;
  } catch (error) {
    if (isUniqueViolation(error, 'bookmark_folders_user_id_name_key')) throw new HttpError(409, 'folder_name_taken');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Follows
// ---------------------------------------------------------------------------

export async function followUser({ followerId, followeeId }) {
  if (followerId === followeeId) throw new HttpError(400, 'cannot_follow_self');
  const db = getDb();
  await db.insert(schema.follows).values({ followerId, followeeId }).onConflictDoNothing();
  return { following: true };
}

export async function unfollowUser({ followerId, followeeId }) {
  const db = getDb();
  await db
    .delete(schema.follows)
    .where(and(eq(schema.follows.followerId, followerId), eq(schema.follows.followeeId, followeeId)));
  return { following: false };
}

export async function listFollowers(userId) {
  const db = getDb();
  return db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
    .from(schema.follows)
    .innerJoin(schema.users, eq(schema.users.id, schema.follows.followerId))
    .where(eq(schema.follows.followeeId, userId));
}

export async function listFollowing(userId) {
  const db = getDb();
  return db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
    .from(schema.follows)
    .innerJoin(schema.users, eq(schema.users.id, schema.follows.followeeId))
    .where(eq(schema.follows.followerId, userId));
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function createComment({ articleId, authorId, body }) {
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) throw new HttpError(400, 'empty_comment');
  if (trimmed.length > 2000) throw new HttpError(400, 'comment_too_long');
  const db = getDb();
  return db.transaction(async (tx) => {
    const article = await getArticleRow(tx, articleId);
    if (!article) throw new HttpError(404, 'article_not_found');
    const [row] = await tx.insert(schema.comments).values({ articleId, authorId, body: trimmed }).returning();
    await tx
      .update(schema.articles)
      .set({ commentCount: sql`${schema.articles.commentCount} + 1` })
      .where(eq(schema.articles.id, articleId));
    return row;
  });
}

/** Most-liked at top, with a little seeded-hash randomness for recent
 * comments — see the plan's Comment Ranking section for the full formula. */
export async function listComments({ articleId, seed, cursor = 0, limit = 50 }) {
  const db = getDb();
  const safeSeed = typeof seed === 'string' && seed ? seed : 'no-seed';
  const result = await db.execute(sql`
    SELECT c.id, c.article_id AS "articleId", c.author_id AS "authorId", c.body,
           c.like_count AS "likeCount", c.created_at AS "createdAt",
           u.username, u.display_name AS "displayName"
    FROM comments c
    JOIN users u ON u.id = c.author_id
    WHERE c.article_id = ${articleId}
    ORDER BY
      ( c.like_count
        + CASE WHEN now() - c.created_at < interval '24 hours'
            THEN 3 * ((hashtext(c.id::text || ${safeSeed}) & 65535)::float / 65535)
                   * exp(-EXTRACT(EPOCH FROM (now() - c.created_at)) / 3600.0 / 6.0)
            ELSE 0 END
      ) DESC,
      c.created_at DESC, c.id
    LIMIT ${limit} OFFSET ${cursor}
  `);
  return result.rows;
}

export async function likeComment({ userId, commentId }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [comment] = await tx.select().from(schema.comments).where(eq(schema.comments.id, commentId)).limit(1);
    if (!comment) throw new HttpError(404, 'comment_not_found');
    const inserted = await tx.insert(schema.commentLikes).values({ userId, commentId }).onConflictDoNothing().returning();
    if (inserted.length > 0) {
      await tx
        .update(schema.comments)
        .set({ likeCount: sql`${schema.comments.likeCount} + 1` })
        .where(eq(schema.comments.id, commentId));
    }
    return { liked: true };
  });
}

export async function unlikeComment({ userId, commentId }) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(schema.commentLikes)
      .where(and(eq(schema.commentLikes.userId, userId), eq(schema.commentLikes.commentId, commentId)))
      .returning();
    if (deleted.length > 0) {
      await tx
        .update(schema.comments)
        .set({ likeCount: sql`greatest(${schema.comments.likeCount} - 1, 0)` })
        .where(eq(schema.comments.id, commentId));
    }
    return { liked: false };
  });
}

// ---------------------------------------------------------------------------
// Discover / Following / Search — see the plan's Discover Feed Ranking
// section for why these use a client-supplied `seed` instead of raw random().
// ---------------------------------------------------------------------------

export async function discoverFeed({ seed, cursor = 0, limit = 30 }) {
  const db = getDb();
  const safeSeed = typeof seed === 'string' && seed ? seed : 'no-seed';
  const result = await db.execute(sql`
    SELECT a.id, a.owner_user_id AS "ownerUserId", a.claim_text AS "claimText",
           a.is_public AS "isPublic", a.article_data AS "articleData",
           a.like_count AS "likeCount", a.comment_count AS "commentCount",
           a.bookmark_count AS "bookmarkCount", a.created_at AS "createdAt",
           u.username, u.display_name AS "displayName"
    FROM articles a
    JOIN users u ON u.id = a.owner_user_id
    WHERE a.is_public = true
    ORDER BY
      ( (a.like_count * 2 + a.comment_count + a.bookmark_count)
        / POWER(EXTRACT(EPOCH FROM (now() - a.created_at)) / 3600.0 + 2, 1.5)
      ) * (0.6 + 0.8 * ((hashtext(a.id::text || ${safeSeed}) & 65535)::float / 65535)) DESC,
      a.id
    LIMIT ${limit} OFFSET ${cursor}
  `);
  return result.rows;
}

export async function followingFeed({ userId, cursor = 0, limit = 30 }) {
  const db = getDb();
  return db
    .select({
      id: schema.articles.id,
      ownerUserId: schema.articles.ownerUserId,
      claimText: schema.articles.claimText,
      isPublic: schema.articles.isPublic,
      articleData: schema.articles.articleData,
      likeCount: schema.articles.likeCount,
      commentCount: schema.articles.commentCount,
      bookmarkCount: schema.articles.bookmarkCount,
      createdAt: schema.articles.createdAt,
      username: schema.users.username,
      displayName: schema.users.displayName,
    })
    .from(schema.articles)
    .innerJoin(schema.users, eq(schema.users.id, schema.articles.ownerUserId))
    .innerJoin(schema.follows, eq(schema.follows.followeeId, schema.articles.ownerUserId))
    .where(and(eq(schema.follows.followerId, userId), eq(schema.articles.isPublic, true)))
    .orderBy(desc(schema.articles.createdAt))
    .limit(limit)
    .offset(cursor);
}

export async function getUserByUsername(username) {
  const db = getDb();
  if (typeof username !== 'string' || !username) return null;
  const [row] = await db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
    .from(schema.users)
    .where(and(eq(schema.users.username, username), eq(schema.users.isGuest, false)))
    .limit(1);
  return row ?? null;
}

export async function listPublicArticlesByUser(userId, { cursor = 0, limit = 30 } = {}) {
  const db = getDb();
  return db
    .select()
    .from(schema.articles)
    .where(and(eq(schema.articles.ownerUserId, userId), eq(schema.articles.isPublic, true)))
    .orderBy(desc(schema.articles.createdAt))
    .limit(limit)
    .offset(cursor);
}

export async function searchArticles({ query, cursor = 0, limit = 30 }) {
  const db = getDb();
  const term = typeof query === 'string' ? query.trim() : '';
  if (!term) return [];
  return db
    .select({
      id: schema.articles.id,
      ownerUserId: schema.articles.ownerUserId,
      claimText: schema.articles.claimText,
      isPublic: schema.articles.isPublic,
      articleData: schema.articles.articleData,
      likeCount: schema.articles.likeCount,
      commentCount: schema.articles.commentCount,
      bookmarkCount: schema.articles.bookmarkCount,
      createdAt: schema.articles.createdAt,
      username: schema.users.username,
      displayName: schema.users.displayName,
    })
    .from(schema.articles)
    .innerJoin(schema.users, eq(schema.users.id, schema.articles.ownerUserId))
    .where(and(eq(schema.articles.isPublic, true), sql`${schema.articles.claimText} ILIKE ${'%' + term + '%'}`))
    .orderBy(desc(schema.articles.createdAt))
    .limit(limit)
    .offset(cursor);
}
