import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { FollowButton } from '../components/social/FollowButton.jsx';
import { ArticleCard } from '../components/discover/ArticleCard.jsx';

export function ProfilePage() {
  const { username } = useParams();
  const [profileUser, setProfileUser] = useState(null);
  const [articles, setArticles] = useState([]);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNotFound(false);
    api
      .get(`/api/users/by-username/${encodeURIComponent(username)}`)
      .then(async ({ user }) => {
        if (cancelled) return;
        setProfileUser(user);
        const data = await api.get(`/api/users/${user.id}/articles`);
        if (!cancelled) setArticles(data.articles ?? []);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (notFound) return <p className="empty-state">No such user.</p>;
  if (!profileUser) return <p className="empty-state">Loading…</p>;

  return (
    <div className="profile-page">
      <div className="profile-header">
        <h1>{profileUser.displayName}</h1>
        <p className="profile-username">@{profileUser.username}</p>
        <FollowButton userId={profileUser.id} />
      </div>
      <div className="article-grid">
        {articles.map((article) => (
          <ArticleCard key={article.id} article={{ ...article, displayName: profileUser.displayName }} />
        ))}
      </div>
      {articles.length === 0 && <p className="empty-state">No public articles yet.</p>}
    </div>
  );
}
