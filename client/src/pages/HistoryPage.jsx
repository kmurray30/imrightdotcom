import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { DeleteArticleModal } from '../components/article/DeleteArticleModal.jsx';

/** Guest-ok: a guest's own history is visible to them regardless of
 * visibility, same as a real account's (requirement 2). */
export function HistoryPage() {
  const [articles, setArticles] = useState(null);
  const [deletingArticle, setDeletingArticle] = useState(null);

  useEffect(() => {
    api
      .get('/api/me/articles')
      .then((data) => setArticles(data.articles ?? []))
      .catch(() => setArticles([]));
  }, []);

  if (articles === null) return <p className="empty-state">Loading…</p>;

  return (
    <div className="history-page">
      <h1>Your history</h1>
      <p className="page-subtitle">Every article you've generated, whether public or private.</p>
      {articles.length === 0 && <p className="empty-state">Nothing yet — try the idea input on the home page.</p>}
      <ul className="history-list">
        {articles.map((article) => (
          <li key={article.id}>
            <Link to={`/a/${article.id}`}>{article.articleData?.headline || article.claimText}</Link>
            <span className="history-list-right">
              <span className={`visibility-badge ${article.isPublic ? 'is-public' : 'is-private'}`}>
                {article.isPublic ? 'Public' : 'Private'}
              </span>
              <button type="button" className="delete-article-trigger" onClick={() => setDeletingArticle(article)}>
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {deletingArticle && (
        <DeleteArticleModal
          article={deletingArticle}
          onClose={() => setDeletingArticle(null)}
          onDeleted={() => {
            setArticles((prev) => prev.filter((a) => a.id !== deletingArticle.id));
            setDeletingArticle(null);
          }}
        />
      )}
    </div>
  );
}
