import { Link } from 'react-router-dom';

function slugForUrl(claimText) {
  return (claimText || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 60);
}

export function ArticleCard({ article }) {
  const headline = article.articleData?.headline || article.claimText;
  const slug = slugForUrl(article.claimText);
  return (
    <Link to={`/a/${article.id}${slug ? `/${slug}` : ''}`} className="article-card">
      <h3>{headline}</h3>
      <p className="article-card-byline">by {article.displayName || 'Anonymous'}</p>
      <div className="article-card-stats">
        <span>♥ {article.likeCount}</span>
        <span>💬 {article.commentCount}</span>
        <span>🔖 {article.bookmarkCount}</span>
      </div>
    </Link>
  );
}
