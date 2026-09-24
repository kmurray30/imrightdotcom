import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { ArticleBody } from '../components/article/ArticleBody.jsx';
import { VisibilityToggle } from '../components/article/VisibilityToggle.jsx';
import { ShareButton } from '../components/article/ShareButton.jsx';
import { DeleteArticleModal } from '../components/article/DeleteArticleModal.jsx';
import { LikeButton } from '../components/social/LikeButton.jsx';
import { BookmarkButton } from '../components/social/BookmarkButton.jsx';
import { CommentSection } from '../components/social/CommentSection.jsx';

export function ArticlePage() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [article, setArticle] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setArticle(null);
    setNotFound(false);
    api
      .get(`/api/articles/${id}`)
      .then((data) => {
        if (!cancelled) setArticle(data.article);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Recorded once the article's loaded, keyed off the same anonymous visitor
  // cookie every page already sets — deduped server-side, so reopening this
  // same page later in the same browser doesn't recount (see the backend's
  // articleViews docstring). Not gated on login/guest status: a view counts
  // for anyone, including a visitor with no account/guest identity at all.
  useEffect(() => {
    if (!article) return undefined;
    let cancelled = false;
    api
      .post(`/api/articles/${article.id}/view`)
      .then((data) => {
        if (!cancelled && typeof data?.viewCount === 'number') {
          setArticle((a) => (a ? { ...a, viewCount: data.viewCount } : a));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.id]);

  if (notFound) return <p className="empty-state">Article not found.</p>;
  if (!article) return <p className="empty-state">Loading…</p>;

  const isOwner = user?.id === article.ownerUserId;

  return (
    <div className="article-page">
      <div className="article-card-surface">
        <div className="article-meta">
          <p className="article-byline">
            by{' '}
            {isOwner ? (
              'you'
            ) : article.ownerUsername ? (
              <Link to={`/u/${article.ownerUsername}`}>{article.ownerDisplayName}</Link>
            ) : (
              article.ownerDisplayName || 'Anonymous'
            )}
          </p>
          <div className="article-stats">
            <span>♥ {article.likeCount}</span>
            <span>👁 {article.viewCount}</span>
            <span>💬 {article.commentCount}</span>
            <span>🔖 {article.bookmarkCount}</span>
          </div>
        </div>
        <div className="article-actions">
          {isOwner && (
            <VisibilityToggle
              articleId={article.id}
              initialIsPublic={article.isPublic}
              onChange={(isPublic) => setArticle((a) => ({ ...a, isPublic }))}
            />
          )}
          <LikeButton articleId={article.id} initialLiked={article.likedByViewer} initialCount={article.likeCount} />
          <BookmarkButton articleId={article.id} />
          <ShareButton />
        </div>
        <ArticleBody articleId={article.id} articleData={article.articleData} />
        {isOwner && (
          <button type="button" className="delete-article-trigger" onClick={() => setShowDeleteModal(true)}>
            Delete this article
          </button>
        )}
      </div>
      <CommentSection articleId={article.id} />
      {showDeleteModal && (
        <DeleteArticleModal
          article={article}
          onClose={() => setShowDeleteModal(false)}
          onDeleted={() => navigate('/history')}
        />
      )}
    </div>
  );
}
