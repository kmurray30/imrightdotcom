/** Images live at a stable URL namespace regardless of where they physically
 * resolve on disk (dev vs. prod volume) — see serve-site.js's /article-images
 * mount and the plan's image durability fix. Exported so ArticleCard can
 * build the same URL for its Discover-feed thumbnail. */
export function imageUrl(slug, filename) {
  return `/article-images/${slug}/${filename}`;
}

export function HeroImage({ slug, images }) {
  const filename = images?.hero;
  if (!filename) return null;
  return <img className="article-hero-image" src={imageUrl(slug, filename)} alt="" loading="eager" />;
}

export function SectionImage({ slug, images, sectionIndex }) {
  const filename = images?.[`section-${sectionIndex}`];
  if (!filename) return null;
  return <img className="article-section-image" src={imageUrl(slug, filename)} alt="" loading="lazy" />;
}
