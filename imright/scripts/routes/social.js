/**
 * Everything under /api that isn't auth (account.js) or the /api/run
 * pipeline itself: article visibility/history, likes, bookmarks, follows,
 * comments, and the Discover/Following/Search feeds. Mounted at /api in
 * serve-site.js. See the plan's Backend API table for the full route list.
 */

import { Router } from 'express';
import { requireAccount } from '../require-account.js';
import { ensureOwner } from '../auth-accounts.js';
import { HttpError } from '../http-error.js';
import * as Articles from '../articles.js';

export const socialRouter = Router();

function parseCursor(req) {
  const cursor = Number(req.query.cursor);
  return Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
}

// ---- Articles: history + visibility ----

socialRouter.get('/me/articles', async (req, res, next) => {
  try {
    if (!req.user) {
      res.json({ articles: [] });
      return;
    }
    const articles = await Articles.listMyArticles(req.user.id, { cursor: parseCursor(req) });
    res.json({ articles });
  } catch (error) {
    next(error);
  }
});

socialRouter.get('/articles/:id', async (req, res, next) => {
  try {
    const article = await Articles.getArticleById(req.params.id, req.user?.id);
    if (!article) throw new HttpError(404, 'article_not_found');
    // No visibility check here on purpose: any article, public or private, is
    // reachable via its direct link (requirement 4). Visibility only gates
    // Discover listing, handled separately below.
    res.json({ article });
  } catch (error) {
    next(error);
  }
});

socialRouter.patch('/articles/:id/visibility', requireAccount, async (req, res, next) => {
  try {
    const { isPublic } = req.body ?? {};
    if (typeof isPublic !== 'boolean') throw new HttpError(400, 'invalid_body');
    const article = await Articles.setArticleVisibility({ articleId: req.params.id, userId: req.user.id, isPublic });
    res.json({ article });
  } catch (error) {
    next(error);
  }
});

