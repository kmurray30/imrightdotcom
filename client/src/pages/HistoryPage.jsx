import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

/** Guest-ok: a guest's own history is visible to them regardless of
 * visibility, same as a real account's (requirement 2). */
export function HistoryPage() {
  const [articles, setArticles] = useState(null);

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
            <span className={`visibility-badge ${article.isPublic ? 'is-public' : 'is-private'}`}>
              {article.isPublic ? 'Public' : 'Private'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
