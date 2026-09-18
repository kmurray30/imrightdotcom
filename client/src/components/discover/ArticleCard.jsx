import { Link } from 'react-router-dom';
import { imageUrl } from '../article/ArticleImages.jsx';

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
  const heroFilename = article.articleData?.images?.hero;
  const imageSlug = article.articleData?.slug;

  return (
    <Link to={`/a/${article.id}${slug ? `/${slug}` : ''}`} className="article-card">
      {heroFilename && imageSlug && (
        <img className="article-card-thumbnail" src={imageUrl(imageSlug, heroFilename)} alt="" loading="lazy" />
      )}
      <h3>{headline}</h3>
      <p className="article-card-byline">by {article.displayName || 'Anonymous'}</p>
      <div className="article-card-stats">
        <span>♥ {article.likeCount}</span>
        <span>💬 {article.commentCount}</span>
      </div>
    </Link>
  );
}