// Not gated by requireAccount on purpose: a guest can delete their own
// guest-owned articles too (this only ever touches your own content).
// Articles.deleteArticle's ownership check 403s anyone else, including a
// visitor with no identity at all (req.user is then undefined).
socialRouter.delete('/articles/:id', async (req, res, next) => {
  try {
    if (!req.user) throw new HttpError(403, 'account_required');
    await Articles.deleteArticle({ articleId: req.params.id, userId: req.user.id });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ---- Article likes ----

// Guest-ok, on purpose: liking is real engagement worth counting even from
// someone who never made an account, and a guest's `users` row (see
// ensureOwner) already gives article_likes a stable per-browser identity to
// key its unique constraint on — same idempotency guarantee an account gets,
// just scoped to this browser instead of a login. This does mean a guest can
// clear cookies to re-like, same tradeoff as any anonymous-engagement metric.
socialRouter.post('/articles/:id/like', async (req, res, next) => {
  try {
    const owner = await ensureOwner(req, res);
    res.json(await Articles.likeArticle({ userId: owner.id, articleId: req.params.id }));
  } catch (error) {
    next(error);
  }
});

socialRouter.delete('/articles/:id/like', async (req, res, next) => {
  try {
    const owner = await ensureOwner(req, res);
    res.json(await Articles.unlikeArticle({ userId: owner.id, articleId: req.params.id }));
  } catch (error) {
    next(error);
  }
});

// ---- Bookmarks ----

socialRouter.post('/articles/:id/bookmark', requireAccount, async (req, res, next) => {
  try {
    const folders = await Articles.quickBookmark({ userId: req.user.id, articleId: req.params.id });
    res.json({ folders });
  } catch (error) {
    next(error);
  }
});

socialRouter.get('/articles/:id/bookmark-folders', requireAccount, async (req, res, next) => {
  try {
    const folders = await Articles.listBookmarkFoldersForArticle({ userId: req.user.id, articleId: req.params.id });
    res.json({ folders });
  } catch (error) {
    next(error);
  }
});

socialRouter.put('/articles/:id/bookmark-folders/:folderId', requireAccount, async (req, res, next) => {
  try {
    const { checked } = req.body ?? {};
    if (typeof checked !== 'boolean') throw new HttpError(400, 'invalid_body');
    const folders = await Articles.setBookmarkFolderMembership({
      userId: req.user.id,
      articleId: req.params.id,
      folderId: req.params.folderId,
      checked,
    });
    res.json({ folders });
  } catch (error) {
    next(error);
  }
});

socialRouter.get('/bookmark-folders', requireAccount, async (req, res, next) => {
  try {
    res.json({ folders: await Articles.listBookmarkFolders(req.user.id) });
  } catch (error) {
    next(error);
  }
});

socialRouter.post('/bookmark-folders', requireAccount, async (req, res, next) => {
  try {
    const folder = await Articles.createBookmarkFolder({ userId: req.user.id, name: req.body?.name });
    res.json({ folder });
  } catch (error) {
    next(error);
  }
});

// ---- Follows ----

socialRouter.post('/users/:userId/follow', requireAccount, async (req, res, next) => {
  try {
    res.json(await Articles.followUser({ followerId: req.user.id, followeeId: req.params.userId }));
  } catch (error) {
    next(error);
  }
});

socialRouter.delete('/users/:userId/follow', requireAccount, async (req, res, next) => {
  try {
    res.json(await Articles.unfollowUser({ followerId: req.user.id, followeeId: req.params.userId }));
  } catch (error) {
    next(error);
  }
});

socialRouter.get('/users/by-username/:username', async (req, res, next) => {
  try {
    const user = await Articles.getUserByUsername(req.params.username);
    if (!user) throw new HttpError(404, 'user_not_found');
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

socialRouter.get('/users/:userId/articles', async (req, res, next) => {
  try {
    const articles = await Articles.listPublicArticlesByUser(req.params.userId, { cursor: parseCursor(req) });
    res.json({ articles });
  } catch (error) {
    next(error);
  }
});

socialRouter.get('/users/:userId/followers', async (req, res, next) => {
  try {
    res.json({ followers: await Articles.listFollowers(req.params.userId) });
  } catch (error) {
    next(error);
  }
});

socialRouter.get('/users/:userId/following', async (req, res, next) => {
  try {
    res.json({ following: await Articles.listFollowing(req.params.userId) });
  } catch (error) {
    next(error);
  }
});

// ---- Comments ----

socialRouter.get('/articles/:id/comments', async (req, res, next) => {
  try {
    const seed = typeof req.query.seed === 'string' ? req.query.seed : '';
    const comments = await Articles.listComments({
      articleId: req.params.id,
      seed,
      cursor: parseCursor(req),
      viewerId: req.user?.id,
    });
    res.json({ comments });
  } catch (error) {
    next(error);
  }
});

socialRouter.post('/articles/:id/comments', requireAccount, async (req, res, next) => {
  try {
    const comment = await Articles.createComment({ articleId: req.params.id, authorId: req.user.id, body: req.body?.body });
    res.json({ comment });
  } catch (error) {
    next(error);
  }
});

// Guest-ok too — same reasoning as article likes above.
socialRouter.post('/comments/:id/like', async (req, res, next) => {
  try {
    const owner = await ensureOwner(req, res);
    res.json(await Articles.likeComment({ userId: owner.id, commentId: req.params.id }));
  } catch (error) {
    next(error);
  }
});

socialRouter.delete('/comments/:id/like', async (req, res, next) => {
  try {
    const owner = await ensureOwner(req, res);
    res.json(await Articles.unlikeComment({ userId: owner.id, commentId: req.params.id }));
  } catch (error) {
    next(error);
  }
});

// ---- Discover / Following / Search ----

socialRouter.get('/discover', async (req, res, next) => {
  try {
    const seed = typeof req.query.seed === 'string' ? req.query.seed : '';
    const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;
    const articles = await Articles.discoverFeed({ seed, cursor: parseCursor(req), sort });
    res.json({ articles });
  } catch (error) {
    next(error);
  }
});

socialRouter.get('/discover/following', requireAccount, async (req, res, next) => {
  try {
    const articles = await Articles.followingFeed({ userId: req.user.id, cursor: parseCursor(req) });
    res.json({ articles });
  } catch (error) {
    next(error);
  }
});

socialRouter.get('/discover/search', async (req, res, next) => {
  try {
    const articles = await Articles.searchArticles({ query: req.query.q, cursor: parseCursor(req) });
    res.json({ articles });
  } catch (error) {
    next(error);
  }
});
